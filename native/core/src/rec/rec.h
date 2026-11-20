// M17 recorder (T08): the `rec` sink unit (UnitSlot::Recorder: `out` post ceiling, plus the click when
// `click.record` and the click is on aux; graph.cpp) and the "rec" service (contract 6.4 `rec`, SHELL.md "Recording
// ownership"). The audio thread only copies floats into a lock-free SPSC ring; a writer thread (realtime) or the
// offline driver (inline, per quantum) converts and writes the WAV, so no file I/O ever runs on the audio thread.
// Format: 16-bit (default) or 24-bit PCM stereo at the engine rate; the 16-bit conversion is recorder-processor.js's
// (clamp to +-1, NaN -> 0, Math.round(x < 0 ? x * 32768 : x * 32767)). The header is rewritten every second so a
// crash leaves a playable file. Name: `Rig YYYY-MM-DD HHmm.wav` (local time), " (n)" appended when taken.
#pragma once
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>

#include "graph/unit.h"
#include "model/services.h"

namespace rig {

class Model;

inline constexpr const char *kKindRec = "rec";

struct RecShared {
  static constexpr std::size_t kFrames = std::size_t{1} << 18;  // 262144 frames: 5.9 s at 44.1 kHz
  std::atomic<std::uint64_t> head{0};  // frames produced (audio thread)
  std::atomic<std::uint64_t> tail{0};  // frames consumed (writer)
  float buf[kFrames * 2] = {};         // interleaved L R; ordered by head/tail release/acquire
  std::atomic<bool> armed{false};
  std::atomic<std::uint64_t> dropped{0};  // frames lost to a full ring (overflow accounting)
  std::atomic<std::uint32_t> peakBits[2] = {};
  std::atomic<std::uint64_t> quanta{0};
};

/** The `rec` sink: measured 0.5 us per quantum while armed (unit.meter), a load and a counter when not. */
class RecUnit final : public Unit {
 public:
  explicit RecUnit(RecShared *s) : s_(s) {}
  void process(const RenderContext &ctx, UnitIO &io) override;

 private:
  RecShared *s_;
};

/** Writes interleaved float frames as 16/24-bit PCM to a WAV file with periodic header refresh. */
class WavStreamWriter {
 public:
  ~WavStreamWriter() { close(); }
  bool open(const std::string &path, double sampleRate, int bits, std::string *err);
  bool write(const float *interleaved, std::size_t frames);  // false on I/O error
  bool refreshHeader();
  void close();
  bool isOpen() const { return f_ != nullptr; }
  std::uint64_t frames() const { return frames_; }
  std::uint64_t bytes() const { return 44 + dataBytes_; }

  /** 16-bit sample conversion of recorder-processor.js. */
  static std::int16_t to16(float x);
  static std::int32_t to24(float x);

 private:
  bool header();
  std::FILE *f_ = nullptr;
  double sr_ = 48000;
  int bits_ = 16;
  std::uint64_t frames_ = 0, dataBytes_ = 0;
  std::string conv_;  // conversion scratch (writer side)
};

class RecServiceImpl final : public RecService {
 public:
  explicit RecServiceImpl(Model &m);
  ~RecServiceImpl() override;

  // RecService. Errors are returned as {"error":{"code","message"}} (the bridge turns them into error replies).
  std::string start(const yyjson_val *args) override;
  std::string stop() override;
  void onRateChanged(double sampleRate) override;
  std::string statsFields() override;

  /** Control thread, every loop turn (realtime) or every quantum (offline): offline it drains the ring into the
   *  file; both modes emit `rec {level}` at ~10 Hz and report writer errors. */
  void pump(bool offline, double engineTime);
  bool recording() const { return writer_.isOpen(); }
  RecShared &shared() { return *shared_; }
  static RecServiceImpl *of(Model &m);
  static RecShared *sharedFor(const void *engineKey);

 private:
  std::string finish(const char *message);
  std::size_t drain();  // ring -> file; returns frames written
  void writerLoop();
  void emitState(const char *state, const char *message);

  Model &m_;
  RecShared *shared_;
  WavStreamWriter writer_;
  std::string path_;
  double sr_ = 48000;
  std::thread thread_;
  std::atomic<bool> run_{false}, ioError_{false};
  double lastLevel_ = -1;
  bool offlineMode_ = false;
  std::uint64_t recordings_ = 0;
};

}  // namespace rig
