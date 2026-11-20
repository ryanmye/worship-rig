// Engine: the object behind rig_engine*. Owns Model + Graph + queues, the control thread (realtime mode) or the
// offline driver, the render FIFO adapter and the event sink.
#pragma once
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <semaphore>
#include <string>
#include <thread>
#include <vector>

#include "rig/rig_engine.h"
#include "graph/graph.h"
#include "model/model.h"
#include "runtime/clock_map.h"
#include "runtime/midi_ports.h"
#include "runtime/mpsc.h"
#include "runtime/seqlock.h"
#include "time/timer.h"

namespace rig {

class Bridge;
class MeterServiceImpl;
class RecServiceImpl;

struct MidiIn {
  std::uint64_t hostTimeNs;
  std::uint16_t port;
  std::uint8_t len;
  std::uint8_t bytes[13];
};

class Engine final : public CommandSink {
 public:
  static Engine *create(const rig_config &cfg, rig_status *err);
  ~Engine() override;

  // CommandSink
  bool send(Command c) override;
  TimeBase timeBase() const override { return graph_.timeBase(); }
  void emit(std::string &&json) override;  // queue one message for the event callback (flushed per turn / offline)
  void at(double t, std::function<void(double)> fn) override;

  /** Current engine rate (the rate of the time grid; changes with the device, contract 6.3). */
  double sampleRate() const { return graph_.timeBase().sampleRate; }

  rig_status post(const char *json, std::size_t len);
  rig_status render(float *const *out, uint32_t channels, uint32_t frames, uint64_t hostTimeNs);
  rig_status offlineRender(float *const *out, uint32_t channels, uint32_t frames);
  rig_status midiIn(const char *port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs);
  rig_status midiPorts(const char *json, std::size_t len);
  /** Port id of a rig_midi_in index (runtime/midi_ports.h); "" when unknown. [any] */
  std::string midiPortId(std::uint16_t index) const;
  const ClockMap &clockMap() const { return clock_; }
  void hostAudioStarted(const rig_device_info &info);
  void hostAudioState(rig_device_state s, const char *msg);
  void hostDevicesChanged();
  rig_status getMeters(rig_meters *out) const;
  /** Engine time of the next frame to render: monotonic across device rate changes (SETUP_REVIEW 16). */
  double engineTime() const { return graph_.timeBase().time(); }
  /** rig_host_memory_pressure / rig_set_paths: run on the control thread (inline offline). [any] */
  void memoryPressure(int level);
  void setPaths(const char *userManifest, const char *padsDir);

  rig_status testTap(const char *node);
  rig_status testInject(const char *node, const float *const *data, uint32_t channels, uint64_t frames, double start,
                        float gain);
  std::size_t testQuery(const char *what, char *buf, std::size_t cap);

  // Used by the bridge (control thread / offline caller).
  Model &model() { return model_; }
  Graph &graph() { return graph_; }
  void flush();
  const rig_config &config() const { return cfg_; }
  std::uint32_t seed() const { return seed_; }
  bool realtime() const { return cfg_.mode == RIG_MODE_REALTIME; }
  const rig_host *host() const { return cfg_.host ? &host_ : nullptr; }
  std::string statsJson();
  /** `audio start|restart|output`: asks the host on the device thread (never blocks the control thread; R25) and
   *  arms the 5 s watchdog. Emits `state` before the caller's reply (G9). "" = accepted, else an error code
   *  (`busy` while a start is pending for restart/output, `unsupported` when the host has no audio_start). */
  const char *requestAudio(const std::string &action, const std::string &deviceId, double latency);
  /** `audio sleep|wake` (engine side: suspend/resume rendering after the Model's ramp). */
  bool sleepAudio(double ramp);
  bool wakeAudio(double ramp);
  bool audioPending() const { return pending_; }
  bool audioStarted() const { return started_.load(std::memory_order_acquire); }
  /** `state` event / audio reply fields. */
  std::string stateFieldsJson(const char *state, double sr = 0) const;
  const char *deviceState() const { return devState_; }
  bool awake() const { return awake_; }
  void setAwake(bool a) { awake_ = a; }
  unsigned outChannels() const { return outCh_; }
  std::string deviceListJson();
  /** Tick builder (contract 6.5 `tick`): realtime control loop at MeterService::tickHz; public for tests. */
  std::string buildTick(bool withStats);
  void log(int level, const std::string &msg);

