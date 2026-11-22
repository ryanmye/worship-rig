// Perform input (contract 1.4; T14): notes, pedal, mono / legato, pedalHold, re-strike, touch curves, panic,
// fadeOutAll, noteInput / quietFor, the `notes` / `chord` events, and the Model's 1.4 members over model/perform.h.
// Replaces the STOPGAP(T12) overlay (a global map keyed by Model*): the state is Model::perform() now. JS reference:
// app/js/engine/audio.js noteOn .. fadeOutAll (2125-2370), quietFor (1412), touch (186-300).
#include "model/perform.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iterator>
#include <string>

#include "bridge/json_out.h"
#include "fx/delay_unit.h"
#include "fx/reverb_service.h"
#include "inst/sampler.h"
#include "mix/master_chain.h"
#include "model/model.h"
#include "model/perform_internal.h"
#include "model/sleep.h"
#include "model/song.h"
#include "num/js_math.h"
#include "num/js_number.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig {

using perf::clamp01;

// ---- touch curves (shared/touch-curve.js) ------------------------------------------------------------------------

namespace {
double clampTo(double v, double lo, double hi, double def) {
  return std::isfinite(v) ? std::min(hi, std::max(lo, v)) : def;
}
constexpr double kPedalStuckSec = 30;  // audio.js PEDAL_STUCK_SEC
}  // namespace

Touch Touch::compile(double shape, double min, double max, double top) {
  // normalizeTouch + compileTouch: clamped fields, min above max swapped, top a whole velocity
  const double s = clampTo(shape, 0.25, 4, 1), a = clampTo(min, 0, 1, 0), b = clampTo(max, 0, 1, 1);
  const double tp = js::round(clampTo(top, 20, 127, 127));
  Touch t;
  t.g = s;
  t.lo = std::min(a, b);
  t.span = std::max(a, b) - t.lo;
  t.top = tp;
  t.linear = s == 1;
  return t;
}

Touch Touch::preset(int velocityCurve) {
  switch (velocityCurve) {
    case 0:
      return compile(0.6, 0, 1, 127);  // soft
    case 2:
      return compile(1.6, 0, 1, 127);  // hard
    case 3:
      return compile(1, 100.0 / 127, 100.0 / 127, 127);  // fixed
    default:
      return compile(1, 0, 1, 127);  // normal (= the identity)
  }
}

double Touch::at(double vel127) const {
  double x = vel127 / top;  // touchAt: a division, as before (bit-identical for the named curves)
  if (x > 1) x = 1;
  else if (!(x > 0)) x = 0;
  return lo + span * (linear ? x : js::pow(x, g));
}

namespace {
/** noteOn's `touch`: a compiled curve {g, lo, span, top, linear} or a spec {shape, min, max, top} (audio.js
 *  _touchSpec); anything else = linear. */
Touch keyboardTouch(const yyjson_val *touch) {
  yyjson_val *t = const_cast<yyjson_val *>(touch);
  if (!t || !yyjson_is_obj(t)) return Touch::preset(1);
  auto num = [&](const char *k, double def) {
    yyjson_val *v = yyjson_obj_get(t, k);
    return v && yyjson_is_num(v) ? yyjson_get_num(v) : def;
  };
  yyjson_val *g = yyjson_obj_get(t, "g"), *sp = yyjson_obj_get(t, "span");
  if (g && yyjson_is_num(g) && sp && yyjson_is_num(sp)) {  // already compiled (the controller's own objects)
    Touch k;
    k.g = yyjson_get_num(g);
    k.lo = num("lo", 0);
    k.span = yyjson_get_num(sp);
    k.top = num("top", 127);
    yyjson_val *lin = yyjson_obj_get(t, "linear");
    k.linear = lin ? yyjson_is_true(lin) : k.g == 1;
    return k;
  }
  return Touch::compile(num("shape", NAN), num("min", NAN), num("max", NAN), num("top", NAN));
}

/** audio.js _slotTouch: a slot's own curve, or none ('normal' follows the keyboard). */
bool slotTouch(const SlotPatch &c, Touch &out) {
  if (c.velocityCurve == 1) return false;
  if (c.velocityCurve == 4) {
    out = Touch::compile(c.touch.shape, c.touch.min, c.touch.max, c.touch.top);  // custom (absent fields: defaults)
    return true;
  }
  out = Touch::preset(c.velocityCurve);
  return true;
}

/** Instruments with legatoTo (voice.js InstrumentBase: synth.js, synth-extra, organ); the sampler has none. */
bool hasLegato(const std::string &kind) {
  return kind.rfind("inst.", 0) == 0 && kind != kKindSampler && kind != "inst.test";
}
}  // namespace

