#include "model/model.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <vector>

#include "bridge/json_out.h"
#include "graph/builtin_units.h"
#include "inst/voice_alloc.h"
#include "mix/master_chain.h"
#include "mix/slot_channel.h"
#include "model/song.h"
#include "params/params.h"
#include "samples/cache_service.h"
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
  sg_ = std::make_unique<SongGraph>(*this);  // INTERFACE-CHANGE(T13)
  sg_->setDisposeHook([this](std::uint32_t id) { performChannelDisposed(*this, id); });
  const Registry &reg = Registry::global();
  for (const auto &e : reg.services()) {
    if (service(e.name)) continue;
    const Registry::ServiceEntry *best = reg.service(e.name);
    if (Service *s = best->factory(*this)) services_.emplace_back(e.name, std::unique_ptr<Service>(s));
  }
  if (auto *cache = service<CacheService>()) env_.cache = cache->bufferCache();
}

Model::~Model() {
  performForget(*this);  // T12 O5
  sg_.reset();           // the plan's prebuilt units die while the services still exist
}

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
  // T00c / T08 #1: a strip attached straight into a retiring channel meters its origin slot
  if (isRetireStripSlot(slot) && channel >= 0 && channel < static_cast<int>(kChannels))
    c.aux = static_cast<std::uint32_t>(channel + 1);
  if (!send(c)) {
    delete u;
    return false;
  }
  if (kind.substr(0, 5) == "inst." && (isInstSlot(slot) || isRetireInstSlot(slot))) {
    Command vc{};  // INTERFACE-CHANGE(T00c) D1: the cap reaches the instrument before any note (same frame, FIFO)
    vc.op = Op::VoiceCap;
    vc.target = static_cast<std::uint32_t>(slot);
    vc.frame = c.frame;
    vc.aux = polyphony_;
    send(vc);
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

bool Model::moveUnit(UnitSlot from, UnitSlot to, double when) {  // INTERFACE-CHANGE(T00c) D3
  if (from == to || idx(from) >= kUnitSlots || idx(to) >= kUnitSlots || attached_[idx(from)].kind.empty())
    return false;
  Command c{};
  c.op = Op::MoveUnit;
  c.target = static_cast<std::uint32_t>(to);
  c.aux = static_cast<std::uint32_t>(from);
  c.frame = frameFor(when);
  if (!send(c)) return false;
  attached_[idx(to)] = std::move(attached_[idx(from)]);
  attached_[idx(from)] = Attached{};
  for (auto it = tracked_.begin(); it != tracked_.end();) {  // tracked values follow the unit
    if (paramUnit(it->first) == to) {
      it = tracked_.erase(it);
    } else {
      ++it;
    }
  }
  std::map<std::uint32_t, double> moved;
  for (auto it = tracked_.begin(); it != tracked_.end();) {
    if (paramUnit(it->first) == from) {
      moved[paramTarget(to, paramIndex(it->first))] = it->second;
      it = tracked_.erase(it);
    } else {
      ++it;
    }
  }
  tracked_.insert(moved.begin(), moved.end());
  return true;
}

bool Model::setPolyphony(unsigned cap) {  // INTERFACE-CHANGE(T00c) D1
  if (cap != 32 && cap != 64 && cap != 128) return false;
  polyphony_ = cap;
  Command c{};
  c.op = Op::VoiceCap;
  c.target = kAllSlots;  // slots + retiring channels (graph routing of the per-instrument core ops)
  c.frame = kFrameNow;
  c.aux = cap;
  send(c);
  return true;
}

bool Model::setVoiceLimit(int limit) {  // INTERFACE-CHANGE(D4)
  if (limit != kVoiceLimitAuto && limit != 0 && limit != 128 && limit != 256 && limit != 512) return false;
  voiceLimit_ = limit;
  sink_.setVoiceLimit(voiceLimitEffective());
  return true;
}

std::uint32_t Model::voiceLimitEffective() const {  // INTERFACE-CHANGE(D4)
  if (voiceLimit_ != kVoiceLimitAuto) return static_cast<std::uint32_t>(voiceLimit_);
  return inst::autoVoiceLimit(env_.config && env_.config->profile == RIG_PROFILE_IPAD);
}

void Model::voiceLimitJson(JsonOut &j) const {  // INTERFACE-CHANGE(D4)
  if (voiceLimit_ == kVoiceLimitAuto) j.kv("voiceLimit", "auto");
  else j.kv("voiceLimit", voiceLimit_);
  j.kv("voiceLimitEffective", voiceLimitEffective());
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
  // audio.js setLowResource (contract 1.1): on = pins of the current song only (the old pins remembered), unpinned
  // buffers trimmed, idle reverb units dropped (_trimReverbUnits = the pool's level-1 trim), slot taps released (the
  // meter tick reads lowResource()); off = pins restored + the current song's. The drone freeze is T16's.
  if (on == lowResource_) return on;
  lowResource_ = on;
  if (auto *cs = dynamic_cast<samples::CacheServiceImpl *>(service<CacheService>())) cs->setLowResource(on);
  if (on)
    if (Service *rv = service(ReverbService::kName)) rv->onMemoryPressure(1);
  return on;
}

// ---- song switching -----------------------------------------------------------------------------------------------

std::uint32_t Model::prepare(PatchSpec &&patch) {
  ++stats_.prepares;
  return sg_->prepare(std::move(patch), nextToken_++);  // T13: model/song.cpp
}

bool Model::commit(std::uint32_t token, double when) {
  return sg_->commit(token, when);  // T13: model/song.cpp (stats, global units and the services' onCommit inside)
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

bool Model::builtinSet(const ParamRow &row, std::string_view, int, double v, double glide, double when) {
  // rows without a module handler outside slots.<i>.* (the slot rows are the SongGraph's)
  if (std::string_view(row.path) == "master.volume") {  // T03 registers `master.`; this is the fallback without it
    moveParam(UnitSlot::MasterChain, kMasterVolume, v, when, glide);
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
    if (!h) {
      r.status = SetResult::NotApplied;
      r.message = "instrument params are not implemented yet";
      return r;
    }
    // T13: audio.js _setSlotParam: false for an empty slot; else coalesced (10 ms per path) into the handler
    if (slot < 0 || slot >= kMaxSlots || !slotUsed(active_.slots[slot])) {
      r.status = SetResult::NotApplied;
      r.message = "slot is empty";
      return r;
    }
    if (!sg_->coalesce(path, when, [this, h, p = std::string(path), slot, v, glide](double tt) {
          h->handler(*this, SetRequest{nullptr, p, slot, v, glide, tt});
        })) {
      r.status = SetResult::NotApplied;
      r.message = "instrument param not applied";
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
  const bool slotRow = std::string_view(row->path).rfind("slots.<i>.", 0) == 0;
  if (slotRow && (slot < 0 || slot >= kMaxSlots || !slotUsed(active_.slots[slot]))) {
    r.status = SetResult::NotApplied;  // T13: audio.js _setSlotParam `if (!cfg) return false` (nothing stored)
    r.message = "slot is empty";
    return r;
  }
  const double prevGain = slotRow ? active_.slots[slot].gain : 0.0;
  storeRow(active_, row->path, slot, v);  // the patch always holds the latest value (also before start/commit)
  bool applied;
  if (const Registry::SetEntry *h = reg.setHandler(row->path))
    applied = h->handler(*this, SetRequest{row, path, slot, v, glide, when});
  else if (slotRow)
    applied = sg_->setSlotRow(*row, slot, v, glide, when, prevGain);  // T13: model/song.cpp
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
void Model::setRouting(const yyjson_val *routing, double when) {
  sg_->setRouting(routing, when);  // T13: state + slot wheel factors; bend neutralising and pedal swell: T14
}
void Model::setTempo(double bpm) {
  song_.tempo = bpm > 0 ? bpm : 0;
  forEachService([&](Service &s) { s.onSongState(song_); });
}
void Model::setTimeSig(std::string_view sig, bool newBar) {
  int n = 4, d = 4;
  if (sig == "3/4") n = 3;
  else if (sig == "2/4") n = 2;
  else if (sig == "5/4") n = 5;
  else if (sig == "6/8") n = 6, d = 8;
  else if (sig == "12/8") n = 12, d = 8;
  song_.sigNum = n;
  song_.sigDen = d;
  song_.newBar = newBar;  // INTERFACE-CHANGE(T07): visible to the services of this call only (T07 review O2)
  forEachService([&](Service &s) { s.onSongState(song_); });
  song_.newBar = false;
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
  return sg_->eqAudition(slot, mode, when);  // T13 (T02 #4: true for any slot 0..15, also an empty one)
}
double Model::setDynamicRange(double range) {  // INTERFACE-CHANGE(T13) T12 O1
  return sg_->setDynamicRange(range);
}
double Model::dynamicRange() const {
  return sg_->dynamicRange();
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
      sg_->onRateChanged(e.f.a);  // T13 (T11 O3): retiring synth.js instruments
      break;
    default:
      break;
  }
  forEachService([&](Service &s) { s.onAudioEvent(e); });
}

}  // namespace rig
