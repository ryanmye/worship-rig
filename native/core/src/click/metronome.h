// Metronome (T07): control-side port of app/js/engine/metronome.js (state, configure/routing, start/stop/retime, the
// 50 ms pump with 0.3 s lookahead, MIDI clock 24 ppq + Start/Stop). It owns no audio: it calls a Host for "now",
// timers, click scheduling, the bus level, routing, state events and the clock sink, so it runs unchanged against
// the engine (click_service.cpp) and against a scripted fake in tests (tests/test_click_metronome.cpp replays the
// real metronome.js through tools/golden/vectors/data/click-metronome.txt).
//
// Differences from the JS, all outside what the goldens and vectors observe:
//  - `live` (scheduled or sounding sources) is counted on the control side from the tick times (t + 40 ms > now), not
//    from AudioBufferSourceNode.onended.
//  - `pumpMs` is measured with std::chrono (performance.now() in the JS).
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "click/click_math.h"

namespace rig::click {

inline constexpr double kLookaheadSec = 0.3;  // CLICK_LOOKAHEAD_SEC
inline constexpr double kPumpSec = 0.05;      // CLICK_PUMP_SEC
inline constexpr double kStartLeadSec = 0.06; // CLICK_START_LEAD_SEC
inline constexpr double kLevelTau = 0.01;     // configure(): rampTo(bus.gain, level, t, 0.01)

struct ClockMsg {
  double t;  // engine seconds
  std::uint8_t status;
};

class Metronome {
 public:
  class Host {
   public:
    virtual ~Host() = default;
    virtual double now() = 0;  // ctx.currentTime
    virtual void at(double t, std::function<void(double)> fn) = 0;  // AudioTimer.at
    virtual void scheduleTick(double t, TickKind kind) = 0;          // new AudioBufferSourceNode(...).start(t)
    virtual void clearAfter(double t) = 0;                           // disconnect live sources with e.t >= t - 1e-6
    virtual void rampLevel(double level, double when) = 0;           // rampTo(bus.gain, level, when, 0.01)
    virtual void route(bool aux, bool record) = 0;                   // bus -> destination / merger 3-4 / recordTap
    virtual unsigned outputChannels() = 0;                           // ctx.destination.maxChannelCount
    virtual void emitState(const std::string &stateJson) = 0;        // the engine's 'click' event
    virtual void warn(std::string_view message) = 0;
    virtual bool hasClockSink() = 0;
    virtual void sendClock(const ClockMsg *msgs, std::size_t n) = 0;
  };

  explicit Metronome(Host &host) : h_(host) {}

  bool running() const { return grid_ != nullptr; }
  bool counting() const { return grid_ != nullptr && counting_; }
  /** outputs(): {aux: channels >= 4, channels}. */
  bool auxAvailable() const { return h_.outputChannels() >= 4; }

  /** configure({level, record, output}, when): absent fields = nullptr / NaN. Returns {output, auxAvailable}. */
  std::string configure(double level, const bool *record, const char *output, bool hasOutput, double when);
  /** setOutput(output): returns the routing now in effect. */
  const char *setOutput(const char *output);
  /** reapplyOutput(): after an output device change. */
  void reapplyOutput();
  /** start({bpm, sig, countIn, quietAfter, when}): bpm <= 0 = no tempo. Returns {t0, downbeat} or "null". */
  std::string start(double bpm, std::string_view sig, int countIn, bool quietAfter, double when);
  bool stop(double when, bool silent = false);
  /** retime({bpm, sig, newBar}): bpmNull = `bpm: null` (stops), bpm <= 0 and !bpmNull = undefined, sig "" = undefined.
   *  Returns {beat, t} or "null". */
  std::string retime(double bpm, bool bpmNull, std::string_view sig, bool newBar);
  /** Values the next start() uses (Metronome.bpm / .sig assignments by audio.js at start). */
  void setTempo(double bpm) { bpm_ = bpm > 0 ? bpm : 0; }
  void setSig(std::string_view sig) { sig_ = meterOf(sig).sig; }

  std::string stateJson() const;
  /** `_debugStats().click` without braces' contents: state + live, pumps, pumpMs, ticks, late, pulses, startedAt. */
  std::string statsJson();
  std::size_t liveCount();

  double level() const { return level_; }
  bool record() const { return record_; }
  const char *output() const { return output_; }
  double bpm() const { return bpm_; }
  const char *sig() const { return sig_; }
  const ClickGrid *grid() const { return grid_.get(); }

  struct Stats {
    std::uint64_t pumps = 0, ticks = 0, late = 0, pulses = 0;
    double pumpMs = 0, startedAt = -1;  // < 0 = null
  };
  const Stats &stats() const { return stats_; }
  /** The pump's horizon (end of the scheduled window). */
  double horizon() const { return horizon_; }
  /** The engine re-attached the click unit (rate change): the old unit's scheduled clicks went with it, so the
   *  ticks of [now, horizon) are scheduled again on the new one. The horizon stays: the MIDI clock pulses of that
   *  window were already sent and must not be sent twice. */
  void rescheduleTicks(double now);

 private:
  void pump(double now);
  void routeMain();
  void routeAux();
  void emitState() { h_.emitState(stateJson()); }

  Host &h_;
  double level_ = kDefaultLevel;
  bool record_ = false;
  const char *output_ = "main";
  const char *want_ = nullptr;  // _want (undefined until setOutput)
  bool auxRouted_ = false;      // _merger != null
  double bpm_ = 0;              // null = 0
  const char *sig_ = "4/4";
  std::unique_ptr<ClickGrid> grid_;
  bool quietAfter_ = false;
  double horizon_ = 0;
  std::uint64_t pumpGen_ = 0;  // _cancelPump: a pump of an older generation does nothing
  bool startSent_ = false, counting_ = false;
  std::deque<double> live_;  // tick times not yet finished (t + 40 ms > now)
  Stats stats_;
  std::vector<ClockMsg> msgs_;
};

}  // namespace rig::click