// ---- Perform: plumbing -------------------------------------------------------------------------------------------

Perform::Perform(Model &m) : m_(m), sleep_(std::make_unique<Sleep>(m, *this)) {
  // v11-reverb-quiet: reverb builds wait for a pause (audio.js fx.env.quietFor = () => this.quietFor())
  if (auto *rp = dynamic_cast<fx::ReverbPool *>(m_.service<ReverbService>()))
    rp->setQuietProbe([this] { return quietFor(); });
}

Perform::~Perform() {
  if (auto *rp = dynamic_cast<fx::ReverbPool *>(m_.service<ReverbService>())) rp->setQuietProbe(nullptr);
}

bool Perform::send(const Command &c) {
  return m_.send(c);  // through the T13 command gate
}

double Perform::tOf(double when) const {
  const double now = m_.now();  // audio.js _t(when)
  return std::isfinite(when) && when > now ? when : now;
}

std::int64_t Perform::frameOf(double t) const {
  return m_.frameFor(t);
}

void Perform::sendNote(Op op, UnitSlot u, int sn, double vel01, double t, int vel) {
  if (u == UnitSlot::Count) return;  // the channel was disposed
  Command c{};
  c.op = op;
  c.frame = frameOf(t);
  c.target = static_cast<std::uint32_t>(u);
  c.aux = static_cast<std::uint32_t>(sn & 0xff) | (static_cast<std::uint32_t>(std::clamp(vel, 0, 127)) << 8);
  // f.c = the touch-curved level; a level of exactly 0 (a fixed curve at 0) must not fall back to vel / 127
  if (op == Op::NoteOn) c.f.c = vel01 > 0 ? vel01 : 1e-30;
  send(c);
}

void Perform::sendFade(UnitSlot u, int sn, double t, double seconds) {
  if (u == UnitSlot::Count) return;
  Command c{};
  c.op = Op::FadeNote;  // INTERFACE-CHANGE(T14) O-W3-1
  c.frame = frameOf(t);
  c.target = static_cast<std::uint32_t>(u);
  c.aux = static_cast<std::uint32_t>(sn & 0xff);
  c.f.a = seconds;
  send(c);
}

const SlotPatch *Perform::cfgOf(std::uint32_t ch) const {
  const Channel *c = m_.songGraph().channelById(ch);
  if (!c) return nullptr;
  return c->retire >= 0 ? &c->cfg : &m_.patch().slots[c->slot];  // T13: a live channel's cfg is the patch slot
}

std::string Perform::kindOf(std::uint32_t ch) const {
  const Channel *c = m_.songGraph().channelById(ch);
  return c ? c->kind : std::string();
}

void Perform::warnOnce(const std::string &message) {
  if (warned_.insert(message).second) m_.warn(message, "warn");
}

// ---- notes (audio.js noteOn / noteOff / sustain) -----------------------------------------------------------------

bool Perform::noteOn(int note, int vel, double when, const yyjson_val *touch) {
  const Touch kbd = keyboardTouch(touch);
  return noteOnTouch(note, vel, when, touch ? &kbd : nullptr);
}