 private:
  explicit Engine(const rig_config &cfg);
  void controlLoop();
  void processMessage(const std::string &json);
  void drainAudioEvents();
  void checkWatchdog();
  void pumpRec(bool offline);
  void hostCall(std::function<void()> fn);
  void hostCallLoop();
  void fifoRead(float *const *out, uint32_t channels, uint32_t frames, bool offline);
  void renderOne();
  void emitTick();
  void emitState(const char *state, bool restarted);
  void postHostEvent(std::string &&json);
  /** Run fn on the control thread (realtime: queued + wake; offline: inline). */
  void onControl(std::function<void()> fn);
  static UnitEnv makeEnv(const rig_config &cfg, std::uint32_t seed);

  rig_config cfg_;
  rig_host host_{};
  std::string appDir_, userManifest_, padsDir_, recDir_, seedString_;
  std::uint32_t seed_ = 1;
  std::atomic<unsigned> outCh_;  // written by the host thread (device change), read on the audio thread
  CommandQueue cmdQ_;
  EventQueue evQ_;
  Seqlock<rig_meters> meters_;
  MpscQueue<MidiIn, 4096> midiQ_;
  std::atomic<std::uint32_t> midiDropped_{0}, midiRecv_{0};
  Graph graph_;
  Model model_;
  std::unique_ptr<Bridge> bridge_;
  std::uint32_t seq_ = 0;
  TimerQueue timers_;
  std::atomic<bool> awake_{true};  // set on the control thread, read by rig_render (SETUP_REVIEW R1)
  std::atomic<bool> rtRunning_{false};
  std::atomic<bool> started_{false};  // audio started (or a driver with no host): rig_render produces sound

  // render FIFO adapter (host block size != 128)
  float fifo_[RIG_MAX_OUTPUT_CHANNELS][RIG_QUANTUM_FRAMES] = {};
  unsigned fifoPos_ = RIG_QUANTUM_FRAMES;  // == quantum: empty

  // realtime plumbing
  std::mutex inMu_;
  std::deque<std::string> inQ_;
  std::vector<std::string> hostEvents_;
  std::vector<std::function<void()>> hostCalls_;
  std::binary_semaphore wake_{0};
  std::atomic<bool> stop_{false};
  std::atomic<bool> wakePending_{false};
  std::thread control_;
  std::vector<std::string> outBatch_;
  std::mutex outMu_;
  std::int64_t lastTickFrame_ = 0;
  std::atomic<std::uint32_t> xruns_{0};
  std::atomic<std::uint64_t> cpuNsAccum_{0};
  std::uint32_t tapId_ = 0;
  bool hello_ = false;

  // T08 runtime: device requests off the control thread, watchdog, clock map, MIDI ports, tick pacing
  static constexpr double kWatchdogSec = 5.0;
  std::thread hostThread_;
  std::mutex hostMu_;
  std::condition_variable hostCv_;
  std::deque<std::function<void()>> hostJobs_;
  bool hostStop_ = false;
  bool pending_ = false;            // control thread: a start/restart waits for the host
  bool restartPending_ = false;
  std::chrono::steady_clock::time_point deadline_{};
  const char *devState_ = "suspended";  // control thread view (state event)
  std::string deviceId_ = "default", deviceName_;
  double latencySec_ = 0;               // host-reported output latency
  const char *sleepState_ = "awake";
  ClockMap clock_;
  MeterServiceImpl *meterSvc_ = nullptr;  // resolved once (services never change after Model construction)
  RecServiceImpl *recSvc_ = nullptr;
  MidiPortTable midiPorts_;
  std::chrono::steady_clock::time_point lastTick_{}, lastStats_{};
  std::atomic<std::uint32_t> garbageFreed_{0}, endedRescans_{0};
  friend class Bridge;
};

}  // namespace rig
