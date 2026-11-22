// Frozen drone for low-resource mode (app/js/engine/drone-freeze.js, lowres2; T16, DECISIONS D5): the offline loop
// render and the seam pieces. renderDroneLoop runs a private DroneCore + DroneUnit (+ the reverb chain of fx.js
// Reverb: HPF 180 -> LPF 9 k -> predelay -> the live IR -> return, T04's ReverbUnit) through a quantum loop that
// behaves like an OfflineAudioContext with AudioTimer (timers at quantum boundaries, then the quantum renders). It
// allocates and takes ~the drone's realtime cost for its length: callers run it on a worker, never the audio thread.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

#include "drone/drone_core.h"
#include "fx/reverb_unit.h"
#include "num/js_math.h"
#include "runtime/rt_guard.h"
#include "time/timer.h"

namespace rig::drone {

std::size_t freezeLoopFrames(double sr, double loopSec) {
  const double ls = std::isfinite(loopSec) && loopSec != 0 ? loopSec : kFreezeLoopSec;
  const double sec = std::min(30.0, std::max(1.0, ls));
  return std::min(static_cast<std::size_t>(std::llround(sec * sr)), kFreezeMaxBytes / 8);
}

double seamCorrelation(const float *c, std::size_t start, std::size_t loopLen, std::size_t n) {
  double hh = 0, tt = 0, ht = 0;
  for (std::size_t i = 0; i < n; ++i) {
    const double h = c[start + i];
    const double t = c[start + loopLen + i];
    hh += h * h;
    tt += t * t;
    ht += h * t;
  }
  if (!(hh > 0 && tt > 0)) return 0;
  return std::min(1.0, std::max(-0.9, ht / std::sqrt(hh * tt)));
}

void makeSeamlessLoop(float *c, std::size_t start, std::size_t loopLen, std::size_t xf) {
  const std::size_t n = std::min(xf, loopLen / 2);
  const double w = n > 0 ? (js::kPi / 2) / static_cast<double>(n) : 0;
  const double rho = seamCorrelation(c, start, loopLen, n);
  for (std::size_t i = 0; i < n; ++i) {
    const double x = static_cast<double>(i) * w;
    const double g = 1 / std::sqrt(1 + rho * js::sin(2 * x));
    const double head = c[start + i], tail = c[start + loopLen + i];
    c[start + i] = static_cast<float>((head * js::sin(x) + tail * js::cos(x)) * g);
  }
}

SeamCheck seamCheck(const float *const *chans, unsigned nch, std::size_t n) {
  SeamCheck r;
  for (unsigned k = 0; k < nch; ++k) {
    const float *c = chans[k];
    if (n < 2) continue;
    r.seamDelta = std::max(r.seamDelta, std::fabs(static_cast<double>(c[0]) - static_cast<double>(c[n - 1])));
    for (std::size_t i = 1; i < n; ++i) {
      const double d = std::fabs(static_cast<double>(c[i]) - static_cast<double>(c[i - 1]));
      if (d > r.bodyDelta) r.bodyDelta = d;
    }
  }
  r.ok = r.seamDelta <= r.bodyDelta;
  return r;
}

namespace {

/** The OfflineAudioContext + AudioTimer of renderDroneLoop: commands apply at the next quantum, timers fire at their
 *  quantum boundary before it renders. */
class OfflineHost final : public DroneHost {
 public:
  OfflineHost(double sr, std::uint32_t seed) : sr_(sr), seed_(seed) {}
  double now() const override { return static_cast<double>(frame_) / sr_; }
  double sampleRate() const override { return sr_; }
  std::uint32_t seed() const override { return seed_; }
  bool offline() const override { return true; }
  void send(Command c, double when) override {
    const std::int64_t f = std::isfinite(when) && when >= 0 ? static_cast<std::int64_t>(std::llround(when * sr_)) : 0;
    c.frame = f > frame_ ? f : frame_;
    c.seq = ++seq_;
    pending_.push_back(c);
  }
  void at(double t, std::function<void(double)> fn) override { timers_.at(t, sr_, std::move(fn)); }
  void warn(const std::string &) override {}
  void renderLoop(const LoopRequest &, std::function<void(LoopResult)> done) override {
    LoopResult r;
    r.error = "nested freeze render";
    done(r);
  }

  /** Graph::drainCommands + the heap: everything due before the end of the quantum at frame_, by (frame, seq). */
  void applyPending(DroneUnit &u) {
    std::stable_sort(pending_.begin(), pending_.end(), [](const Command &a, const Command &b) {
      return a.frame != b.frame ? a.frame < b.frame : a.seq < b.seq;
    });
    const std::int64_t end = frame_ + static_cast<std::int64_t>(kQ);
    std::size_t n = 0;
    while (n < pending_.size() && pending_[n].frame < end) u.apply(pending_[n++]);
    pending_.erase(pending_.begin(), pending_.begin() + static_cast<long>(n));
  }
  std::int64_t frame_ = 0;
  TimerQueue timers_;