bool Perform::noteOnFrom(std::uint8_t src, int note, int vel, double when, const yyjson_val *touch) {
  if (!(vel > 0)) return noteOffFrom(src, note, when);
  std::uint8_t &h = holders_[std::clamp(note, 0, 127)];
  const bool other = (h & ~src) != 0;
  h = static_cast<std::uint8_t>(h | src);
  if (other) {  // controller.js noteOnFrom: c > 0, the pitch already sounds for another source
    noteInput(when);
    return true;
  }
  return noteOn(note, vel, when, touch);
}

bool Perform::noteOffFrom(std::uint8_t src, int note, double when) {
  std::uint8_t &h = holders_[std::clamp(note, 0, 127)];
  h = static_cast<std::uint8_t>(h & ~src);
  if (h != 0) {  // still held from the other path
    noteInput(when);
    return true;
  }
  return noteOff(note, when);
}

bool Perform::noteOnTouch(int note, int vel, double when, const Touch *kbdTouch) {
  noteInput(when);
  SleepCall held{SleepCall::NoteOn, note, vel, false, kbdTouch != nullptr, kbdTouch ? *kbdTouch : Touch{}};
  if (sleep_->hold(held)) return true;  // lowres2 (W3A): played at the wake ramp's start
  if (!(vel > 0)) return noteOff(note, when);  // MIDI convention: velocity 0 = note-off
  const double t = tOf(when);
  const int n = std::clamp(note, 0, 127);
  if (fadeSeq_) {  // the next noteOn after fadeOutAll restores the master instantly (5 ms smoothing)
    fadeSeq_ = 0;
    ParamOut g(*this, UnitSlot::MasterChain, kMasterFadeGain);
    wa::rampTo(g, 1.0, t, 0.005);
  }
  if (sounding_.count(n)) noteOff(n, t);  // duplicate note-on = re-strike
  held_.insert(n);
  const Touch kbd = kbdTouch ? *kbdTouch : Touch::preset(1);
  std::vector<Entry> entries;
  const SongGraph &sg = m_.songGraph();
  for (int i = 0; i < kMaxSlots; ++i) {
    const Channel *ch = sg.liveChannel(i);  // audio.js `const sc = this.slots[i]`
    if (!ch || !ch->hasInst) continue;
    const SlotPatch &c = m_.patch().slots[i];
    if (n < c.spec.lowNote || n > c.spec.highNote) continue;  // split on the physical note
    const int sn = n + m_.song().transpose + 12 * c.octave + c.transpose;
    if (sn < 0 || sn > 127) {
      warnOnce("Note out of range after transpose (slot " + std::to_string(i) + "); skipped.");
      continue;
    }
    Touch st;
    const double v01 = (slotTouch(c, st) ? st : kbd).at(vel);
    if (c.mono != 0) {
      monoOn(*ch, n, sn, v01, vel, t);
      Entry e;
      e.slot = i;
      e.phys = n;
      e.ch = ch->id;
      e.mono = true;
      entries.push_back(e);
      continue;
    }
    // re-strike of a pedaled note on this slot: fade the old voice 30 ms, then start the new one (FIFO: the
    // FadeNote reaches the instrument before this NoteOn, so only the pedaled voice fades)
    for (std::size_t k = 0; k < pedaled_.size();) {
      if (pedaled_[k].ch == ch->id && pedaled_[k].sn == sn) {
        sendFade(instSlot(static_cast<std::size_t>(i)), sn, t, 0.03);
        unpedal(k);
      } else {
        ++k;
      }
    }
    sendNote(Op::NoteOn, instSlot(static_cast<std::size_t>(i)), sn, v01, t, vel);
    Entry e;
    e.slot = i;
    e.sn = sn;
    e.phys = n;
    e.ch = ch->id;
    entries.push_back(e);
  }
  sounding_[n] = std::move(entries);
  ++m_.stats_.notesOn;
  notesChanged(t);
  return true;
}

