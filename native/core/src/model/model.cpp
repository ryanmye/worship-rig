#include "model/model.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "bridge/json_out.h"
#include "graph/builtin_units.h"
#include "mix/master_chain.h"
#include "mix/slot_channel.h"
#include "params/params.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig {
namespace {

std::size_t idx(UnitSlot s) {
  return static_cast<std::size_t>(s);
}

/** Global units the skeleton attaches at audio start / first commit when their kind is registered. */
struct GlobalUnit {
  UnitSlot slot;
  const char *kind;
};
constexpr GlobalUnit kGlobals[] = {
    {UnitSlot::Reverb, "reverb"}, {UnitSlot::Delay, "delay"}, {UnitSlot::Chorus, "chorus"},
    {UnitSlot::Lofi, "lofi"},     {UnitSlot::MasterChain, "master"}, {UnitSlot::Click, "click"},
    {UnitSlot::Drone, "drone"},   {UnitSlot::Meter, "meter"},  {UnitSlot::Recorder, "rec"},
};

}  // namespace

Model::Model(CommandSink &sink, const UnitEnv &env) : sink_(sink), env_(env) {
  const Registry &reg = Registry::global();
  for (const auto &e : reg.services()) {
    if (service(e.name)) continue;
    const Registry::ServiceEntry *best = reg.service(e.name);
    if (Service *s = best->factory(*this)) services_.emplace_back(e.name, std::unique_ptr<Service>(s));
  }
  if (auto *cache = service<CacheService>()) env_.cache = cache->bufferCache();
}

Model::~Model() = default;

Service *Model::service(std::string_view name) const {
  for (const auto &s : services_)
    if (s.first == name) return s.second.get();
  return nullptr;
}

void Model::forEachService(const std::function<void(Service &)> &fn) const {
  for (const auto &s : services_) fn(*s.second);
}

// ---- clock and command helpers ------------------------------------------------------------------------------------

double Model::now() const {
  return sink_.timeBase().time();
}

std::int64_t Model::frameFor(double when) const {
  if (!(when >= 0.0)) return kFrameNow;
  const TimeBase tb = sink_.timeBase();
  const std::int64_t f = std::llround(when * tb.sampleRate);
  return f <= tb.frame ? kFrameNow : f;
}

double Model::timeFor(double when) const {
  const std::int64_t f = frameFor(when);
  return f == kFrameNow ? now() : static_cast<double>(f) / sink_.timeBase().sampleRate;
}

bool Model::send(Command c) {
  if (!sink_.send(c)) {
    ++stats_.droppedCommands;
    return false;
  }
  return true;
}

void Model::warn(std::string_view message, std::string_view code) {
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "warn").kv("message", std::string(message)).kv("code", std::string(code)).end();
  emit(j.take());
}

bool Model::attachUnit(UnitSlot slot, std::string_view kind, double when, int channel) {
  const Registry::UnitEntry *e = Registry::global().unit(kind);
  if (!e) return false;
  UnitSpec spec;
  spec.slot = slot;
  spec.channel = channel;
  spec.patch = &active_;
  spec.song = &song_;
  if (kind.substr(0, 5) == "inst.") spec.instSeq = ++instSeq_;
  env_.sampleRate = sink_.timeBase().sampleRate;
  Unit *u = e->factory(env_, spec);
  if (!u) return false;
  Command c{};
  c.op = Op::AttachUnit;
  c.target = static_cast<std::uint32_t>(slot);
  c.frame = frameFor(when);
  c.p.ptr = u;
  if (!send(c)) {
    delete u;
    return false;
  }
  Attached &a = attached_[idx(slot)];
  a.kind = std::string(kind);
  a.module = e->priority > kBuiltinPriority;
  for (auto it = tracked_.begin(); it != tracked_.end();)  // a new unit starts from its own defaults
    it = paramUnit(it->first) == slot ? tracked_.erase(it) : std::next(it);
  ++stats_.unitsAttached;
  return true;
}

void Model::detachUnit(UnitSlot slot, double when) {
  Attached &a = attached_[idx(slot)];
  if (a.kind.empty()) return;
  Command c{};
  c.op = Op::DetachUnit;
  c.target = static_cast<std::uint32_t>(slot);
  c.frame = frameFor(when);
  send(c);
  a = Attached{};
}

bool Model::sendUnitOp(UnitSlot slot, Command c, double when) {
  c.target = static_cast<std::uint32_t>(slot);
  c.frame = frameFor(when);
  return send(c);
}

