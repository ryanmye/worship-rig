// The dev host's audio layer: a rig_host vtable (rig_engine.h) over miniaudio's low-level device API, so the
// realtime core (control thread, host thread, adapter FIFO, rate hand-off) runs on Linux (ALSA / PulseAudio / null)
// and macOS (Core Audio) exactly as it will under the Apple shell, minus AUHAL specifics (ARCHITECTURE §5).
//
// Threads: audio_start / audio_stop / audio_list_devices arrive on the core's host-call thread (serial; may block
// briefly: a device open). The miniaudio data callback is the real-time thread: it only deinterleaves through
// preallocated buffers and calls rig_render (no locks, no allocation: tests run it under the allocation trap).
#pragma once
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "rig/rig_engine.h"

namespace devhost {

struct AudioOptions {
  std::string backend = "auto";       // auto | null | alsa | pulse | jack | coreaudio
  std::uint32_t periodFrames = 128;   // the "interactive" buffer (latency_sec 0)
  std::uint32_t bufferFrames = 0;     // T00c D2 `--buffer N`: force this period (overrides `audio {bufferFrames}`)
  std::uint32_t periods = 2;
  std::uint32_t sampleRate = 0;       // 0 = the device's native rate (the core adopts it, contract 6.3)
  std::uint32_t maxBlockFrames = 4096;  // = rig_config.max_block_frames
  bool muted = false;                   // rig-probe: render as usual, then write zeros to the device (nothing audible)
};

/**
 * Per-callback timing for rig-probe (MAC_CHECK.md): one entry per data callback while attached. Preallocated; the
 * real-time thread is the only writer (no locks, no allocation). Protocol: setCallbackLog(&log) starts a window,
 * setCallbackLog(nullptr) ends it; read `count` (acquire) only after the next callback has certainly run (the probe
 * waits a few periods), then busyNs/gapNs/frames[0..count).
 */
struct CallbackLog {
  explicit CallbackLog(std::size_t capacity) : busyNs(capacity), gapNs(capacity), frames(capacity) {}
  std::vector<std::uint32_t> busyNs;  // wall time inside the callback (render + interleave + mute)
  std::vector<std::uint32_t> gapNs;   // start-to-start distance to the previous callback (0 for the very first)
  std::vector<std::uint32_t> frames;  // frames the device asked for
  std::atomic<std::size_t> count{0};
};

/** Callback timing (the CPU cost figure of the report): wall time inside the data callback. */
struct AudioStats {
  std::uint64_t callbacks = 0, frames = 0;
  std::uint64_t totalNs = 0, renderNs = 0, maxNs = 0;
  double sampleRate = 0;
  std::uint32_t channels = 0, periodFrames = 0;
  bool running = false;
  // the opened device (rig-probe): periods x period / internal rate = the latency the core is told
  std::uint32_t periods = 0, internalSampleRate = 0;
  double latencySec = 0;
  std::string deviceName;
};

class AudioHost {
 public:
  explicit AudioHost(AudioOptions o);
  ~AudioHost();
  AudioHost(const AudioHost &) = delete;
  AudioHost &operator=(const AudioHost &) = delete;

  /** Initialises the miniaudio context for the chosen backend. */
  bool init(std::string *err);
  /** The vtable for rig_config.host (user = this). Valid for the host's lifetime. */
  const rig_host *vtable() const { return &vt_; }
  /** The engine whose rig_render the callback drives and which receives rig_host_* notifications. */
  void attach(rig_engine *e) { engine_.store(e, std::memory_order_release); }
  /** Stops and closes the device (call before rig_destroy). Idempotent. */
  void shutdown();

  AudioStats stats() const;
  std::string backendName() const;
  /** JSON device list (contract 6.4 `get devices`: [{id, name, channels, default, sampleRates}]). */
  std::string devicesJson();

  // rig_host entry points (public for tests; normally called through the vtable on the core's host thread)
  /** `bufferFrames` (T00c D2, rig_host.audio_start_frames): the `audio {bufferFrames}` request, 0 = none. */
  void start(const char *deviceId, double latencySec, std::uint32_t channels, std::uint32_t bufferFrames = 0);
  void stop();

  /**
   * The real-time part of the data callback: renders `frames` interleaved frames of `channels_` channels into `out`
   * through rig_render, in pieces of at most maxBlockFrames. Public so tests can run it under the allocation trap
   * and time it without a device. prepareBuffers() must have run (start() does it).
   */
  void renderInterleaved(float *out, std::uint32_t frames);
  void prepareBuffers(std::uint32_t channels);
  /** miniaudio device notification (ma_device_notification_type as int). */
  void notify(int type);
  /** rig-probe: zero the device buffer after rendering (the render still runs and is timed). */
  void setMuted(bool on) { muted_.store(on, std::memory_order_relaxed); }
  /** rig-probe: start (log) or end (nullptr) a per-callback timing window; see CallbackLog. */
  void setCallbackLog(CallbackLog *log) { log_.store(log, std::memory_order_release); }

  struct Impl;  // miniaudio objects (keeps miniaudio.h out of this header)

 private:
  AudioOptions o_;
  rig_host vt_{};
  std::atomic<rig_engine *> engine_{nullptr};
  std::unique_ptr<Impl> impl_;
  mutable std::mutex devMu_;  // serialises open/close (host thread vs shutdown) and the format fields for stats()
  std::vector<float> planar_;  // maxBlock * channels, preallocated before the device starts
  float *planes_[RIG_MAX_OUTPUT_CHANNELS] = {};
  std::uint32_t channels_ = 2;
  std::atomic<bool> stopping_{false};
  std::atomic<std::uint64_t> callbacks_{0}, frames_{0}, totalNs_{0}, renderNs_{0}, maxNs_{0};
  std::atomic<std::uint64_t> latencyNs_{0};
  double sr_ = 0;
  std::uint32_t period_ = 0;
  std::atomic<bool> running_{false};
  std::atomic<bool> muted_{false};
  std::atomic<CallbackLog *> log_{nullptr};
  std::uint64_t lastStartNs_ = 0;  // RT thread only
  std::uint32_t periods_ = 0, internalSr_ = 0;
  double latencySec_ = 0;
  std::string devName_;
};

/** Monotonic host clock in ns (rig_host.host_time_ns). */
std::uint64_t hostNowNs();

}  // namespace devhost