bool Perform::noteOff(int note, double when) {
  noteInput(when);
  if (sleep_->hold(SleepCall{SleepCall::NoteOff, note, 0, false, false, Touch{}})) return true;  // W3A: in order
  const double t = tOf(when);
  const int n = std::clamp(note, 0, 127);
  held_.erase(n);
  auto it = sounding_.find(n);
  if (it != sounding_.end()) {
    std::vector<Entry> entries = std::move(it->second);
    sounding_.erase(it);
    for (Entry &e : entries) {
      const SlotPatch *cfg = cfgOf(e.ch);
      if (!cfg) continue;  // disposed with its instrument
      if (e.mono) monoOff(e.ch, n, t);
      else if (pedal_ && cfg->sustain) pedalHold(e, t);
      else release(e, t);
    }
  }
  ++m_.stats_.notesOff;
  notesChanged(t);
  return true;
}

void Perform::release(const Entry &e, double t) {
  // audio.js _release: the slot's `release` reaches the instrument as its release override (T13 sendRelease)
  sendOff(e.ch, e.sn, t);
}

void Perform::sendOff(std::uint32_t ch, int sn, double t) {
  // W3A T13 review O4: a note-off posted between a commit call and its future `when` (out of order) resolves to
  // RetireInst<j>, where the instrument arrives only at the move frame; the gate would hold the release until then.
  // The note is in Inst<slot> until that frame, so it goes there, past the gate (the gate's hold is meant for
  // commands to the NEW occupant of Inst<slot>, which attaches at the same frame).
  const SongGraph &sg = m_.songGraph();
  const UnitSlot u = sg.instUnitOf(ch);
  const Channel *c = sg.channelById(ch);
  if (c && c->retire >= 0 && u != UnitSlot::Count) {
    const std::int64_t f = frameOf(t), now = m_.sink().timeBase().frame;
    if (sg.occupantFrame(u) > std::max(f, now)) {
      Command x{};
      x.op = Op::NoteOff;
      x.frame = std::max(f, now);
      x.target = static_cast<std::uint32_t>(instSlot(static_cast<std::size_t>(c->slot)));
      x.aux = static_cast<std::uint32_t>(sn & 0xff);
      m_.sink().send(x);  // ungated: the old occupant still holds the note at this frame
      return;
    }
  }
  sendNote(Op::NoteOff, u, sn, 0, t);
}

void Perform::pedalHold(Entry &e, double t) {
  // audio.js _pedalHold: a numeric pedalHold fades the note after that long under the pedal, over 25 % of it
  e.hold = 0;
  const SlotPatch *cfg = cfgOf(e.ch);
  const double hold = cfg ? cfg->pedalHold : 0;
  if (std::isfinite(hold) && hold > 0) {
    const std::uint32_t token = e.hold = ++nextHold_;
    m_.sink().at(t + hold, [this, token, hold](double tt) {
      for (std::size_t k = 0; k < pedaled_.size(); ++k) {
        if (pedaled_[k].hold != token) continue;
        const Entry x = pedaled_[k];
        pedaled_.erase(pedaled_.begin() + static_cast<std::ptrdiff_t>(k));
        sendFade(m_.songGraph().instUnitOf(x.ch), x.sn, tt, 0.25 * hold);
        return;
      }
    });
  }
  pedaled_.push_back(e);
}

void Perform::unpedal(std::size_t i) {
  pedaled_.erase(pedaled_.begin() + static_cast<std::ptrdiff_t>(i));  // its pedalHold timer finds nothing
}

void Perform::unpedalAll() {
  pedaled_.clear();
}

bool Perform::sustain(bool down, double when) {
  if (sleep_->hold(SleepCall{SleepCall::Sustain, 0, 0, down, false, Touch{}})) return true;  // lowres2 (W3A)
  noteInput(when);
  const double t = tOf(when);
  if (down == pedal_) return true;
  pedal_ = down;
  if (down) pedalDownAt_ = t;
  syncPedalSwell(t);
  if (!down) {
    for (const Entry &e : pedaled_) release(e, t);
    unpedalAll();
    for (auto &[ch, mo] : mono_) {
      if (!(mo.pedalHold && mo.notes.empty() && mo.cur)) continue;
      sendOff(ch, mo.curSn, t);
      mo.cur = false;
      mo.pedalHold = false;
    }
  }
  return true;
}