bool Model::sendOwned(UnitSlot slot, Op op, Owned *payload, double when, std::uint32_t aux) {
  Command c{};
  c.op = op;
  c.sub = kSubOwnedPayload;
  c.aux = aux;
  c.p.ptr = payload;
  if (sendUnitOp(slot, c, when)) return true;
  delete payload;
  return false;
}

void Model::moveParam(UnitSlot slot, std::uint32_t index, double v, double when, double glide) {
  const std::uint32_t target = paramTarget(slot, index);
  const double t = timeFor(when);
  auto emitCmd = [&](Op op, double a, double b, double c) {
    Command cmd{};
    cmd.op = op;
    cmd.frame = kFrameNow;
    cmd.target = target;
    cmd.f.a = a;
    cmd.f.b = b;
    cmd.f.c = c;
    send(cmd);
  };
  auto it = tracked_.find(target);
  const double from = it != tracked_.end() ? it->second : v;
  if (glide > 0.0) {  // trackedMove: linear glide from the tracked value
    emitCmd(Op::ParamCancelHold, 0, t, 0);
    emitCmd(Op::ParamSet, from, t, 0);
    emitCmd(Op::ParamLinear, v, t + glide, 0);
  } else {  // rampTo: cancelAndHold + setTarget(tau 15 ms) + pinned end at t + 12 tau
    emitCmd(Op::ParamCancelHold, 0, t, 0);
    emitCmd(Op::ParamTarget, v, t, wa::kTau);
    emitCmd(Op::ParamSet, v, t + wa::kRampSettleTc * wa::kTau, 0);
  }
  tracked_[target] = v;
}

void Model::setParamAt(UnitSlot slot, std::uint32_t index, double v, double when) {
  Command c{};
  c.op = Op::ParamSet;
  c.frame = frameFor(when);
  c.target = paramTarget(slot, index);
  c.f.a = v;
  c.f.b = timeFor(when);
  send(c);
  tracked_[c.target] = v;
}

// ---- lifecycle ----------------------------------------------------------------------------------------------------

void Model::ensureGlobalUnits(double when) {
  const bool noLofi = env_.config && (env_.config->flags & RIG_FLAG_NO_LOFI);
  for (const GlobalUnit &g : kGlobals) {
    if (!attached_[idx(g.slot)].kind.empty()) continue;
    if (noLofi && g.slot == UnitSlot::Lofi) continue;
    attachUnit(g.slot, g.kind, when);
  }
}

void Model::audioStarted(double when) {
  ensureGlobalUnits(when);
}

bool Model::sleep(double) {
  return false;
}
bool Model::wake(double) {
  return true;
}
const char *Model::sleepState() const {
  return "awake";
}
std::string Model::sleepBlockersJson() const {
  return "[]";
}
bool Model::setLowResource(bool on) {
  lowResource_ = on;
  forEachService([&](Service &s) { s.onMemoryPressure(on ? 1 : 0); });
  return lowResource_;
}

// ---- song switching -----------------------------------------------------------------------------------------------

std::uint32_t Model::prepare(PatchSpec &&patch) {
  ++stats_.prepares;
  const std::uint32_t token = nextToken_++;
  plans_[token] = std::move(patch);
  while (plans_.size() > 8) plans_.erase(plans_.begin());  // superseded plans are dropped
  return token;
}

bool Model::commit(std::uint32_t token, double when) {
  auto it = plans_.find(token);
  if (it == plans_.end()) return false;
  active_ = it->second;
  ++stats_.commits;
  committedAny_ = true;
  // Skeleton policy (T13 replaces: reuse, retire, crossfades): every channel gets a fresh instrument + strip.
  for (std::size_t i = 0; i < kChannels; ++i) {
    const SlotPatch &sp = active_.slots[i];
    const int ch = static_cast<int>(i);
    if (!sp.present || !attachUnit(instSlot(i), "inst." + sp.instType, when, ch)) detachUnit(instSlot(i), when);
    if (!attachUnit(stripSlot(i), kKindStrip, when, ch)) continue;
    // Fresh channel: the fader is *set* to the slot gain at the commit instant (contract 3.1), not ramped.
    setParamAt(stripSlot(i), kStripFader, sp.present ? sp.gain : 0.0, when);
    setParamAt(stripSlot(i), kStripPan, sp.pan, when);
  }
  ensureGlobalUnits(when);
  forEachService([&](Service &s) { s.onCommit(active_, when); });
  return true;
}

