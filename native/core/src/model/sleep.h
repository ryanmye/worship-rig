// Audio sleep / wake queueing (lowres2; T14 W3A): audio.js _sleepS, sleep(), wake(), _sleepHold, sleepBlockers,
// _outGainAt / _rampLead (1480-1640). Contract 1.1 rows `sleep`, `wake`, `sleepState`, `sleepBlockers`.
//
// Split with the engine (api/engine.cpp, T08): the engine decides whether a sleep may start at all (realtime, the
// device running) and owns the device side; this class owns the state machine, the `out` ramp (MasterChain
// kMasterOut, after the clip curve: fx.js `out`) and the queue. CommandSink::sleepChanged(render, ...) tells the
// engine to suspend (asleep) or resume rendering (wake) and to emit its `state` event with the new sleepState().
//
// Native difference: ctx.resume() is synchronous here (the engine just renders again), so wake() runs the whole JS
// wake in one call: `waking` is visible only to the calls it replays (none: they see `awake`, as in JS after the
// await). A wake that comes while the ramp down plays (`sleeping`) cancels the sleep (seq), as in JS.
// Control thread only.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "model/perform.h"

namespace rig {

class Model;

/** One perform call held while the engine is not awake (audio.js S.queue entries [name, args, extra]). */
struct SleepCall {
  enum Kind : std::uint8_t { NoteOn, NoteOff, Sustain } kind = NoteOn;
  int note = 0, vel = 0;
  bool down = false;
  bool hasTouch = false;  // noteOn's {touch}, compiled at queue time (JS compiles it at replay: same curve)
  Touch touch;
};

class Sleep {
 public:
  static constexpr double kSleepRamp = 0.15;     // audio.js SLEEP_RAMP_SEC
  static constexpr double kWakeRamp = 0.06;      // WAKE_RAMP_SEC
  static constexpr double kWakeNoteRamp = 0.005;  // WAKE_NOTE_RAMP_SEC (a queued noteOn: play it at once)

  Sleep(Model &m, Perform &p);

  /** audio.js sleep({ramp}): only from awake (and realtime: see setTestRealtime). Ramps `out` from its value at
   *  t = now + lead to 0 over `ramp`, state `sleeping`; at t + ramp + 5 ms (unless a wake came) `asleep` and the
   *  engine suspends. True = the sleep started. */
  bool sleep(double ramp);
  /** audio.js wake({ramp}): no-op (false) when awake. Resumes, ramps `out` back to 1 from t = now + lead over
   *  `ramp` (NaN / < 0: 5 ms with a queued noteOn, else 60 ms), replays the queue at t in order, emits. */
  bool wake(double ramp);
  const char *state() const;
  bool awake() const { return state_ == State::Awake; }
  /** audio.js _sleepHold: while not awake (and not offline) the call is queued and wakes the engine. True = held
   *  (the caller returns at once; the call is played at the wake ramp's start). */
  bool hold(const SleepCall &c);
  /** audio.js sleepBlockers(): 'voices', 'click', 'pedal', 'drone'; ['no-audio'] on an offline engine. */
  std::string blockersJson() const;
  /** `_debugStats` members: audioSleep (state), audioSleeps, audioWakes, lastWake {ms, queued, ramp, at, leadMs}. */
  void statsFields(std::string &out) const;
  /** Tests: an offline engine sleeps and queues as a realtime one (its renders keep the time running). */
  void setTestRealtime(bool on) { testRealtime_ = on; }
  std::size_t queued() const { return queue_.size(); }

 private:
  enum class State : std::uint8_t { Awake, Sleeping, Asleep, Waking };
  struct Ramp {
    double t = 0, dur = 0, from = 1, to = 1;
    bool any = false;
  };
  struct Last {
    bool any = false;
    double ms = 0, ramp = 0, at = 0, leadMs = 0;
    std::size_t queued = 0;
  };

  bool offline() const;
  double lead() const;               // _rampLead: clamp(2 x outputLatency, 10 ms, 40 ms)
  double outGainAt(double t) const;  // _outGainAt
  void outRamp(double from, double to, double t, double dur);
  void replay(const SleepCall &c, double t);

  Model &m_;
  Perform &p_;
  State state_ = State::Awake;
  std::uint32_t seq_ = 0, sleeps_ = 0, wakes_ = 0;
  std::vector<SleepCall> queue_;
  Ramp ramp_;
  Last last_;
  bool testRealtime_ = false;
};

}  // namespace rig