// ---- mono (audio.js _monoTarget / _monoSwitch / _monoOn / _monoOff) ----------------------------------------------

Perform::Mono &Perform::mono(std::uint32_t ch) {
  auto it = mono_.find(ch);
  if (it == mono_.end()) {
    it = mono_.emplace(ch, Mono{}).first;
    it->second.gen = ++monoGen_;
  }
  return it->second;
}

bool Perform::monoTarget(std::uint32_t ch, const SlotPatch &cfg, MonoNote &out) {
  const Mono &M = mono(ch);
  bool any = false;
  for (const MonoNote &x : M.notes) {
    if (!any || (cfg.mono == 2 ? x.phys > out.phys : x.phys < out.phys)) out = x;
    any = true;
  }
  return any;
}

void Perform::monoSwitch(std::uint32_t ch, const MonoNote &target, double t) {
  Mono &M = mono(ch);
  M.pedalHold = false;
  const UnitSlot u = m_.songGraph().instUnitOf(ch);
  if (M.cur && hasLegato(kindOf(ch))) {  // a held current voice glides (instrument legato, 30 ms class)
    Command c{};
    c.op = Op::LegatoTo;
    c.frame = frameOf(t);
    c.target = static_cast<std::uint32_t>(u);
    c.aux = static_cast<std::uint32_t>(M.curSn & 0xff) | (static_cast<std::uint32_t>(target.sn & 0xff) << 8);
    c.f.c = 0;  // the instrument's own glide
    if (u != UnitSlot::Count) send(c);
    M.curPhys = target.phys;
    M.curSn = target.sn;
    M.curId = ++nextHold_;
    return;
  }
  if (M.cur) sendFade(u, M.curSn, t, 0.03);  // legato retrigger: 30 ms crossfade
  // (a retiring channel's mono line keeps playing: audio.js _monoOff -> _monoSwitch on sc, a targeted NoteOn)
  sendNote(Op::NoteOn, u, target.sn, target.v, t, target.vel);
  M.cur = true;
  M.curPhys = target.phys;
  M.curSn = target.sn;
  M.curId = ++nextHold_;
}

void Perform::monoOn(const Channel &c, int phys, int sn, double v, int vel, double t) {
  Mono &M = mono(c.id);
  bool found = false;
  for (MonoNote &x : M.notes)
    if (x.phys == phys) {  // Map.set: an existing key keeps its place
      x.sn = sn;
      x.v = v;
      x.vel = vel;
      found = true;
    }
  if (!found) M.notes.push_back({phys, sn, v, vel});
  MonoNote target{};
  monoTarget(c.id, m_.patch().slots[c.slot], target);
  if (!M.cur || M.curPhys != target.phys || M.pedalHold) monoSwitch(c.id, target, t);
}

void Perform::monoOff(std::uint32_t ch, int phys, double t) {
  Mono &M = mono(ch);
  M.notes.erase(std::remove_if(M.notes.begin(), M.notes.end(), [phys](const MonoNote &x) { return x.phys == phys; }),
                M.notes.end());
  if (!M.cur || M.curPhys != phys) return;
  const SlotPatch *cfg = cfgOf(ch);
  if (!cfg) return;
  if (!M.notes.empty()) {
    MonoNote target{};
    monoTarget(ch, *cfg, target);
    monoSwitch(ch, target, t);
    return;
  }
  if (pedal_ && cfg->sustain) {
    M.pedalHold = true;  // the pedal only defers the final release
    const double hold = cfg->pedalHold;
    if (std::isfinite(hold) && hold > 0) {  // a numeric pedalHold fades the held mono note too
      const std::uint32_t gen = M.gen, cur = M.curId;
      m_.sink().at(t + hold, [this, ch, gen, cur, hold](double tt) {
        auto it = mono_.find(ch);
        if (it == mono_.end()) return;
        Mono &m = it->second;
        if (m.gen != gen || !m.pedalHold || !m.cur || m.curId != cur) return;  // a stale timer does nothing
        sendFade(m_.songGraph().instUnitOf(ch), m.curSn, tt, 0.25 * hold);
        m.cur = false;
        m.pedalHold = false;
      });
    }
    return;
  }
  sendOff(ch, M.curSn, t);
  M.cur = false;
}