std::string Model::preload(const yyjson_val *patches, std::string_view pin) {
  auto *s = service<CacheService>();
  return s ? s->preload(patches, pin) : std::string();
}
std::string Model::estimatePreloadMB(const yyjson_val *patches) {
  auto *s = service<CacheService>();
  return s ? s->estimate(patches) : std::string();
}
bool Model::retainReverb(const yyjson_val *patches) {
  auto *s = service<ReverbService>();
  return s ? s->retain(patches) : false;
}
bool Model::reloadManifests() {
  auto *s = service<CacheService>();
  return s ? s->reloadManifests() : false;
}
std::string Model::listInstruments() {
  auto *s = service<InstrumentService>();
  return s ? s->listJson() : std::string();
}
std::string Model::sampleStatus(const yyjson_val *patches) {
  auto *s = service<CacheService>();
  return s ? s->sampleStatus(patches) : std::string();
}

// ---- parameters ---------------------------------------------------------------------------------------------------

bool Model::builtinSet(const ParamRow &row, std::string_view, int slot, double v, double glide, double when) {
  const std::string_view rp(row.path);
  if (rp == "slots.<i>.gain") {
    if (attached_[idx(stripSlot(slot))].kind.empty()) return true;  // stored; applied at the next commit
    moveParam(stripSlot(slot), kStripFader, v, when, glide);
    return true;
  }
  if (rp == "slots.<i>.pan") {
    if (attached_[idx(stripSlot(slot))].kind.empty()) return true;
    moveParam(stripSlot(slot), kStripPan, v, when, 0.0);
    return true;
  }
  if (rp == "master.volume") {
    moveParam(UnitSlot::MasterChain, kMasterVolume, v, when, glide);
    return true;
  }
  if (rp.rfind("slots.<i>.eq.", 0) == 0) {
    SlotEqSpec &eq = active_.slots[slot].spec.eq;
    const std::string_view f = rp.substr(13);
    if (f == "cutHz")
      eq.cutHz = v;
    else if (f == "hiCutHz")
      eq.hiCutHz = v;
    else if (f.size() > 3 && f[0] == 'b' && f[1] >= '1' && f[1] <= '8' && f[2] == '.') {
      EqBand &b = eq.bands[f[1] - '1'];
      const std::string_view k = f.substr(3);
      if (k == "on")
        b.on = v != 0.0;
      else if (k == "type")
        b.type = static_cast<int>(v);
      else if (k == "hz")
        b.hz = v;
      else if (k == "db")
        b.db = v;
      else if (k == "q")
        b.q = v;
    } else {
      return false;  // legacy low/mid/high rows: T02
    }
    if (!committedAny_ || attached_[idx(stripSlot(slot))].kind.empty()) return true;
    auto *p = new SlotEqPayload();
    p->spec = eq;
    sendOwned(stripSlot(slot), opOf(StripOp::SetEq), p, when);  // step change; T02: glide / chain crossfade
    return true;
  }
  return false;
}

SetResult Model::set(std::string_view path, const yyjson_val *value, double glide, double when) {
  int slot = -1;
  bool dynamic = false;
  const ParamRow *row = findParam(path, &slot, &dynamic);
  SetResult r;
  const Registry &reg = Registry::global();
  if (dynamic) {
    const Registry::SetEntry *h = reg.setHandler("slots.<i>.params.");
    double v = 0;
    const yyjson_val *mv = value;
    if (mv && yyjson_is_num(const_cast<yyjson_val *>(mv))) v = yyjson_get_num(const_cast<yyjson_val *>(mv));
    else if (mv && yyjson_is_bool(const_cast<yyjson_val *>(mv))) v = yyjson_get_bool(const_cast<yyjson_val *>(mv));
    if (!h || !h->handler(*this, SetRequest{nullptr, path, slot, v, glide, when})) {
      r.status = SetResult::NotApplied;
      r.message = h ? "instrument param not applied" : "instrument params are not implemented yet";
    }
    return r;
  }
  if (!row) {
    r.status = SetResult::Unknown;
    r.message = "unknown param " + std::string(path);
    return r;
  }
  double v;
  if (!jsonToParamValue(*row, value, v)) {
    r.status = SetResult::Bad;
    r.message = "bad value for " + std::string(path);
    return r;
  }
  ++stats_.sets;
  storeRow(active_, row->path, slot, v);  // the patch always holds the latest value (also before start/commit)
  bool applied;
  if (const Registry::SetEntry *h = reg.setHandler(row->path))
    applied = h->handler(*this, SetRequest{row, path, slot, v, glide, when});
  else
    applied = builtinSet(*row, path, slot, v, glide, when);
  if (!applied) {
    r.status = SetResult::NotApplied;
    r.message = "param is validated but its engine behaviour is not implemented yet";
  }
  return r;
}

