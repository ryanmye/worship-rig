// Engine: the object behind rig_engine*. Owns Model + Graph + queues, the control thread (realtime mode) or the
// offline driver, the render FIFO adapter and the event sink.
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <semaphore>
#include <string>
#include <thread>
#include <vector>

#include "rig/rig_engine.h"
#include "graph/graph.h"
#include "model/model.h"
#include "runtime/mpsc.h"
#include "runtime/seqlock.h"
#include "time/timer.h"

namespace rig {

class Bridge;

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
  std::int64_t renderedFrames() const override { return frames_.load(std::memory_order_acquire); }
  double sampleRate() const override { return sr_; }

  rig_status post(const char *json, std::size_t len);
  rig_status render(float *const *out, uint32_t channels, uint32_t frames, uint64_t hostTimeNs);
  rig_status offlineRender(float *const *out, uint32_t channels, uint32_t frames);
  rig_status midiIn(const char *port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs);
  void hostAudioStarted(const rig_device_info &info);
  void hostAudioState(rig_device_state s, const char *msg);
  void hostDevicesChanged();
  rig_status getMeters(rig_meters *out) const;
  double engineTime() const { return static_cast<double>(frames_.load(std::memory_order_acquire)) / sr_; }

  rig_status testTap(const char *node);
  rig_status testInject(const char *node, const float *const *data, uint32_t channels, uint64_t frames, double start,
                        float gain);
  std::size_t testQuery(const char *what, char *buf, std::size_t cap);

  // Used by the bridge (control thread / offline caller).
  Model &model() { return model_; }
  void emit(std::string &&json);  // queue one message for the event callback (flushed per turn / immediately offline)
  void flush();
  const rig_config &config() const { return cfg_; }
  std::uint32_t seed() const { return seed_; }
  bool realtime() const { return cfg_.mode == RIG_MODE_REALTIME; }
  const rig_host *host() const { return cfg_.host ? &host_ : nullptr; }
  std::string statsJson();
  void requestAudio(const std::string &action, const std::string &deviceId, double latency);
  bool awake() const { return awake_; }
  void setAwake(bool a) { awake_ = a; }
  unsigned outChannels() const { return outCh_; }
  std::string deviceListJson();
  void log(int level, const std::string &msg);

 private:
  explicit Engine(const rig_config &cfg);
  void controlLoop();
  void processMessage(const std::string &json);
  void drainAudioEvents();
  void fifoRead(float *const *out, uint32_t channels, uint32_t frames, bool offline);
  void renderOne();
  void emitTick();
  void postHostEvent(std::string &&json);

  rig_config cfg_;
  rig_host host_{};
  std::string appDir_, userManifest_, padsDir_, recDir_, seedString_;
  double sr_;
  std::uint32_t seed_ = 1;
  unsigned outCh_;
  std::atomic<std::int64_t> frames_{0};
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
  bool awake_ = true;
  std::atomic<bool> rtRunning_{false};
  std::atomic<bool> started_{false};  // audio started (or a driver with no host): rig_render produces sound

  // render FIFO adapter (host block size != 128)
  float fifo_[RIG_MAX_OUTPUT_CHANNELS][RIG_QUANTUM_FRAMES] = {};
  unsigned fifoPos_ = RIG_QUANTUM_FRAMES;  // == quantum: empty

  // realtime plumbing
  std::mutex inMu_;
  std::deque<std::string> inQ_;
  std::vector<std::string> hostEvents_;
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
  friend class Bridge;
};

}  // namespace rig
