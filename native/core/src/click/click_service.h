// "click" service (T07; contract 1.5, 3.10, 6.4 `click`, 6.5 `click`): audio.js's click glue (clickStart/Stop,
// setClick, clickState, setTempo/setTimeSig -> retime, setClockSink) over click::Metronome, wired to the engine:
// ticks -> ClickOp::Schedule on the "click" unit (click_unit.cpp), level -> the unit's kClickLevel param
// (rampTo tau 10 ms), routing -> Op::ClickRoute, MIDI clock -> rig_host.midi_send on the `config.midiClock.port`
// output ('auto' = first connected output, SHELL.md G4; else the port id, then the port name).
#pragma once
#include <functional>
#include <string>
#include <vector>

#include "click/metronome.h"
#include "model/services.h"

namespace rig {

class Model;

class ClickServiceImpl final : public ClickService, private click::Metronome::Host {
 public:
  explicit ClickServiceImpl(Model &m);

  std::string start(int countIn, bool quietAfter, double when) override;
  bool stop(double when) override;
  std::string configure(const yyjson_val *cfg, double when) override;
  std::string stateJson() override;
  void setClockPort(const char *portId) override;

  void onSongState(const SongState &s) override;
  void onCommit(const PatchSpec &, double) override { syncAttach(); }
  void onAudioEvent(const AudioEvent &e) override;
  std::string statsFields() override;

  const click::Metronome &metronome() const { return met_; }
  /** Tests: see every scheduled tick / clock message (also enables the clock without a MIDI port). */
  using TickObserver = std::function<void(double t, click::TickKind kind)>;
  using ClockObserver = std::function<void(const click::ClockMsg *msgs, std::size_t n)>;
  void setTickObserver(TickObserver f) { tickObs_ = std::move(f); }
  void setClockObserver(ClockObserver f) { clockObs_ = std::move(f); }
  using ClearObserver = std::function<void(double t)>;
  void setClearObserver(ClearObserver f) { clearObs_ = std::move(f); }
  /** The MIDI output the clock goes to now ("" = none). */
  std::string clockTarget() const;

 private:
  // Metronome::Host
  double now() override;
  void at(double t, std::function<void(double)> fn) override;
  void scheduleTick(double t, click::TickKind kind) override;
  void clearAfter(double t) override;
  void rampLevel(double level, double when) override;
  void route(bool aux, bool record) override;
  unsigned outputChannels() override;
  void emitState(const std::string &stateJson) override;
  void warn(std::string_view message) override;
  bool hasClockSink() override;
  void sendClock(const click::ClockMsg *msgs, std::size_t n) override;

  bool attached() const;
  /** audio.js start(): a new metronome takes bpm/sig and configure(this._clickCfg, 0) once the unit exists. */
  void syncAttach();
  double engineT(double when);  // audio.js _t(when)

  Model &m_;
  click::Metronome met_;
  bool seenAttach_ = false;
  // audio.js _clickCfg (survives restart): absent until set
  bool cfgHasLevel_ = false, cfgHasRecord_ = false, cfgHasOutput_ = false, cfgRecord_ = false;
  double cfgLevel_ = 0;
  std::string cfgOutput_;
  double lastTempo_ = 0;
  int lastSigNum_ = 4, lastSigDen_ = 4;
  bool hasClockPort_ = false;
  std::string clockPort_;
  TickObserver tickObs_;
  ClockObserver clockObs_;
  ClearObserver clearObs_;
};

}  // namespace rig