void Model::setTranspose(int semis) {
  song_.transpose = std::clamp(semis, -48, 48);
  forEachService([&](Service &s) { s.onSongState(song_); });
}
void Model::setRouting(const yyjson_val *, double) {}  // T14
void Model::setTempo(double bpm) {
  song_.tempo = bpm > 0 ? bpm : 0;
  forEachService([&](Service &s) { s.onSongState(song_); });
}
void Model::setTimeSig(std::string_view sig, bool) {
  int n = 4, d = 4;
  if (sig == "3/4") n = 3;
  else if (sig == "2/4") n = 2;
  else if (sig == "5/4") n = 5;
  else if (sig == "6/8") n = 6, d = 8;
  else if (sig == "12/8") n = 12, d = 8;
  song_.sigNum = n;
  song_.sigDen = d;
  forEachService([&](Service &s) { s.onSongState(song_); });
}
void Model::setKeyContext(int pc, bool minor) {
  song_.keyPc = ((pc % 12) + 12) % 12;
  song_.keyMinor = minor;
  forEachService([&](Service &s) { s.onSongState(song_); });
}
void Model::setMono(bool on) {
  song_.mono = on;
  forEachService([&](Service &s) { s.onSongState(song_); });
}
bool Model::eqAudition(int slot, std::string_view mode, double when) {
  if (slot < 0 || slot > 3 || !attachedIsModule(stripSlot(static_cast<std::size_t>(slot)))) return false;
  Command c{};
  c.op = opOf(StripOp::EqAudition);
  c.aux = mode == "bypass" ? 1u : 0u;
  return sendUnitOp(stripSlot(static_cast<std::size_t>(slot)), c, when);
}
bool Model::droneSetKey(int pc, bool minor, double fade, double when) {
  auto *s = service<DroneService>();
  return s ? s->setKey(pc, minor, fade, when) : false;
}
void Model::droneConfigure(const yyjson_val *cfg, double when) {
  if (auto *s = service<DroneService>()) s->configure(cfg, when);
}
int Model::droneAttachFiles(const yyjson_val *files) {
  auto *s = service<DroneService>();
  return s ? s->attachFiles(files) : -1;
}

// ---- perform (skeleton: every note to every slot; T14 owns splits, pedal, mono, wheels) ---------------------------

bool Model::noteOn(int note, int vel, double when, const yyjson_val *) {
  Command c{};
  c.op = Op::NoteOn;
  c.frame = frameFor(when);
  c.target = kAllSlots;
  c.aux = static_cast<std::uint32_t>(note & 0xff) | (static_cast<std::uint32_t>(std::clamp(vel, 0, 127)) << 8);
  ++stats_.notesOn;
  return send(c);
}

bool Model::noteOff(int note, double when) {
  Command c{};
  c.op = Op::NoteOff;
  c.frame = frameFor(when);
  c.target = kAllSlots;
  c.aux = static_cast<std::uint32_t>(note & 0xff);
  ++stats_.notesOff;
  return send(c);
}

bool Model::sustain(bool, double) {
  return false;  // T14
}
void Model::pitchBend(double, double) {}
bool Model::setWheel(std::string_view, double, double, double) {
  return false;
}
bool Model::swell(int, double) {
  return false;
}

void Model::allNotesOff(double when) {
  Command c{};
  c.op = Op::Panic;  // T00 behaviour kept (hard kill); T14: AllNotesOff 30 ms fade + pedal/swell/bend/delay rules
  c.frame = frameFor(when);
  c.target = kAllSlots;
  send(c);
}

void Model::fadeOutAll(double, double) {}
void Model::noteInput(double) {}
std::string Model::wheelValuesJson() const {
  return R"({"mod":0,"expr":1,"vol":1,"owner":"hw","swelling":false})";
}
std::string Model::runtimeStateJson() const {
  return R"({"wheel":{"mod":0,"expr":1,"vol":1},"modOwner":"hw","faded":false})";
}