 private:
  double sr_;
  std::uint32_t seed_;
  std::vector<Command> pending_;
  std::uint32_t seq_ = 0;
};

class NullEvents final : public EventSink {
 public:
  bool push(const AudioEvent &e) override {
    if (e.kind == EventKind::Garbage) garbage.push_back(e);
    return true;
  }
  std::vector<AudioEvent> garbage;
};

void freeGarbageEvents(std::vector<AudioEvent> &g) {
  for (const AudioEvent &e : g)
    if (static_cast<GarbageKind>(e.aux) == GarbageKind::Owned) delete static_cast<Owned *>(e.ptr);
  g.clear();
}

}  // namespace

LoopResult renderDroneLoop(const LoopRequest &req) {
  const auto t0 = std::chrono::steady_clock::now();
  LoopResult res;
  const double sr = req.sampleRate;
  const std::size_t loopLen = freezeLoopFrames(sr, req.loopSec);
  const std::size_t xf = std::min(static_cast<std::size_t>(std::llround(req.seamSec * sr)), loopLen / 2);
  const std::size_t pre = static_cast<std::size_t>(std::llround(req.prerollSec * sr));
  const std::size_t total = pre + loopLen + xf;

  OfflineHost host(sr, req.seed);
  std::unique_ptr<fx::ReverbUnit> rv;
  const FreezeEnv &rvEnv = req.reverb;
  if (rvEnv.hasIr && rvEnv.wet > 0) {
    auto kernel = fx::ReverbKernel::build(sr, req.seed, rvEnv.size, rvEnv.damp);
    rv = std::make_unique<fx::ReverbUnit>(sr, rvEnv.wet);
    // drone-freeze.js: new GainNode(off, {gain: wet}) (the unit's constructor ramps to its return gain from 1)
    if (wa::Param *ret = rv->param(kReverbReturnGain)) wa::setNow(*ret, rvEnv.wet, 0);
    auto *cu = new fx::ConvUnit(kernel, sr);
    cu->slot = 0;
    cu->when = 0;
    cu->fade = 0;
    cu->predelay = std::min(0.5, std::max(0.0, std::isfinite(rvEnv.predelay) ? rvEnv.predelay : 0.0));
    rv->installInitial(cu);
  }
  {
    std::string name = "drone-freeze|" + std::to_string(req.pc) + "|" + (req.minor ? "1" : "0");
    DroneCore d(host, rngFor(req.seed, name));
    // the same Drone class at unit level (gain 1, no wheel / swell); d.setTrim(o.trimDb) at 0
    DroneUnit unit(sr, d.unitInit(req.trimDb));
    DroneCore::Config cfg;
    cfg.gain = 1;
    cfg.brightness = req.brightness;
    cfg.movement = req.movement;
    cfg.width = req.width;
    cfg.fade = 0.05;
    cfg.chordFollow = false;
    d.configure(cfg, 0);
    d.setKey(req.pc, req.minor, NAN, 0);
    d.setMode("synth", 0);

    std::vector<float> out[2];
    out[0].assign(total, 0.0f);
    out[1].assign(total, 0.0f);
    NullEvents events;
    events.garbage.reserve(256);  // pushed inside the render scope below: no allocation there
    Bus droneOut, send, rvOut;
    const std::size_t quanta = (total + kQ - 1) / kQ;
    for (std::size_t q = 0; q < quanta; ++q) {
      const std::int64_t f0 = static_cast<std::int64_t>(q * kQ);
      host.frame_ = f0;
      host.timers_.runDue(static_cast<std::int64_t>(q));
      host.applyPending(unit);
      RenderContext ctx{f0, sr, q, UnitSlot::Drone, &events};
      send.clear(2);
      UnitIO io;
      io.out = &droneOut;
      io.sends[kSendReverb] = &send;
      {
        // T04 review finding 2: every direct caller of Unit::process renders under FTZ/DAZ (as Chromium's offline
        // rendering thread does); the scope also arms the tests' allocation trap for the unit's render path
        rt::RenderScope scope;
        unit.process(ctx, io);
        if (rv) {
          UnitIO rio;
          rio.in = &send;
          rio.out = &rvOut;
          ctx.self = UnitSlot::Reverb;
          rv->process(ctx, rio);
        }
      }
      const std::size_t n = std::min<std::size_t>(kQ, total - q * kQ);
      for (std::size_t i = 0; i < n; ++i) {
        // sum = drone.out + ret (two inputs: the order does not matter)
        out[0][q * kQ + i] = rv ? droneOut.ch[0][i] + rvOut.ch[0][i] : droneOut.ch[0][i];
        out[1][q * kQ + i] = rv ? droneOut.ch[1][i] + rvOut.ch[1][i] : droneOut.ch[1][i];
      }
      freeGarbageEvents(events.garbage);
    }
    host.frame_ = static_cast<std::int64_t>(quanta * kQ);
    host.applyPending(unit);
    res.renderMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    auto buf = std::make_shared<AudioBuf>();
    for (int c = 0; c < 2; ++c) {
      makeSeamlessLoop(out[c].data(), pre, loopLen, xf);
      buf->data[c].assign(out[c].begin() + static_cast<long>(pre), out[c].begin() + static_cast<long>(pre + loopLen));
    }
    buf->seal(sr);
    const float *ch[2] = {buf->data[0].data(), buf->data[1].data()};
    const SeamCheck sc = seamCheck(ch, 2, loopLen);
    res.seamDelta = sc.seamDelta;
    res.bodyDelta = sc.bodyDelta;
    res.seamOk = sc.ok;
    res.loopSec = static_cast<double>(loopLen) / sr;
    res.bytes = loopLen * 8;
    res.buffer = std::move(buf);
  }
  return res;
}

}  // namespace rig::drone