void Perform::resetMono() {
  mono_.clear();  // fresh objects per channel (created on use, with a new gen)
}

// ---- panic and fade (audio.js allNotesOff / fadeOutAll) ----------------------------------------------------------

void Perform::allNotesOff(double when) {
  const double t = tOf(when);
  Command c{};
  c.op = Op::AllNotesOff;  // 30 ms fade of every voice, slots and retiring channels (graph routing of kAllSlots)
  c.frame = frameOf(t);
  c.target = kAllSlots;
  send(c);
  resetMono();
  sounding_.clear();
  unpedalAll();
  held_.clear();
  std::fill(std::begin(holders_), std::end(holders_), std::uint8_t{0});  // W3A T07 O7 (controller panic clears too)
  pedal_ = false;
  syncPedalSwell(t);
  swellActive_ = 0;
  const std::string mode = m_.songGraph().routing().bendMode;
  bend_ = 0;
  applyBend(t, mode);
  fx::sendDelayPanic(m_, t);
  notesChanged(t);
}

void Perform::fadeOutAll(double seconds, double when) {
  const double t = tOf(when);
  const double s = std::max(0.05, std::isfinite(seconds) && seconds != 0 ? seconds : 6.0);  // Number(s) || 6
  double from = 1;
  if (fadeSeq_) {  // fadeGain.gain.value now: the running exponential glide (floor 1e-4) evaluated at now
    const double now = m_.now();
    const double f0 = std::max(fadeFrom_, wa::kExpFloor);
    if (now <= fadeT0_) from = fadeFrom_;
    else if (now >= fadeT0_ + fadeS_) from = 0;
    else from = f0 * js::pow(wa::kExpFloor / f0, (now - fadeT0_) / fadeS_);
  }
  fadeSeq_ = ++fadeCount_;
  fadeT0_ = t;
  fadeS_ = s;
  fadeFrom_ = from;
  ParamOut g(*this, UnitSlot::MasterChain, kMasterFadeGain);
  wa::glideFrom(g, from, 0.0, t, s);
  const std::uint32_t token = fadeSeq_;
  m_.sink().at(t + s, [this, token](double tt) {
    if (fadeSeq_ != token) return;
    Command c{};
    c.op = Op::AllNotesOff;
    c.frame = frameOf(tt);
    c.target = kAllSlots;
    send(c);
    resetMono();
    sounding_.clear();
    unpedalAll();
  });
}

void Perform::noteInput(double when) {
  const double t = tOf(when);
  if (t > inputAt_) inputAt_ = t;
}

double Perform::quietFor() const {
  const double now = m_.now();
  if (!sounding_.empty()) return 0;
  if ((pedal_ || !pedaled_.empty()) && now - pedalDownAt_ < kPedalStuckSec) return 0;
  return std::max(0.0, now - inputAt_);
}

// ---- events and state --------------------------------------------------------------------------------------------