// ---- click, meters, recording, MIDI -------------------------------------------------------------------------------

std::string Model::clickStart(int countIn, bool quietAfter, double when) {
  auto *s = service<ClickService>();
  return s ? s->start(countIn, quietAfter, when) : std::string();
}
bool Model::clickStop(double when) {
  auto *s = service<ClickService>();
  return s ? s->stop(when) : false;
}
std::string Model::setClick(const yyjson_val *cfg, double when) {
  auto *s = service<ClickService>();
  return s ? s->configure(cfg, when) : std::string();
}
std::string Model::clickStateJson() {
  auto *s = service<ClickService>();
  return s ? s->stateJson() : std::string();
}
void Model::setClockPort(const char *portId) {
  if (auto *s = service<ClickService>()) s->setClockPort(portId);
}
void Model::subscribeMeters(const yyjson_val *meters) {
  if (auto *s = service<MeterService>()) s->subscribe(meters);
}
std::string Model::recStart(const yyjson_val *args) {
  auto *s = service<RecService>();
  return s ? s->start(args) : std::string();
}
std::string Model::recStop() {
  auto *s = service<RecService>();
  return s ? s->stop() : std::string();
}
std::string Model::midiOp(const yyjson_val *msg) {
  auto *s = service<MidiService>();
  return s ? s->op(msg) : std::string();
}
void Model::midiBytes(std::uint16_t port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs) {
  if (auto *s = service<MidiService>()) s->onBytes(port, bytes, len, hostTimeNs);
}
bool Model::midiPorts(const char *json, std::size_t len) {
  auto *s = service<MidiService>();
  return s ? s->ports(json, len) : false;
}

// ---- host notifications -------------------------------------------------------------------------------------------

void Model::memoryPressure(int level) {
  ++stats_.memoryWarnings;
  forEachService([&](Service &s) { s.onMemoryPressure(level); });
  warn("memory pressure (level " + std::to_string(level) + "): unpinned buffers and idle units trimmed", "memory");
}

void Model::setPaths(const EnginePaths &p) {
  if (!p.appDir.empty()) paths_.appDir = p.appDir;
  if (!p.userManifest.empty()) paths_.userManifest = p.userManifest;
  if (!p.padsDir.empty()) paths_.padsDir = p.padsDir;
  if (!p.recordingsDir.empty()) paths_.recordingsDir = p.recordingsDir;
  forEachService([&](Service &s) { s.onPaths(paths_); });
}

void Model::onAudioEvent(const AudioEvent &e) {
  switch (e.kind) {
    case EventKind::Garbage:
      if (e.aux == static_cast<std::uint32_t>(GarbageKind::Unit)) ++stats_.unitsFreed;
      freeGarbage(e);
      return;  // the pointer is gone: services never see Garbage events
    case EventKind::VoiceEnded:
      ++stats_.voicesEnded;
      break;
    case EventKind::RateChanged:
      ++stats_.rateChanges;
      env_.sampleRate = e.f.a;
      forEachService([&](Service &s) { s.onRateChanged(e.f.a); });
      break;
    default:
      break;
  }
  forEachService([&](Service &s) { s.onAudioEvent(e); });
}

std::string Model::stateJson() const {
  JsonOut j;
  j.begin().kvBool("committed", committedAny_);
  j.key("slots").beginArray();
  for (const auto &s : active_.slots) {
    j.begin()
        .kvBool("present", s.present)
        .kv("type", s.instType)
        .kv("id", s.instId)
        .kv("gain", s.gain)
        .kv("pan", s.pan);
    j.end();
  }
  j.endArray();
  j.kv("transpose", song_.transpose).kv("tempo", song_.tempo).kvBool("mono", song_.mono);
  j.end();
  return j.take();
}

std::string Model::statsJson() const {
  std::string out = "\"unitsAttached\":" + std::to_string(stats_.unitsAttached) +
                    ",\"unitsFreed\":" + std::to_string(stats_.unitsFreed) +
                    ",\"rateChanges\":" + std::to_string(stats_.rateChanges) +
                    ",\"memoryWarnings\":" + std::to_string(stats_.memoryWarnings);
  forEachService([&](Service &s) {
    const std::string f = s.statsFields();
    if (!f.empty()) out += "," + f;
  });
  return out;
}

}  // namespace rig
