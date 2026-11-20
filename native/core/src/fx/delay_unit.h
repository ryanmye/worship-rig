// T05 internals of the echo (kind "delay", fx/delay.h): the render object and its control-side helpers. Used by
// fx/delay.cpp, fx/delay_register.cpp and tests/test_delay.cpp.
//
// Ports fx.js Delay/DelayLine (fx.js:1124-1335) node for node, so the render equals Chromium's sample by sample:
//   io.in -> line[k]: gate -> pre DelayNode (Q = 128/sr) -> split -> in-matrix (inLL, inRL -> L; inRR -> R) -> d
//            (stereo DelayNode, max 2 s, delayTime = time - Q) -> tone LPF (Butterworth) -> { out gain -> ret ;
//            split -> fbLL/fbRL -> L, fbRR/fbLR -> R -> d }
//   sum of both lines -> ret (returnGain, param 0) -> wheel (param 3, unity unless a macro drives it) -> io.out
// The feedback cycle is rendered exactly as Chromium pulls it: the LPF is pulled by `out` first, so the feedback
// gains read the LPF output of the PREVIOUS quantum (one 128-frame block, which is why the JS puts Q in front).
// Echo k therefore lands at exactly k * time (contract 3.5, Q9), with Chromium's float read positions.
//
// Line switching (time change > 5 %), glides (<= 5 %), the flush of a busy line and the ring-out/flush timers of the
// old line run on the audio thread: timers fire before the first quantum k with k*128 >= t*sr (AudioTimer's offline
// semantics, time/timer.h) and receive max(t, k*128/sr). Panic = Delay.panic.
#pragma once
#include <cstddef>
#include <cstdint>

#include "dsp/biquad.h"
#include "fx/delay.h"
#include "fx/delay_node.h"
#include "graph/unit.h"
#include "time/param.h"

namespace rig {
struct DelayPatch;
class Model;
}  // namespace rig

namespace rig::fx {

/** Audio-side commands (DelayOp, fx/delay.h). Every op carries `when` (engine seconds) in f.e.
 *  SetTime:     a = effective seconds (sync resolved, clamped .02..1.9) -> updateTime
 *  SetPingPong: aux = 0/1 -> applyAll with the unit's other values (JS setParam 'pingpong')
 *  Panic:       Delay.panic(when)
 *  SetFeedback: a = effective feedback, b = time constant (0 = TAU) -> active.setFeedback (feedback row, wash)
 *  ApplyAll:    a = effective seconds, b = feedback, c = tone (0..1), aux = pingpong -> applyAll (commit, tone)
 *  Return gain goes through Model::moveParam(kDelayReturnGain) (rampTo, tau 15 ms). */

/** Delay.effectiveTime: sync with a tempo -> beat * {1/4: 1, 1/8d: .75, 1/8: .5}, else time; clamp .02..1.9. */
double delayEffectiveTime(const DelayPatch &p, double tempo);
/** 1200 * 10^clamp(tone, 0, 1) (JS Math.pow). */
double delayToneHz(double tone);

class DelayUnit final : public Unit {
 public:
  static constexpr double kMaxTime = 2.0;  // d maxDelayTime
  static constexpr double kPreMax = 0.02;  // pre maxDelayTime

  /** Delay constructor + applyAll(0) of the start-up patch (audio.js _build -> _applyFx(init)). */
  DelayUnit(double sampleRate, const DelayPatch &p, double tempo);

  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override;
  std::uint32_t liveVoices() const override { return quietQuanta_ < kQuietAfter ? 1u : 0u; }

  // audio-side entry points (also used by the tests directly)
  void updateTime(double t, double when);
  void applyAll(double time, double fb, double tone, bool pp, double when);
  void setFeedback(double fb, double when, double tc);
  void panic(double when);

  /** Test/bench introspection. */
  unsigned activeLine() const { return active_; }
  const char *lineState(unsigned i) const;
  double lineTime(unsigned i) const { return lines_[i].time; }

 private:
  enum class State : std::uint8_t { Idle, Active, Ringing, Flushing };
  struct Line {
    wa::Param gate{0.0}, inLL{1.0}, inRR{1.0}, inRL{0.0};
    wa::Param dTime{0.375, 0.0f, static_cast<float>(kMaxTime)};
    wa::Param lpFreq{5000.0};
    wa::Param fbLL{0.0}, fbRR{0.0}, fbLR{0.0}, fbRL{0.0};
    wa::Param out{0.0};
    DelayNodeKernel pre, d;
    wa::Biquad lp[2];
    float lpPrev[2][kQ] = {};  // the LPF output bus of the previous quantum (what the cycle reads)
    double time = 0.375;
    struct Glide {
      double t0 = 0, dur = 0, from = 0, to = 0;
      bool set = false;
    } tg;
    State state = State::Idle;
    double idleAt = 0;
    std::uint32_t seq = 0;
    std::size_t silentFrames = 0;  // d input all-zero run (skip the kernels once the buffer is all zeros)
    bool lpZero = true;

    void setFeedback(double fb, bool pp, double when, double tc);
    void setPingpong(bool pp, double when);
    void setTimeNow(double t, double when, double q);
    double timeAt(double when) const;
    void glideTime(double t, double when, double q);
  };
  enum class TimerKind : std::uint8_t { None, SwitchRetry, RingEnd, FlushEnd };
  struct Timer {
    double t = 0;
    std::int64_t quantum = 0;
    TimerKind kind = TimerKind::None;
    unsigned line = 0;
    std::uint32_t seq = 0;
    std::uint64_t order = 0;
  };
  static constexpr std::size_t kTimers = 16;
  static constexpr std::size_t kQuietAfter = 8;  // quanta of exact-zero output before liveVoices() reports 0

  void switchTo(double t, double when);
  void addTimer(double t, TimerKind k, unsigned line, std::uint32_t seq);
  void runTimers(std::int64_t frame0);
  void renderLine(Line &l, std::int64_t frame0, const float *const in[2], float *const acc[2], bool first);

  double sr_, q_;
  Line lines_[2];
  unsigned active_ = 0;
  wa::Param ret_{1.0}, wheel_{1.0};
  // the JS Delay.p view the audio side needs
  double effTime_ = 0.375, fb_ = 0.35, tone_ = 0.5;
  bool pp_ = false;
  double fbScale_ = 1.0;
  std::uint32_t switchSeq_ = 0;
  Timer timers_[kTimers];
  std::uint64_t timerOrder_ = 0;
  double lastQuantumTime_ = 0;  // `now` for ops (the start of the quantum about to render)
  std::size_t quietQuanta_ = kQuietAfter;
  alignas(16) float zeros_[kQ] = {};
};

/** For T14's allNotesOff (contract 1.4): the delay's feedback window. No-op when no T05 delay is attached. */
void sendDelayPanic(Model &m, double when);

}  // namespace rig::fx