void Perform::updateChord(bool force, std::string &chordJson) {
  // audio.js _updateChord: 2 notes that aren't a fifth -> null -> keep the previous readout while notes are held
  ChordInfo next;
  if (!held_.empty()) {
    std::vector<int> pcs;
    for (int n : held_) pcs.push_back(n % 12);
    const bool sharp = m_.song().keyPc >= 0 && spellingSharp(m_.song().keyPc, m_.song().keyMinor);
    if (!chordName(pcs, *held_.begin() % 12, sharp, next)) next = lastChord_;
  }
  if (!force && next.name == lastChord_.name) return;
  lastChord_ = next;
  JsonOut j;
  if (next.name.empty()) {
    chordJson = "null";
    return;
  }
  j.begin().kv("name", next.name).kv("root", next.root).kv("quality", next.quality);
  if (next.bass >= 0) j.kv("bass", next.bass);
  else j.kvRaw("bass", "null");
  if (next.omit5) j.kvBool("omit5", true);
  j.end();
  chordJson = j.take();
}

void Perform::notesChanged(double t) {
  std::string chord;
  updateChord(false, chord);
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "notes").key("held").beginArray();
  std::vector<int> held(held_.begin(), held_.end());
  for (int n : held) j.elem(n);
  j.endArray();
  if (!chord.empty()) j.kvRaw("chord", chord);
  j.end();
  m_.emit(j.take());
  if (auto *d = dynamic_cast<PerformDrone *>(m_.service("drone"))) d->droneNotesChanged(held, t);
}

std::string Perform::runtimeStateJson() const {
  const WheelValues &w = const_cast<Model &>(m_).songGraph().wheel();
  JsonOut j;
  j.begin().key("wheel").begin().kvRaw("mod", js::numberToString(w.mod)).kvRaw("expr", js::numberToString(w.expr));
  j.kvRaw("vol", js::numberToString(w.vol)).end();
  j.kv("modOwner", modVirtual_ ? "virtual" : "hw").kvBool("faded", fadeSeq_ != 0).end();
  return j.take();
}

void Perform::statsFields(std::string &out) const {
  out += ",\"sounding\":" + std::to_string(sounding_.size()) + ",\"pedaled\":" + std::to_string(pedaled_.size());
  sleep_->statsFields(out);  // W3A: audioSleep, lastWake
}

void Perform::channelDisposed(std::uint32_t channelId) {
  // audio.js _pollRetiring -> _unpedal(e) for the disposed channel's pedaled notes; its mono state goes with it
  pedaled_.erase(std::remove_if(pedaled_.begin(), pedaled_.end(),
                                [channelId](const Entry &e) { return e.ch == channelId; }),
                 pedaled_.end());
  mono_.erase(channelId);
}

// ---- Model contract 1.4 members ------------------------------------------------------------------------------------

bool Model::noteOn(int note, int vel, double when, const yyjson_val *touch) {
  return perf_->noteOnFrom(Perform::kSrcApp, note, vel, when, touch);  // W3A T07 O7
}
bool Model::noteOff(int note, double when) {
  return perf_->noteOffFrom(Perform::kSrcApp, note, when);
}
bool Model::sustain(bool down, double when) {
  return perf_->sustain(down, when);
}
void Model::pitchBend(double x, double when) {
  perf_->pitchBend(x, when);
}
bool Model::setWheel(std::string_view source, double value, double when, double glide) {
  return perf_->setWheel(source, value, when, glide);
}
bool Model::swell(int start, double when) {
  return perf_->swell(start, when);
}
void Model::allNotesOff(double when) {
  perf_->allNotesOff(when);
}
void Model::fadeOutAll(double seconds, double when) {
  perf_->fadeOutAll(seconds, when);
}
void Model::noteInput(double when) {
  perf_->noteInput(when);
}
std::string Model::wheelValuesJson() const {
  return perf_->wheelValuesJson();
}
std::string Model::runtimeStateJson() const {
  return perf_->runtimeStateJson();
}

// T13 hooks (model/song.h): the retire poll disposed a channel; ~Model (the state is a Model member now: T12 O5)
void performChannelDisposed(const Model &m, std::uint32_t channelId) {
  const_cast<Model &>(m).perform().channelDisposed(channelId);
}
void performForget(const Model &) {}

}  // namespace rig
