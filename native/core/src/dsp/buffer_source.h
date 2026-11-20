// BufferSource: AudioBufferSourceNode semantics (ARCHITECTURE 8.3): linear-interpolation repitch, playbackRate x
// buffer-rate / engine-rate, sub-sample start offset, loop points, onended. Interface FROZEN by T00b; T11a implements
// (dsp/buffer_source.cpp, Chromium 157.0.8103.78 audio_buffer_source_node.cc). Used by the sampler (T12), click (T07),
// lofi crackle loop (T05), test injection. RT: no allocation after construction.
#pragma once
#include <cstddef>
#include <cstdint>

#include "model/buffer_cache_api.h"
#include "time/param.h"

namespace rig::wa {

class BufferSource {
 public:
  /** `buf` is borrowed (cache reference held by the owner until the detach epoch has passed). */
  explicit BufferSource(const SampleBuffer *buf = nullptr);
  void setBuffer(const SampleBuffer *buf);

  Param &playbackRate() { return rate_; }  // k-rate (Chromium)
  Param &detune() { return detune_; }      // k-rate, cents
  void setLoop(bool loop, double loopStartSec, double loopEndSec);

  /** start(when, offsetSec, durationSec < 0 = whole) / stop(when), engine seconds. */
  void start(double when, double offsetSec = 0.0, double durationSec = -1.0);
  void stop(double when);
  /** True once the end (or stop) has been rendered: the owner raises VoiceEnded in the same quantum. */
  bool ended() const { return ended_; }

  /** Writes channels() channels of n frames for time-grid frames [frame0, frame0+n). */
  void process(std::int64_t frame0, double sampleRate, float *const *out, std::size_t n);
  unsigned channels() const;

 private:
  const SampleBuffer *buf_;
  Param rate_{1.0}, detune_{0.0};
  bool loop_ = false;
  double loopStart_ = 0, loopEnd_ = 0, when_ = -1, offset_ = 0, duration_ = -1, stop_ = -1;
  double pos_ = 0;  // virtual read index (buffer frames)
  bool ended_ = false;
  // INTERFACE-CHANGE(T11a): Chromium 157 state of AudioBufferSourceHandler not covered by the fields above.
  bool playing_ = false, isGrain_ = false, durationGiven_ = false;
  double grainOffset_ = 0, grainDuration_ = 0, playedFrames_ = 0;
  double loopStartFrame_ = 0, loopEndFrame_ = 0;  // effective loop points in buffer frames
  void updateLoopPoints();
  void clampGrain();
  float sampleAt(unsigned ch, std::uint64_t i) const;
};

}  // namespace rig::wa
