// DroneCore (drone/drone_core.h): port of app/js/engine/drone.js class Drone (T16). Method names follow the JS ones;
// comments cite the JS review ids where drone.js does.
#include "drone/drone_core.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdio>
#include <limits>

#include "bridge/json_out.h"
#include "drone/drone_osc.h"
#include "inst/synth_dsp.h"
#include "num/js_math.h"
#include "yyjson.h"

namespace rig::drone {
namespace {

double clampd(double x, double lo, double hi) {
  return std::min(hi, std::max(lo, x));
}

std::uint64_t d2u(double d) {
  return std::bit_cast<std::uint64_t>(d);
}

/** drone.js fadeLevel(f, t, dflt): level at time t of an equal-power (or linear) fade. */
template <class F>
double fadeLevelOf(const F *f, double t, double dflt) {
  if (!f) return dflt;
  if (t >= f->t + f->dur) return f->to;
  if (t <= f->t) return f->from;
  if (f->lin) return f->from + ((f->to - f->from) * (t - f->t)) / f->dur;  // lowres2-critic #1: aligned loop swap
  const double x = ((t - f->t) / f->dur) * (js::kPi / 2);
  return f->to >= f->from ? f->from + (f->to - f->from) * js::sin(x) : f->to + (f->from - f->to) * js::cos(x);
}

std::string fileId(int pc, bool minor) {
  return std::to_string(mod12(pc)) + (minor ? "|true" : "|false");
}

double noteToFreq(int midi) {
  return 440 * js::pow(2, (midi - 69) / 12.0);
}

}  // namespace

void DroneHost::renderLoop(const LoopRequest &req, std::function<void(LoopResult)> done) {
  done(renderDroneLoop(req));
}

double DroneCore::PRef::intrinsic() const {
  return std::numeric_limits<double>::quiet_NaN();
}

DroneCore::DroneCore(DroneHost &host, Rng rng) : h_(host), rng_(rng) {}

DroneCore::~DroneCore() {
  *alive_ = false;
  disposed_ = true;
}

// ---- commands -----------------------------------------------------------------------------------------------------

bool DroneCore::paramOp(std::uint32_t idx, ParamCall call, double v, double t, double tc) {
  Command c{};
  c.op = opOf(DroneOp::Param);
  c.frame = kFrameNow;
  c.sub = static_cast<std::uint16_t>(idx);
  c.aux = static_cast<std::uint32_t>(call);
  c.f.a = v;
  c.f.b = t;
  c.f.c = tc;
  h_.send(c, callT_);
  return true;
}

void DroneCore::op(DroneOp o, unsigned aux, double a, double b, double c, std::uint16_t sub) {
  Command cmd{};
  cmd.op = opOf(o);
  cmd.frame = kFrameNow;
  cmd.aux = aux;
  cmd.sub = sub;
  cmd.f.a = a;
  cmd.f.b = b;
  cmd.f.c = c;
  h_.send(cmd, -1);
}

void DroneCore::opOwned(DroneOp o, unsigned aux, Owned *payload, double u0, double u1, double u2) {
  Command cmd{};
  cmd.op = opOf(o);
  cmd.frame = kFrameNow;
  cmd.aux = aux;
  cmd.sub = kSubOwnedPayload;
  cmd.p.ptr = payload;
  cmd.p.u0 = d2u(u0);
  cmd.p.u1 = d2u(u1);
  cmd.p.u2 = d2u(u2);
  h_.send(cmd, -1);
}

double DroneCore::t(double when) const {
  const double now = h_.now();
  return std::isfinite(when) && when > now ? when : now;
}

void DroneCore::warnOnce(const std::string &key, const std::string &msg) {
  if (warned_.count(key)) return;
  warned_[key] = true;
  h_.warn(msg);
}

// ---- construction ---------------------------------------------------------------------------------------------------

DroneInit DroneCore::unitInit(double trimDb) {
  trimDb_ = std::isfinite(trimDb) ? trimDb : 0;
  DroneInit in;
  in.level = 0.5011872336272722;  // Math.pow(10, -6 / 20)
  in.width = p_.width;            // drone.js constructor: this._applyWidth(0)
  in.trimGain = js::pow(10, trimDb_ / 20);
  return in;
}

void DroneCore::setTrim(double db) {
  const double d = std::isfinite(db) ? db : 0;
  const double g = js::pow(10, d / 20);
  trimDb_ = d;
  PRef p = prm(kParamSynthBus);
  wa::setNow(p, g, 0);
}

std::size_t DroneCore::instCount() const {
  std::size_t n = 0;
  for (bool u : slotUsed_) n += u ? 1 : 0;
  return n;
}

void DroneCore::freeSlot(int slot) {
  if (slot >= 0 && slot < static_cast<int>(kMaxInst)) slotUsed_[slot] = false;
}

std::optional<DroneCore::InstEntry> DroneCore::buildInst() {
  int slot = -1;
  for (unsigned i = 0; i < kMaxInst; ++i)
    if (!slotUsed_[i]) {
      slot = static_cast<int>(i);
      break;
    }
  if (slot < 0 && !idle_.empty()) {  // out of slots: an idle instrument goes first
    const InstEntry e = idle_.front();
    idle_.erase(idle_.begin());
    op(DroneOp::DropInst, static_cast<unsigned>(e.slot));
    freeSlot(e.slot);
    slot = e.slot;
  }
  if (slot < 0) {
    warnOnce("drone-slots", "Drone: too many overlapping layers; a fading one was cut.");
    // the oldest fading layer ends now (its gain is mid-fade: a short cut, the price of a bounded pool)
    for (auto it = layers_.begin(); it != layers_.end(); ++it) {
      if (!(*it)->dead) continue;
      slot = (*it)->pe.slot;
      op(DroneOp::DropInst, static_cast<unsigned>(slot));
      layers_.erase(it);
      break;
    }
    if (slot < 0) return std::nullopt;
  }
  auto box = new InstBox;
  box->inst = makeDroneOsc(rng_, h_.sampleRate(), droneOscParams(p_.movement));
  opOwned(DroneOp::SetInst, static_cast<unsigned>(slot), box);
  slotUsed_[slot] = true;
  ++builds_;
  return InstEntry{slot, false};
}

std::optional<DroneCore::InstEntry> DroneCore::takeInst(double t) {
  std::optional<InstEntry> e;
  if (!idle_.empty()) {
    e = idle_.front();
    idle_.erase(idle_.begin());
  } else {
    e = buildInst();
  }
  if (!e) return e;
  if (!e->armed) {
    e->armed = true;
    op(DroneOp::Arm, static_cast<unsigned>(e->slot), 1);
  }
  applyInstParams(*e, t);
  // warm() (REVIEW #16): realtime, a spare is built in idle time so the next key change does not construct one
  if (!h_.offline() && idle_.empty()) {
    std::weak_ptr<bool> alive = alive_;
    h_.at(h_.now() + 0.25, [this, alive](double) {
      if (alive.expired() || disposed_ || !idle_.empty()) return;
      if (auto s = buildInst()) idle_.push_back(*s);
    });
  }
  return e;
}

void DroneCore::returnInst(const InstEntry &e0) {
  InstEntry e = e0;
  const std::size_t cap = cfg_.chordFollow ? 4 : kIdleInst;
  if (!disposed_ && idle_.size() < cap && e.slot >= 0 && slotUsed_[e.slot]) {
    if (e.armed) {  // idle-cpu #1: an idle instrument waits disconnected
      e.armed = false;
      op(DroneOp::Arm, static_cast<unsigned>(e.slot), 0);
    }
    idle_.push_back(e);
    return;
  }
  if (e.slot >= 0 && slotUsed_[e.slot]) op(DroneOp::DropInst, static_cast<unsigned>(e.slot));
  freeSlot(e.slot);
}

// ---- params -------------------------------------------------------------------------------------------------------

double DroneCore::voiceAttack() const {
  return droneOscAttack();
}

void DroneCore::applyInstParams(const InstEntry &e, double t) {
  // _instParams(): drift, unisonDrift, lfoDepth from movement; drone-osc has no 'brightness' -> morph
  const double m = clampd(p_.movement, 0, 1);
  const std::pair<const char *, double> ps[] = {{"drift", 1 + 6 * m}, {"unisonDrift", 1.6 + 8 * m},
                                                {"lfoDepth", 20 + 600 * m}};
  for (const auto &[k, v] : ps) {
    const int idx = droneOscParam(k);
    if (idx >= 0) op(DroneOp::InstParam, static_cast<unsigned>(e.slot), v, t, 0, static_cast<std::uint16_t>(idx));
  }
  op(DroneOp::Morph, static_cast<unsigned>(e.slot), clampd(p_.brightness, 0, 1), t);
}

void DroneCore::applyWidth(double t) {
  // L' = aL + bR, R' = aR + bL; width 1 -> a=1,b=0 (full stereo), width 0 -> mono
  const double w = clampd(p_.width, 0, 1);
  const double a = (1 + w) / 2;
  const double b = (1 - w) / 2;
  PRef pa = prm(kDroneWidthA), pb = prm(kDroneWidthB);
  wa::rampTo(pa, a, t, 0.02);  // wLL, wRR
  wa::rampTo(pb, b, t, 0.02);  // wLR, wRL
}

double DroneCore::levelTarget() const {
  const double g = clampd(p_.gain, 0, 2);
  if (g >= 1) return g;
  const double up = std::max(pedalOn_ ? 1.0 : 0.0, bendUp_);
  return std::min(4 * g, g + (1 - g) * up);
}

void DroneCore::swellLevel(double t, double tc) {
  const wa::Move &m = levelMove_;
  const double to = levelTarget();
  const double from = wa::moveAt(m, t, clampd(p_.gain, 0, 2));
  if (m.valid ? (m.to == to && !(m.tc > tc)) : from == to) return;
  PRef lv = prm(kDroneLevel);
  wa::rampTo(lv, to, t, tc);
  levelMove_ = wa::Move{from, to, t, 0, tc, true};
}

bool DroneCore::setParam(std::string_view key, double value, double when, double glide) {
  const double tt = t(when);
  CallTime ct(*this, tt);
  const double v = value;
  if (!std::isfinite(v)) return false;
  double *slot = key == "gain"         ? &p_.gain
                 : key == "brightness" ? &p_.brightness
                 : key == "movement"   ? &p_.movement
                 : key == "width"      ? &p_.width
                 : key == "fade"       ? &p_.fade
                                       : nullptr;
  if (!slot) return false;
  const double prevBright = p_.brightness;
  const double prevLevel = levelTarget();
  *slot = v;
  if (key == "gain") {
    // v11-scenes / v11-review-fixes R-1: a tracked move to the absolute (swell-adjusted) level
    const double g = glide > 0 ? glide : 0;
    const double to = levelTarget();
    if (to != (levelMove_.valid ? levelMove_.to : prevLevel)) {
      PRef lv = prm(kDroneLevel);
      levelMove_ = wa::trackedMove(lv, levelMove_, to, tt, g, prevLevel);
    }
    gainChanged(tt);
  } else if (key == "width") {
    applyWidth(tt);
  } else if (key == "brightness" || key == "movement") {
    for (const LayerP &L : layers_) applyInstParams(L->pe, tt);
    for (const LayerP &fv : follow_.voices) applyInstParams(fv->pe, tt);
    if (key == "brightness" && (prevBright > 0.6) != (v > 0.6)) revoice(tt);
  }
  return true;
}

double DroneCore::getParam(std::string_view key) const {
  if (key == "gain") return p_.gain;
  if (key == "brightness") return p_.brightness;
  if (key == "movement") return p_.movement;
  if (key == "width") return p_.width;
  if (key == "fade") return p_.fade;
  return std::numeric_limits<double>::quiet_NaN();
}

void DroneCore::gainChanged(double tt) {
  // idle-cpu #2: park after DRONE_PARK_SEC at gain 0; resume when the gain comes back
  const unsigned seq = ++parkSeq_;
  if (p_.gain > 0) {
    if (parked_) {
      parked_ = false;
      if (cfg_.mode != "off" && key_) start(*key_, kParkResumeFade, tt, true);
    }
    return;
  }
  if (parked_ || !sounding_) return;
  std::weak_ptr<bool> alive = alive_;
  h_.at(tt + kDroneParkSec, [this, alive, seq](double t2) {
    if (alive.expired() || seq != parkSeq_ || disposed_ || p_.gain > 0) return;
    if (!sounding_ || cfg_.mode == "off") return;
    fadeOutAll(t2, kParkResumeFade);
    sounding_ = false;
    parked_ = true;
  });
}

void DroneCore::configure(const yyjson_val *dv, double when) {
  auto *d = const_cast<yyjson_val *>(dv);
  if (!d || !yyjson_is_obj(d)) return;
  Config c;
  auto flag = [&](const char *k, std::optional<bool> &out) {
    if (yyjson_val *v = yyjson_obj_get(d, k)) out = yyjson_is_true(v) || (yyjson_is_num(v) && yyjson_get_num(v) != 0);
  };
  auto num = [&](const char *k, std::optional<double> &out) {
    yyjson_val *v = yyjson_obj_get(d, k);
    if (!v) return;
    if (yyjson_is_num(v)) out = yyjson_get_num(v);
    else if (yyjson_is_bool(v)) out = yyjson_get_bool(v) ? 1.0 : 0.0;
    else out = std::numeric_limits<double>::quiet_NaN();  // Number(x) of anything else: setParam refuses it
  };
  flag("chordFollow", c.chordFollow);
  flag("continueAcrossSongs", c.continueAcrossSongs);
  flag("minorUsesRelativeMajorFile", c.minorUsesRelativeMajorFile);
  num("gain", c.gain);
  num("brightness", c.brightness);
  num("movement", c.movement);
  num("width", c.width);
  num("fade", c.fade);
  if (yyjson_val *m = yyjson_obj_get(d, "mode")) c.mode = yyjson_is_str(m) ? yyjson_get_str(m) : "";
  configure(c, when);
}

void DroneCore::configure(const Config &d, double when) {
  const double tt = t(when);
  CallTime ct(*this, tt);
  if (d.chordFollow) cfg_.chordFollow = *d.chordFollow;
  if (d.continueAcrossSongs) cfg_.continueAcrossSongs = *d.continueAcrossSongs;
  if (d.minorUsesRelativeMajorFile) cfg_.minorUsesRelativeMajorFile = *d.minorUsesRelativeMajorFile;
  // for (const k of Object.keys(this.p)): gain, brightness, movement, width, fade
  if (d.gain) setParam("gain", *d.gain, tt);
  if (d.brightness) setParam("brightness", *d.brightness, tt);
  if (d.movement) setParam("movement", *d.movement, tt);
  if (d.width) setParam("width", *d.width, tt);
  if (d.fade) setParam("fade", *d.fade, tt);
  if (!cfg_.chordFollow && !follow_.voices.empty()) endFollow(tt);
  if (d.mode) setMode(*d.mode, tt);
}

void DroneCore::songChanged(double when) {
  if (cfg_.continueAcrossSongs) return;
  const double tt = t(when);
  CallTime ct(*this, tt);
  fadeOutAll(tt, p_.fade);
  sounding_ = false;
}

// ---- mode / key -----------------------------------------------------------------------------------------------------

void DroneCore::setMode(std::string_view mode, double when) {
  const double tt = t(when);
  CallTime ct(*this, tt);
  const std::string m = mode == "synth" || mode == "files" ? std::string(mode) : std::string("off");
  if (m == cfg_.mode && (m == "off" || sounding_)) return;
  cfg_.mode = m;
  if (parked_) {
    if (m == "off") parked_ = false;  // idle-cpu #2: parked at gain 0: the gain coming back starts it
    return;
  }
  if (m == "off") {
    fadeOutAll(tt, p_.fade);
    sounding_ = false;
    return;
  }
  if (key_) start(*key_, p_.fade, tt, true);
}

bool DroneCore::setKey(int pc, bool minor, double fade, double when) {
  const double tt = t(when);
  CallTime ct(*this, tt);
  const Key key{mod12(pc), minor};
  const bool same = key_ && key_->pc == key.pc && key_->minor == key.minor;
  key_ = key;
  if (same && sounding_) return false;  // same key -> no-op (no restarted crossfade)
  if (cfg_.mode == "off" || parked_) return true;
  start(key, std::isfinite(fade) && fade >= 0 ? fade : p_.fade, tt, false);
  return true;
}

void DroneCore::start(const Key &key, double fade, double tt, bool modeSwitch) {
  // lowres2-critic R5: something already sounds: voices attack in XFADE_ATTACK_SEC under a shorter song fade
  bool hadSound = !follow_.voices.empty() || frozen_ || !activeEls_.empty();
  for (const LayerP &L : layers_) hadSound = hadSound || !L->dead;
  const double va = voiceAttack();
  const std::optional<double> attack = hadSound && fade < va ? std::optional<double>(kXfadeAttackSec) : std::nullopt;
  const bool wantFiles = cfg_.mode == "files";
  const PadFile *file = nullptr;
  if (wantFiles) {
    file = fileFor(key.pc, key.minor);
    if (!file) {
      const std::string kn = keyName(key.pc, key.minor);
      warnOnce("nofile|" + std::to_string(key.pc) + "|" + (key.minor ? "true" : "false"),
               "No pad file for " + kn + "; using the synth drone.");
    }
  }
  const std::string mode = file ? "files" : "synth";
  if (mode != effectiveMode_ || modeSwitch) {
    const std::string was = effectiveMode_;
    PRef sm = prm(kParamSynthMode), fm = prm(kParamFilesMode), sg = prm(kDroneSendGate);
    wa::linFrom(sm, was == "files" ? 0 : 1, mode == "synth" ? 1 : 0, tt, 0.05);
    wa::linFrom(fm, was == "files" ? 1 : 0, mode == "files" ? 1 : 0, tt, 0.05);
    wa::rampTo(sg, mode == "synth" ? 0.4 : 0, tt, fade / 4);
  } else if (sendMuted_ && mode == "synth") {
    PRef sg = prm(kDroneSendGate);
    wa::rampTo(sg, 0.4, tt, fade / 4);  // lowres2: the live synth comes back after a frozen loop
  }
  sendMuted_ = false;
  freezeInvalidate();  // lowres2: a render in flight is for the old key / mode
  fadeOutAll(tt, fade);
  effectiveMode_ = mode;
  if (mode == "files") filesTo(file, fade, tt);
  else synthTo(key, fade, tt, attack);
  sounding_ = true;
  if (!(p_.gain > 0)) gainChanged(tt);  // started at gain 0: park it too (idle-cpu #2)
}

void DroneCore::fadeOutAll(double tt, double fade) {
  std::vector<FrozenP> fzs;
  if (frozen_) fzs.push_back(frozen_);
  fzs.insert(fzs.end(), fzOut_.begin(), fzOut_.end());
  for (const FrozenP &fz : fzs)
    if (fz && !(fz->fade.to == 0 && fz->fade.t <= tt)) fadeOutFrozen(fz, tt, fade);
  for (const LayerP &L : std::vector<LayerP>(layers_)) fadeOutLayer(L, tt, fade);
  if (!follow_.voices.empty()) {
    for (const LayerP &fv : std::vector<LayerP>(follow_.voices)) fadeOutLayer(fv, tt, fade);
    follow_.voices.clear();
  }
  follow_.targets.reset();
  follow_.pending.reset();
  for (const ElP &e : std::vector<ElP>(activeEls_)) fadeOutEl(e, tt, fade);
}

// ---- synth layers ---------------------------------------------------------------------------------------------------

DroneCore::LayerP DroneCore::newLayer(const std::vector<int> &notes, double tt, double fade, double vel, double fadeAt,
                                      std::optional<double> attack) {
  const std::optional<InstEntry> pe = takeInst(tt);
  if (!pe) return nullptr;
  h_.wake();  // idle-cpu #2: the engine's sleeping send effects wake before the layer sounds
  const double va = voiceAttack();
  const double a = attack ? *attack : va;
  const bool setA = a != va;  // the instrument keeps drone-osc's own attack between layers
  const int ai = droneOscParam("attack");
  const unsigned s = static_cast<unsigned>(pe->slot);
  if (setA && ai >= 0) op(DroneOp::InstParam, s, a, tt, 0, static_cast<std::uint16_t>(ai));
  auto L = std::make_shared<Layer>();
  L->pe = *pe;
  L->fade = Fade{fadeAt, fade, 0, 1, false};
  L->voiceT = tt;  // lowres2-critic R1: the voices are at full level from voiceT + attack
  L->attack = a;
  for (int n : notes) {
    L->notes.push_back(n);
    op(DroneOp::NoteOn, s, n, tt, vel);
  }
  if (setA && ai >= 0) op(DroneOp::InstParam, s, va, tt, 0, static_cast<std::uint16_t>(ai));
  PRef g = prm(kParamInstGain0 + s);
  if (fadeAt > tt) wa::setNow(g, 0, tt);
  wa::equalPowerFade(g, 0, 1, fadeAt, fade);
  return L;
}

void DroneCore::fadeOutLayer(const LayerP &L, double tt, double fade) {
  if (!L || L->dead) return;
  L->dead = true;
  const double from = fadeLevelOf(&L->fade, tt, 1);
  L->fade = Fade{tt, fade, from, 0, false};
  PRef g = prm(kParamInstGain0 + static_cast<unsigned>(L->pe.slot));
  wa::equalPowerFade(g, from, 0, tt, fade);
  std::weak_ptr<bool> alive = alive_;
  h_.at(tt + fade + 0.02, [this, alive, L](double t2) {
    if (alive.expired()) return;
    op(DroneOp::AllOff, static_cast<unsigned>(L->pe.slot), 0, t2);  // inst.allOff(tt, 0.05) under a 0 gain
    h_.at(t2 + 0.3, [this, alive, L](double) {
      if (alive.expired()) return;
      layers_.erase(std::remove(layers_.begin(), layers_.end(), L), layers_.end());
      returnInst(L->pe);
    });
  });
}

void DroneCore::synthTo(const Key &key, double fade, double tt, std::optional<double> attack) {
  LayerP L = newLayer(staticVoicing(key.pc, p_.brightness), tt, fade, 0.8, tt, attack);
  if (!L) return;
  L->hasKey = true;
  L->key = key;
  layers_.push_back(L);
}

void DroneCore::revoice(double tt) {
  LayerP L;
  for (const LayerP &x : layers_)
    if (!x->dead && x->hasKey) {
      L = x;
      break;
    }
  if (!L) return;
  const std::vector<int> want = staticVoicing(L->key.pc, p_.brightness);
  const unsigned s = static_cast<unsigned>(L->pe.slot);
  for (int n : want)
    if (std::find(L->notes.begin(), L->notes.end(), n) == L->notes.end()) {
      L->notes.push_back(n);
      op(DroneOp::NoteOn, s, n, tt, 0.8);
    }
  for (int n : std::vector<int>(L->notes))
    if (std::find(want.begin(), want.end(), n) == want.end()) {
      op(DroneOp::NoteOff, s, n, tt);
      L->notes.erase(std::remove(L->notes.begin(), L->notes.end(), n), L->notes.end());
    }
}

// ---- chord-follow -------------------------------------------------------------------------------------------------

void DroneCore::notesChanged(const std::vector<int> &held, double when) {
  if (!cfg_.chordFollow || effectiveMode_ != "synth" || cfg_.mode != "synth" || !sounding_) return;
  const double tt = t(when);
  CallTime ct(*this, tt);
  std::vector<int> notes = held;
  std::sort(notes.begin(), notes.end());
  std::vector<int> input;
  for (int n : notes)
    if (n < kFollowSplit) input.push_back(n);
  if (!notes.empty() && std::find(input.begin(), input.end(), notes[0]) == input.end())
    input.insert(input.begin(), notes[0]);
  // Debounce by EVENT time: a change applies at t + 150 ms unless another one happens in (t, t + 150 ms]
  const unsigned seq = ++follow_.seq;
  auto ch = std::make_shared<Follow::Change>(Follow::Change{tt, seq, input});
  std::vector<std::shared_ptr<Follow::Change>> keep;
  for (const auto &c : follow_.changes)
    if (c->t > tt - 1) keep.push_back(c);
  follow_.changes = std::move(keep);
  follow_.changes.push_back(ch);
  follow_.pending = ch;
  std::weak_ptr<bool> alive = alive_;
  h_.at(tt + 0.15, [this, alive, ch, tt, seq](double t2) {
    if (alive.expired()) return;
    bool superseded = false;
    for (const auto &c : follow_.changes)
      if (c != ch && (c->t > tt ? c->t <= tt + 0.15 + 1e-9 : c->t == tt && c->seq > seq)) superseded = true;
    if (superseded || !cfg_.chordFollow) return;
    if (follow_.pending == ch) follow_.pending.reset();
    applyFollow(ch->input, t2);
  });
}

void DroneCore::applyFollow(const std::vector<int> &input, double tt) {
  std::vector<int> prevUpper;
  if (follow_.targets) prevUpper.assign(follow_.targets->begin() + 1, follow_.targets->end());
  else if (key_) prevUpper = staticVoicing(key_->pc, 0);
  const std::optional<FollowVoicing> v = followVoicing(input, prevUpper);
  if (!v) return;  // < 2 pcs -> hold
  const std::vector<int> target{v->bass, v->upper[0], v->upper[1], v->upper[2]};
  const std::vector<LayerP> old = follow_.voices;
  if (old.empty()) {
    // enter follow: static layers out 1.5 s, follow voices in 2 s
    for (const LayerP &L : std::vector<LayerP>(layers_)) fadeOutLayer(L, tt, 1.5);
    if (frozen_) {
      // lowres2: chord-follow is never frozen: the loop goes like a static layer and the reverb send reopens
      fadeOutFrozen(frozen_, tt, 1.5);
      if (sendMuted_) {
        PRef sg = prm(kDroneSendGate);
        wa::equalPowerFade(sg, 0, 0.4, tt, 1.5);
      }
      sendMuted_ = false;
    }
    std::vector<LayerP> voices;
    for (int n : target)
      if (LayerP fv = followVoice(n, tt, 2)) voices.push_back(fv);
    follow_.voices = voices;
  } else {
    std::vector<LayerP> next;
    for (std::size_t i = 0; i < target.size(); ++i) {
      const int n = target[i];
      const LayerP fv = i < old.size() ? old[i] : nullptr;
      if (!fv) {
        if (LayerP nv = followVoice(n, tt, 2)) next.push_back(nv);
        continue;
      }
      const double cur = fv->base + fv->bend;
      const double d = n - cur;
      if (std::fabs(d) <= 2 && std::abs(n - fv->base) <= 7) {
        // glide 1.2 s: pre-scheduled bend steps (linear in semitones = exponential in Hz)
        const int steps = 24;
        for (int k = 1; k <= steps; ++k)
          op(DroneOp::Bend, static_cast<unsigned>(fv->pe.slot), fv->bend + (d * k) / steps, tt + (1.2 * k) / steps);
        fv->bend = n - fv->base;
        next.push_back(fv);
      } else {
        fadeOutLayer(fv, tt, 1.5);
        if (LayerP nv = followVoice(n, tt, 2)) next.push_back(nv);
      }
    }
    follow_.voices = next;
  }
  follow_.targets = target;
}

DroneCore::LayerP DroneCore::followVoice(int note, double tt, double fade) {
  LayerP L = newLayer({note}, tt, fade, 0.7, tt, std::nullopt);
  if (!L) return nullptr;
  L->base = note;
  L->bend = 0;
  return L;
}

void DroneCore::endFollow(double tt) {
  for (const LayerP &fv : std::vector<LayerP>(follow_.voices)) fadeOutLayer(fv, tt, 1.5);
  follow_.voices.clear();
  follow_.targets.reset();
  if (key_ && effectiveMode_ == "synth" && sounding_) {
    LayerP L = newLayer(staticVoicing(key_->pc, p_.brightness), tt, 2, 0.8, tt, std::nullopt);
    if (!L) return;
    L->hasKey = true;
    L->key = *key_;
    layers_.push_back(L);
  }
}

std::vector<double> DroneCore::debugTargets() const {
  std::vector<double> out;
  if (follow_.targets)
    for (int n : *follow_.targets) out.push_back(noteToFreq(n));
  return out;
}

// ---- bend 'drone-swell', pedal swell, wheel --------------------------------------------------------------------------

void DroneCore::bendSwell(double x, double when) {
  const double tt = t(when);
  CallTime ct(*this, tt);
  const double up = x > 0 ? std::min(1.0, x) : 0.0;                  // rises toward drone.gain = 1
  const double duck = x < 0 ? 1 - 0.7 * std::min(1.0, -x) : 1.0;     // ducks to .3
  const double prevUp = bendUp_;
  bendUp_ = up;
  const double tc = up < prevUp && x >= 0 ? 3 / 4.6 : 0.12;
  if (up != prevUp || x < 0) swellLevel(tt, tc);
  if (duck != bendDuck_) {
    PRef b = prm(kParamBend);
    wa::rampTo(b, duck, tt, 0.12);
  }
  bendDuck_ = duck;
}

bool DroneCore::pedalSwell(bool on, double when) {
  if (on == pedalOn_) return false;
  const double tt = t(when);
  CallTime ct(*this, tt);
  pedalOn_ = on;
  swellLevel(tt, on ? kPedalSwellRiseTc : kPedalSwellFallTc);
  return true;
}

void DroneCore::wheel(double gain, double when, double tc) {
  CallTime ct(*this, t(when));
  PRef w = prm(kParamWheel);
  wa::rampTo(w, gain, when, tc);  // audio.js _applyWheels: rampTo(drone.wheel.gain, factor, t, tc)
}

// ---- files mode -----------------------------------------------------------------------------------------------------

int DroneCore::attachFiles(const std::vector<PadFile> &list) {
  files_.clear();
  int n = 0;
  for (const PadFile &f : list) {
    const auto k = detectKeyFromName(!f.name.empty() ? f.name : f.path);
    if (!k) continue;
    const std::string id = fileId(k->pc, k->minor);
    if (!files_.count(id)) {
      files_[id] = f;
      ++n;
    }
  }
  // files mode fell back to the synth (no pad for the key, or no pads yet): switch to the file now (REVIEW #4)
  if (cfg_.mode == "files" && effectiveMode_ != "files" && sounding_ && key_ && fileFor(key_->pc, key_->minor))
    start(*key_, 1.5, h_.now(), true);
  return n;
}

const PadFile *DroneCore::fileFor(int pc, bool minor) const {
  auto get = [&](int p, bool m) -> const PadFile * {
    auto it = files_.find(fileId(p, m));
    return it == files_.end() ? nullptr : &it->second;
  };
  if (minor) {
    if (cfg_.minorUsesRelativeMajorFile) {
      if (const PadFile *f = get(relativeMajor(pc), false)) return f;
      return get(pc, true);
    }
    if (const PadFile *f = get(pc, true)) return f;
    return get(relativeMajor(pc), false);
  }
  if (const PadFile *f = get(pc, false)) return f;
  return get(relativeMinor(pc), true);
}

void DroneCore::ensurePool() {
  while (pool_.size() < kPoolMin) addEl();
}

DroneCore::ElP DroneCore::addEl() {
  auto e = std::make_shared<El>();
  e->idx = static_cast<unsigned>(pool_.size());
  pool_.push_back(e);
  return e;
}

double DroneCore::elLevel(const El &e, double tt) const {
  return e.busy ? fadeLevelOf(e.fade ? &*e.fade : nullptr, tt, 0) : 0;
}

std::pair<DroneCore::ElP, double> DroneCore::grab() {
  ensurePool();
  for (const ElP &x : pool_)
    if (!x->busy) return {x, 0};
  if (pool_.size() < kMaxPads) return {addEl(), 0};
  const double now = h_.now();
  ElP best;
  double bl = INFINITY;
  for (const ElP &x : pool_) {
    if (x->stealing) continue;
    const double l = elLevel(*x, now);
    if (l < bl) {
      bl = l;
      best = x;
    }
  }
  if (!best) return {pool_[0], kStealFade + 0.01};
  best->seq++;  // its own timers / handlers stop acting
  best->stealing = true;
  activeEls_.erase(std::remove(activeEls_.begin(), activeEls_.end(), best), activeEls_.end());
  PRef g = prm(kParamPadGain0 + best->idx);
  wa::linFrom(g, bl, 0, now, kStealFade);
  best->fade = Fade{now, kStealFade, bl, 0, false};
  return {best, kStealFade + 0.01};
}

void DroneCore::releaseEl(const ElP &e) {
  if (e->busy && e->started && elLevel(*e, h_.now()) > 0.05) ++hardCuts_;  // an audible element cut (REVIEW #3)
  e->seq++;
  op(DroneOp::PadStop, e->idx);
  PRef g = prm(kParamPadGain0 + e->idx);
  wa::setNow(g, 0, h_.now());
  e->busy = e->pending = e->stealing = false;
  e->fade.reset();
  activeEls_.erase(std::remove(activeEls_.begin(), activeEls_.end(), e), activeEls_.end());
}

void DroneCore::fadeOutEl(const ElP &e, double tt, double fade) {
  if (e->fadingOut) return;
  if (e->pending) {  // not playing yet and silent: cancel it outright (REVIEW #2)
    releaseEl(e);
    return;
  }
  e->fadingOut = true;
  const unsigned seq = e->seq;
  const double from = fadeLevelOf(e->fade ? &*e->fade : nullptr, tt, 1);
  e->fade = Fade{tt, fade, from, 0, false};
  PRef g = prm(kParamPadGain0 + e->idx);
  wa::equalPowerFade(g, from, 0, tt, fade);
  activeEls_.erase(std::remove(activeEls_.begin(), activeEls_.end(), e), activeEls_.end());
  std::weak_ptr<bool> alive = alive_;
  h_.at(tt + fade + 0.05, [this, alive, e, seq](double) {
    if (!alive.expired() && e->seq == seq) releaseEl(e);
  });
}

std::shared_ptr<const AudioBuf> DroneCore::padBuffer(const std::string &path) const {
  auto it = padCache_.find(path);
  return it == padCache_.end() ? nullptr : it->second;
}

DroneCore::ElP DroneCore::play(const PadFile *file, double fade, double tt, std::optional<double> offset,
                               OnStarted onStarted, std::optional<double> startAt) {
  auto [e, delay] = grab();
  e->busy = true;
  const unsigned seq = ++e->seq;
  e->fadingOut = false;
  e->pending = true;
  e->started = false;
  e->fileCopy = *file;
  e->file = &e->fileCopy;
  if (std::find(activeEls_.begin(), activeEls_.end(), e) == activeEls_.end()) activeEls_.push_back(e);
  std::weak_ptr<bool> alive = alive_;
  auto begin = [this, alive, e, seq, fade, tt, offset, onStarted, startAt](std::shared_ptr<const AudioBuf> buf) {
    if (alive.expired() || e->seq != seq) return;
    if (!buf) {
      warnOnce("err|" + e->fileCopy.path, "Pad file failed to load: " + e->fileCopy.name);
      return;
    }
    const std::string &path = e->fileCopy.path;
    if (!padCache_.count(path)) {
      padCache_[path] = buf;
      padLru_.push_back(path);
      while (padLru_.size() > 3) {  // the playing pads hold their own references
        padCache_.erase(padLru_.front());
        padLru_.erase(padLru_.begin());
      }
    }
    const LoopRegion r = loopRegion(buf->seconds());
    e->region = Region{r.loop, r.ls, r.le, r.xf};
    double pos;
    if (offset) {
      pos = *offset;
    } else {  // random start, far enough from the loop end that no loop crossfade starts during the fade-in
      pos = r.loop ? 0 : r.ls + rng_.next() * std::max(0.0, r.le - r.xf - fade - 2 - r.ls);
    }
    const double now = h_.now();
    const double st = startAt ? std::max(*startAt, now) : now;
    auto ref = new BufRef;
    ref->buf = buf;
    opOwned(DroneOp::PadStart, e->idx, ref, st, std::max(0.0, pos), r.loop ? 1 : 0);
    e->t0 = st;
    e->off = std::max(0.0, pos);
    // `playing`
    e->started = true;
    e->pending = false;
    if (onStarted) onStarted(e, st);
    else fadeInEl(e, std::max(st, tt), fade);
  };
  auto go = [this, alive, e, seq, begin](double) {
    if (alive.expired() || e->seq != seq) return;
    if (e->stealing) {
      op(DroneOp::PadStop, e->idx);
      e->stealing = false;
    }
    PRef g = prm(kParamPadGain0 + e->idx);
    wa::setNow(g, 0, h_.now());
    e->fade.reset();
    if (auto cached = padBuffer(e->fileCopy.path)) {
      begin(cached);
      return;
    }
    h_.decodePad(e->fileCopy.path, begin);
  };
  if (delay > 0) h_.at(h_.now() + delay, go);
  else go(h_.now());
  return e;
}

void DroneCore::fadeInEl(const ElP &e, double tt, double fade) {
  e->pending = false;
  const double from = fadeLevelOf(e->fade ? &*e->fade : nullptr, tt, 0);
  e->fade = Fade{tt, fade, from, 1, false};
  PRef g = prm(kParamPadGain0 + e->idx);
  wa::equalPowerFade(g, from, 1, tt, fade);
  if (std::find(activeEls_.begin(), activeEls_.end(), e) == activeEls_.end()) activeEls_.push_back(e);
  if (!e->region.loop) scheduleLoop(e, tt);
}

void DroneCore::scheduleLoop(const ElP &e, double tt) {
  // Loop crossfade: the incoming player starts at the loop start exactly when the crossfade begins (equal-power
  // over region.xf). drone.js pre-rolls an <audio> element 1.5 s ahead and resyncs against the media clock; a
  // decoded buffer needs neither.
  const unsigned seq = e->seq;
  const Region r = e->region;
  const double xfAt = e->t0 + (r.le - r.xf - e->off);
  std::weak_ptr<bool> alive = alive_;
  h_.at(std::max(tt, xfAt - 1.5), [this, alive, e, seq, r, xfAt](double) {
    if (alive.expired() || e->seq != seq) return;
    if (std::find(activeEls_.begin(), activeEls_.end(), e) == activeEls_.end()) return;
    const double startAt = std::max(h_.now(), xfAt);
    play(
        e->file, r.xf, startAt, r.ls,
        [this, e, seq, startAt, r](const ElP &inc, double now) {
          if (e->seq != seq || std::find(activeEls_.begin(), activeEls_.end(), e) == activeEls_.end()) {
            releaseEl(inc);
            return;
          }
          const double at = std::max(now, startAt);
          fadeOutEl(e, at, r.xf);
          fadeInEl(inc, at, r.xf);
        },
        startAt);
  });
}

void DroneCore::filesTo(const PadFile *file, double fade, double tt) {
  h_.wake();
  play(file, fade, tt, std::nullopt, nullptr);
}

// ---- frozen loop (low-resource mode; lowres2) -----------------------------------------------------------------------

bool DroneCore::setFrozen(bool on, double when) {
  if (on == freezeOn_) return on;
  CallTime ct(*this, t(when));
  freezeOn_ = on;
  fz_.immediate = on;  // the first freeze does not wait for the debounce
  freezeUpdate(t(when));
  armFreezePoll();
  return on;
}

void DroneCore::setFreezeOptions(double loopSec, double debounceSec, double prerollSec) {
  if (std::isfinite(loopSec) && loopSec > 0) fz_.loopSec = loopSec;
  if (std::isfinite(prerollSec) && prerollSec >= 0) fz_.prerollSec = prerollSec;
  if (std::isfinite(debounceSec) && debounceSec >= 0) fz_.debounce = debounceSec;
}

void DroneCore::armFreezePoll() {
  // audio.js _pollFx: freezeTick every FX_IDLE_POLL_SEC while the drone freezes or is frozen (realtime)
  if (pollArmed_ || h_.offline() || !(freezeOn_ || frozen_)) return;
  pollArmed_ = true;
  std::weak_ptr<bool> alive = alive_;
  h_.at(h_.now() + kFxIdlePollSec, [this, alive](double t2) {
    if (alive.expired()) return;
    pollArmed_ = false;
    freezeTick(t2);
    armFreezePoll();
  });
}

void DroneCore::freezeTick(double tt) {
  if (freezeOn_ || frozen_) freezeUpdate(t(tt));
}

bool DroneCore::freezable() const {
  return freezeOn_ && !h_.offline() && !disposed_ && sounding_ && !parked_ && cfg_.mode == "synth" &&
         effectiveMode_ == "synth" && !cfg_.chordFollow && follow_.voices.empty() && key_.has_value();
}

DroneCore::Sig DroneCore::freezeSig() {
  const FreezeEnv env = h_.freezeEnv();
  Sig s;
  s.pc = key_->pc;
  s.minor = key_->minor;
  s.brightness = p_.brightness;
  s.movement = p_.movement;
  s.width = p_.width;
  s.trimDb = trimDb_;
  s.irKey = env.hasIr ? env.irKey : std::string();
  s.predelay = env.hasIr ? env.predelay : 0;
  s.wet = env.hasIr && std::isfinite(env.wet) ? env.wet : 0;
  s.env = env;
  return s;
}

bool DroneCore::sigSame(const Sig *a, const Sig *b) {
  if (!a || !b) return false;
  if (a->pc != b->pc || a->minor != b->minor || a->brightness != b->brightness || a->movement != b->movement ||
      a->width != b->width || a->trimDb != b->trimDb || a->irKey != b->irKey || a->predelay != b->predelay)
    return false;
  if (a->wet <= 0 || b->wet <= 0) return a->wet <= 0 && b->wet <= 0;
  return std::fabs(20 * js::log10(a->wet / b->wet)) <= kFreezeWetTolDb;
}

void DroneCore::freezeInvalidate() {
  fz_.seq++;  // a pending render timer sees another seq (the JS S.cancel())
  fz_.pendingSig.reset();
}

void DroneCore::freezeUpdate(double tt) {
  if (!freezable()) {
    if (fz_.pendingSig) freezeInvalidate();
    // low-resource ended / chord-follow turned on while frozen: back to the live synth
    if (frozen_ && sounding_ && !parked_ && cfg_.mode != "off") thaw(tt);
    return;
  }
  const Sig sig = freezeSig();
  if (frozen_ && sigSame(&frozen_->sig, &sig)) {
    if (fz_.pendingSig) freezeInvalidate();  // changed and changed back
    return;
  }
  if (!frozen_) {
    // lowres2-critic #2: back on before a thaw's crossfade began: keep the loop
    for (const FrozenP &x : fzOut_)
      if (x->thawAt > tt && x->fade.t > tt && sigSame(&x->sig, &sig)) {
        unthaw(x, tt);
        return;
      }
  }
  if (fz_.pendingSig && sigSame(&*fz_.pendingSig, &sig)) return;  // already waiting / rendering for this
  freezeInvalidate();
  fz_.pendingSig = sig;
  double delay = fz_.immediate ? 0 : fz_.debounce;
  if (!frozen_) {
    for (const LayerP &L : layers_)  // lowres2-critic R1 / #2: freeze once the layers and their attacks settled
      if (!L->dead)
        delay = std::max({delay, L->fade.t + L->fade.dur - tt + 0.25, L->voiceT + L->attack - tt + 0.25});
  }
  fz_.immediate = false;
  const unsigned seq = fz_.seq;
  std::weak_ptr<bool> alive = alive_;
  h_.at(tt + delay, [this, alive, seq](double) {
    if (!alive.expired()) freezeRender(seq);
  });
}

void DroneCore::freezeRender(unsigned seq) {
  if (seq != fz_.seq || !freezable()) return;
  const Sig sig = freezeSig();
  fz_.pendingSig = sig;
  char optsBuf[64];
  std::snprintf(optsBuf, sizeof optsBuf, "%.17g|%.17g", fz_.loopSec, fz_.prerollSec ? *fz_.prerollSec : -1.0);
  const std::string opts = optsBuf;
  if (fz_.last && sigSame(&fz_.last->sig, &sig) && fz_.last->opts == opts) {
    fz_.pendingSig.reset();  // lowres2-critic #2: the kept loop swaps back in without rendering again
    fz_.reused++;
    freezeSwap(fz_.last->res, fz_.last->sig, h_.now() + 0.02);
    return;
  }
  if (fz_.rendering) {  // one render at a time: this request runs when that one ends
    fz_.rerunSeq = seq;
    return;
  }
  fz_.rendering = true;
  LoopRequest req;
  req.seed = h_.seed();
  req.sampleRate = h_.sampleRate();
  req.pc = sig.pc;
  req.minor = sig.minor;
  req.brightness = sig.brightness;
  req.movement = sig.movement;
  req.width = sig.width;
  req.trimDb = sig.trimDb;
  req.reverb = sig.env;
  req.reverb.hasIr = sig.env.hasIr && sig.wet > 0;
  req.loopSec = fz_.loopSec;
  if (fz_.prerollSec) req.prerollSec = *fz_.prerollSec;
  std::weak_ptr<bool> alive = alive_;
  h_.renderLoop(req, [this, alive, seq, sig, opts](LoopResult res) {
    if (alive.expired()) return;
    fz_.rendering = false;
    if (!res.error.empty()) {
      fz_.rerunSeq.reset();
      fz_.lastError = res.error;  // pendingSig stays: no retry until what the loop bakes in changes
      warnOnce("freeze|" + res.error, "Could not freeze the drone (" + res.error + "); it keeps playing live.");
      return;
    }
    if (disposed_) return;
    fz_.last = Fz::Last{sig, res, opts};
    if (fz_.rerunSeq) {
      const unsigned rs = *fz_.rerunSeq;
      fz_.rerunSeq.reset();
      if (rs == fz_.seq) {
        freezeRender(rs);
        return;
      }
    }
    if (seq != fz_.seq || !freezable()) return;  // superseded: the newer change renders again
    fz_.pendingSig.reset();
    fz_.renders++;
    fz_.lastRenderMs = std::round(res.renderMs);
    if (!res.seamOk) {
      char b[160];
      std::snprintf(b, sizeof b, "Frozen drone loop seam step %g > body %g", res.seamDelta, res.bodyDelta);
      warnOnce("freeze-seam", b);
    }
    freezeSwap(res, sig, h_.now() + 0.02);
  });
}

int DroneCore::freeLoopSlot() const {
  bool used[kMaxLoops] = {};
  if (frozen_ && frozen_->loop >= 0) used[frozen_->loop] = true;
  for (const FrozenP &f : fzOut_)
    if (f->loop >= 0) used[f->loop] = true;
  for (unsigned i = 0; i < kMaxLoops; ++i)
    if (!used[i]) return static_cast<int>(i);
  return -1;
}

void DroneCore::freezeSwap(const LoopResult &res, const Sig &sig, double tt) {
  if (!res.buffer) return;
  int loop = freeLoopSlot();
  if (loop < 0 && !fzOut_.empty()) {  // the oldest loop still fading out goes now (bounded players)
    const FrozenP old = fzOut_.front();
    disposeFrozen(old);
    loop = freeLoopSlot();
  }
  if (loop < 0) return;
  // lowres2-critic #1: a re-render of the same voicing starts in step with the playing loop, crossfaded linearly
  const FrozenP prev = frozen_;
  const bool aligned = prev && prev->sig.pc == sig.pc && prev->sig.minor == sig.minor &&
                       (prev->sig.brightness > 0.6) == (sig.brightness > 0.6) &&
                       std::fabs(prev->loopSec - res.loopSec) < 1e-6;
  double offset = 0;
  if (aligned) {
    offset = std::fmod(tt - prev->t0, prev->loopSec);
    if (offset < 0) offset += prev->loopSec;
    if (!(offset < res.buffer->seconds())) offset = 0;
  }
  auto ref = new BufRef;
  ref->buf = res.buffer;
  opOwned(DroneOp::LoopStart, static_cast<unsigned>(loop), ref, tt, offset);
  PRef g = prm(kParamLoopGain0 + static_cast<unsigned>(loop));
  if (aligned) wa::linFrom(g, 0, 1, tt, kFreezeSwapSec);
  else wa::equalPowerFade(g, 0, 1, tt, kFreezeSwapSec);
  auto fz = std::make_shared<Frozen>();
  fz->loop = loop;
  fz->sig = sig;
  fz->t0 = tt - offset;
  fz->fade = Fade{tt, kFreezeSwapSec, 0, 1, aligned};
  fz->loopSec = res.loopSec;
  fz->bytes = res.bytes;
  fz->renderMs = std::round(res.renderMs);
  fz->seamDelta = res.seamDelta;
  fz->bodyDelta = res.bodyDelta;
  fz->seamOk = res.seamOk;
  fz->buf = res.buffer;
  if (prev) {
    fadeOutFrozen(prev, tt, kFreezeSwapSec, aligned);
  } else {
    for (const LayerP &L : std::vector<LayerP>(layers_)) fadeOutLayer(L, tt, kFreezeSwapSec);
    if (!sendMuted_) {
      PRef sg = prm(kDroneSendGate);
      wa::equalPowerFade(sg, 0.4, 0, tt, kFreezeSwapSec);
    }
    sendMuted_ = true;
  }
  frozen_ = fz;
  armFreezePoll();
}

void DroneCore::fadeOutFrozen(const FrozenP &fz, double tt, double fade, bool lin) {
  const double from = fadeLevelOf(&fz->fade, tt, 1);
  fz->dead = true;
  fz->thawAt = 0;  // _thaw marks its own fade after this call
  fz->fade = Fade{tt, fade, from, 0, lin};
  PRef g = prm(kParamLoopGain0 + static_cast<unsigned>(fz->loop));
  if (lin) wa::linFrom(g, from, 0, tt, fade);
  else wa::equalPowerFade(g, from, 0, tt, fade);
  if (frozen_ == fz) frozen_.reset();
  if (std::find(fzOut_.begin(), fzOut_.end(), fz) == fzOut_.end()) fzOut_.push_back(fz);
  const double end = tt + fade + 0.05;
  fz->end = end;
  std::weak_ptr<bool> alive = alive_;
  h_.at(end, [this, alive, fz, end](double) {
    if (alive.expired() || !fz->end || *fz->end != end) return;  // re-scheduled (an earlier fade replaced this one)
    disposeFrozen(fz);
  });
}

void DroneCore::disposeFrozen(const FrozenP &fz) {
  fzOut_.erase(std::remove(fzOut_.begin(), fzOut_.end(), fz), fzOut_.end());
  if (fz->loop >= 0) op(DroneOp::LoopStop, static_cast<unsigned>(fz->loop));
  fz->loop = -1;
  fz->buf.reset();
}

double DroneCore::thawLead() const {
  return std::max(kFreezeThawLeadSec, voiceAttack() + kThawSettleSec);
}

void DroneCore::thaw(double tt) {
  const FrozenP fz = frozen_;
  if (!fz || !key_) return;
  const double at = tt + thawLead();
  if (follow_.voices.empty()) {
    LayerP L = newLayer(staticVoicing(key_->pc, p_.brightness), tt, kFreezeSwapSec, 0.8, at, std::nullopt);
    if (L) {
      L->hasKey = true;
      L->key = *key_;
      layers_.push_back(L);
    }
  }
  const bool inFull = fadeLevelOf(&fz->fade, tt, 1) >= 0.999 && fz->fade.to == 1;  // not still fading in
  fadeOutFrozen(fz, at, kFreezeSwapSec);
  fz->thawAt = inFull ? at : 0;  // _unthaw may keep it until then (at level 1)
  if (sendMuted_) {
    PRef sg = prm(kDroneSendGate);
    wa::setNow(sg, 0, tt);
    wa::equalPowerFade(sg, 0, 0.4, at, kFreezeSwapSec);
    sendMuted_ = false;
  }
}

void DroneCore::unthaw(const FrozenP &fz, double tt) {
  freezeInvalidate();
  fz_.immediate = false;
  fz_.reused++;
  fzOut_.erase(std::remove(fzOut_.begin(), fzOut_.end(), fz), fzOut_.end());
  fz->thawAt = 0;
  fz->dead = false;
  fz->end.reset();  // the pending dispose no longer matches
  PRef g = prm(kParamLoopGain0 + static_cast<unsigned>(fz->loop));
  wa::setNow(g, 1, tt);
  fz->fade = Fade{tt, 0, 1, 1, false};
  frozen_ = fz;
  for (const LayerP &L : std::vector<LayerP>(layers_)) fadeOutLayer(L, tt, 0.05);
  PRef sg = prm(kDroneSendGate);
  wa::setNow(sg, 0, tt);
  sendMuted_ = true;
}

void DroneCore::playLoopTest(const LoopRequest &req, double when) {
  const double tt = t(when);
  CallTime ct(*this, tt);
  LoopResult res = renderDroneLoop(req);
  if (!res.buffer) return;
  auto ref = new BufRef;
  ref->buf = res.buffer;
  opOwned(DroneOp::LoopStart, 0, ref, tt, 0);
  PRef g = prm(kParamLoopGain0), lv = prm(kDroneLevel), sg = prm(kDroneSendGate);
  wa::setNow(g, 1, tt);
  wa::setNow(lv, 1, tt);  // unit level: the fixture compares the loop itself
  wa::setNow(sg, 0, tt);
}

void DroneCore::rateChanged(double sampleRate) {
  // T11a O4: PeriodicWaves are per rate: every drone-osc gets the new rate's bank (the unit already took the rate)
  for (unsigned s = 0; s < kMaxInst; ++s) {
    if (!slotUsed_[s]) continue;
    auto *w = new inst::WavesPayload;
    w->bank = inst::WaveBank::get(sampleRate, inst::synthWaveFamilies("drone-osc"));
    opOwned(DroneOp::InstWaves, s, w);
  }
  padCache_.clear();  // decoded at the old rate (playing pads keep theirs: BufferSource resamples them)
  padLru_.clear();
  fz_.last.reset();  // a kept loop is at the old rate
}

std::vector<DroneCore::ElInfo> DroneCore::pool() const {
  std::vector<ElInfo> out;
  for (const ElP &e : pool_) out.push_back(ElInfo{e->idx, e->busy, e->started, e->fileCopy.name});
  return out;
}

std::string DroneCore::freezeStatsJson() const {
  std::size_t bytes = frozen_ ? frozen_->bytes : 0;
  for (const FrozenP &x : fzOut_) bytes += x->bytes;
  if (fz_.last && fz_.last->res.buffer) {
    bool held = frozen_ && frozen_->buf == fz_.last->res.buffer;
    for (const FrozenP &x : fzOut_) held = held || x->buf == fz_.last->res.buffer;
    if (!held) bytes += fz_.last->res.bytes;
  }
  std::string out;
  char b[512];
  const double mb = std::round(static_cast<double>(bytes) / 1048576.0 * 10) / 10;
  std::string seam = "null";
  if (frozen_) {
    std::snprintf(b, sizeof b, "{\"seamDelta\":%.9g,\"bodyDelta\":%.9g,\"ok\":%s}", frozen_->seamDelta,
                  frozen_->bodyDelta, frozen_->seamOk ? "true" : "false");
    seam = b;
  }
  std::string loopSec = "null";
  if (frozen_) {
    std::snprintf(b, sizeof b, "%.10g", std::round(frozen_->loopSec * 1000) / 1000);
    loopSec = b;
  }
  std::string renderMs = "null";
  if (fz_.lastRenderMs) {
    std::snprintf(b, sizeof b, "%.10g", *fz_.lastRenderMs);
    renderMs = b;
  }
  std::snprintf(b, sizeof b,
                "\"droneFrozen\":%s,\"droneLoopSec\":%s,\"droneRenderMs\":%s,\"droneRenders\":%u,"
                "\"droneFreezeMB\":%.10g,\"droneSeam\":%s,\"droneFreezePending\":%s,\"droneFreezeReused\":%u,"
                "\"droneRenderMaxStepMs\":null",
                frozen_ ? "true" : "false", loopSec.c_str(), renderMs.c_str(), fz_.renders, mb, seam.c_str(),
                fz_.pendingSig ? "true" : "false", fz_.reused);
  out = b;
  return out;
}

std::string DroneCore::stateJson() const {
  JsonOut j;
  j.begin();
  j.kv("mode", cfg_.mode);
  j.kvBool("chordFollow", cfg_.chordFollow);
  j.kvBool("continueAcrossSongs", cfg_.continueAcrossSongs);
  j.kvBool("minorUsesRelativeMajorFile", cfg_.minorUsesRelativeMajorFile);
  if (key_) {
    j.key("key").begin().kv("pc", key_->pc).kvBool("minor", key_->minor).end();
  } else {
    j.kvRaw("key", "null");
  }
  j.key("params")
      .begin()
      .kv("gain", p_.gain)
      .kv("brightness", p_.brightness)
      .kv("movement", p_.movement)
      .kv("width", p_.width)
      .kv("fade", p_.fade)
      .end();
  j.end();
  return j.take();
}

}  // namespace rig::drone
