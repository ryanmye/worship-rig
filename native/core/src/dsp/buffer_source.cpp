// BufferSource: a port of Chromium 157.0.8103.78 audio_buffer_source_handler.cc (BSD-3, The Chromium Authors;
// third_party/chromium/LICENSE): grain offset / duration, effective loop points snapped like
// TimeToFloatingSampleFrame, the integer fast path at rate 1, linear interpolation with loop-aware next sample and
// end-of-buffer extrapolation, negative playback rates, `playbackRate x bufferRate / contextRate x 2^(detune/1200)`
// (fdlibm::pow) clamped to +-1024. `ended()` = Finish() was called (the owner raises VoiceEnded in that quantum).
#include "dsp/buffer_source.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstring>
#include <limits>

#include "dsp/oscillator_schedule.h"
#include "num/js_math.h"

namespace rig::wa {

namespace {

constexpr double kMaxRate = 1024.0;
constexpr std::size_t kMaxQ = Param::kQuantum;

double timeToFloatingSampleFrame(double time, double sr) {
  const double frame = time * sr;
  const double rf = std::round(frame);
  const double tol = std::max(rf, 1.0) * (10.0 * std::numeric_limits<double>::epsilon());
  return std::fabs(frame - rf) <= tol ? rf : frame;
}

}  // namespace

BufferSource::BufferSource(const SampleBuffer *buf) : buf_(buf) { updateLoopPoints(); }

void BufferSource::setBuffer(const SampleBuffer *buf) {
  buf_ = buf;
  if (buf_ && isGrain_) clampGrain();
  updateLoopPoints();
  pos_ = 0;
  playedFrames_ = 0;
}

void BufferSource::setLoop(bool loop, double loopStartSec, double loopEndSec) {
  loop_ = loop;
  loopStart_ = loopStartSec;
  loopEnd_ = loopEndSec;
  updateLoopPoints();
}

unsigned BufferSource::channels() const { return buf_ && buf_->channels ? buf_->channels : 1; }

float BufferSource::sampleAt(unsigned ch, std::uint64_t i) const {
  if (buf_->f32[ch]) return buf_->f32[ch][i];
  if (buf_->i16[ch]) return static_cast<float>(buf_->i16[ch][i]) * buf_->i16Scale;
  return 0.0f;
}

void BufferSource::updateLoopPoints() {
  if (!buf_) {
    loopStartFrame_ = loopEndFrame_ = 0;
    return;
  }
  const double sr = buf_->sampleRate;
  const double len = static_cast<double>(buf_->frames);
  const double dur = len / sr;
  loopStartFrame_ = 0;
  loopEndFrame_ = len;
  if (!loop_) return;
  const double start = std::clamp(loopStart_, 0.0, dur);
  const double end = loopEnd_ == 0.0 ? dur : std::clamp(loopEnd_, 0.0, dur);
  if (start < end) {
    if (start > 0.0) loopStartFrame_ = timeToFloatingSampleFrame(start, sr);
    if (end < dur) loopEndFrame_ = timeToFloatingSampleFrame(end, sr);
  }
  if (loopStartFrame_ >= loopEndFrame_) {
    loopStartFrame_ = 0;
    loopEndFrame_ = len;
  }
}

void BufferSource::clampGrain() {
  const double sr = buf_->sampleRate;
  const double dur = static_cast<double>(buf_->frames) / sr;
  grainOffset_ = std::clamp(grainOffset_, 0.0, dur);
  grainDuration_ = durationGiven_ ? std::max(grainDuration_, 0.0) : std::numeric_limits<double>::infinity();
  if (rate_.intrinsic() == 1.0 && detune_.intrinsic() == 0.0) {
    pos_ = static_cast<double>(sched::timeToSampleFrame(grainOffset_, sr));
  } else {
    pos_ = grainOffset_ * sr;
  }
}

void BufferSource::start(double when, double offsetSec, double durationSec) {
  if (when_ >= 0.0 || when < 0.0 || offsetSec < 0.0) return;
  durationGiven_ = durationSec >= 0.0;
  isGrain_ = true;
  grainOffset_ = offsetSec;
  grainDuration_ = durationGiven_ ? durationSec : (buf_ ? static_cast<double>(buf_->frames) / buf_->sampleRate : 0.0);
  when_ = when;
  offset_ = offsetSec;
  duration_ = durationSec;
  if (buf_) clampGrain();
}

void BufferSource::stop(double when) {
  sched::State s{when_, stop_, playing_, ended_};
  s.stopAt(when);
  stop_ = s.end;
}

void BufferSource::process(std::int64_t frame0, double sampleRate, float *const *out, std::size_t n) {
  if (n > kMaxQ) n = kMaxQ;
  const unsigned nch = channels();
  for (unsigned c = 0; c < nch; ++c) std::memset(out[c], 0, n * sizeof(float));
  if (!buf_) {
    if (when_ >= 0.0) ended_ = true;
    return;
  }
  sched::State st{when_, stop_, playing_, ended_};
  const sched::Info info = sched::update(st, frame0, sampleRate, n);
  when_ = st.start;
  playing_ = st.playing;
  ended_ = st.finished;
  if (info.silentAll) return;

  const std::uint32_t bufLen = static_cast<std::uint32_t>(buf_->frames);
  if (bufLen == 0) {
    ended_ = true;
    return;
  }
  const double startFrame = loopStartFrame_, endFrame = loopEndFrame_;
  const double deltaFrames = endFrame - startFrame;

  // ComputePlaybackRate
  double rate = buf_->sampleRate / sampleRate;
  rate *= static_cast<double>(rate_.processKRate(frame0, sampleRate));
  rate *= rig::fdlibm::pow(2, static_cast<double>(detune_.processKRate(frame0, sampleRate) / 1200));
  rate = std::clamp(rate, -kMaxRate, kMaxRate);
  if (std::fabs(rate) > deltaFrames) return;

  double vri = pos_;
  int framesToProcess = static_cast<int>(info.count);
  std::size_t w = info.offset;
  const std::size_t wEnd = info.offset + info.count;
  const double startOffset = info.startFrameOffset;

  if (rate >= 0) {
    if (loop_ && vri >= endFrame) {
      vri = std::min(startFrame, static_cast<double>(bufLen - 1));
      pos_ = vri;
    }
    if (startOffset < 0 && rate != 0) {
      const double skipped = std::fabs(startOffset * rate);
      vri += skipped;
      playedFrames_ += skipped;
    }
  } else {
    if (loop_ && vri < startFrame) {
      vri = startFrame;
      pos_ = vri;
    }
    if (startOffset < 0) {
      const double skipped = std::fabs(startOffset * rate);
      vri -= skipped;
      playedFrames_ += skipped;
    }
    while (framesToProcess > 0 && vri >= bufLen) {
      ++w;
      vri += rate;
      --framesToProcess;
    }
  }

  bool stopping = false;
  if (durationGiven_) {
    const double maxSource = grainDuration_ * buf_->sampleRate;
    const double left = maxSource - playedFrames_;
    if (left <= 0.0) {
      framesToProcess = 0;
      stopping = true;
    } else if (rate != 0.0) {
      const double until = std::ceil(left / std::fabs(rate));
      if (until < framesToProcess) {
        framesToProcess = static_cast<int>(until);
        stopping = true;
      }
    }
  }
  if (!loop_ && ((rate >= 0 && vri >= bufLen) || (rate < 0 && vri < 0))) {
    vri = std::clamp(vri, 0.0, static_cast<double>(bufLen));
    framesToProcess = 0;
    stopping = true;
  }

  const unsigned max_index = bufLen - 1;
  if (rate == 1 && vri == std::floor(vri) && deltaFrames == std::floor(deltaFrames) &&
      endFrame == std::floor(endFrame)) {
    // ProcessFastPath
    unsigned readIndex = static_cast<unsigned>(vri);
    const unsigned deltaU = static_cast<unsigned>(deltaFrames);
    const unsigned endU = static_cast<unsigned>(endFrame);
    while (framesToProcess > 0) {
      const int toEnd = static_cast<int>(endU - readIndex);
      const int fThis = std::clamp(toEnd, 0, framesToProcess);
      for (unsigned c = 0; c < nch; ++c)
        for (int i = 0; i < fThis; ++i) {
          const auto u = static_cast<unsigned>(i);
          out[c][w + u] = sampleAt(c, readIndex + u);
        }
      w += static_cast<std::size_t>(fThis);
      readIndex += static_cast<unsigned>(fThis);
      framesToProcess -= fThis;
      double temp = readIndex;
      if (deltaU == 0) {
        ended_ = true;
        break;
      }
      if (temp >= endU) {
        if (!loop_) {
          ended_ = true;
          readIndex = std::min(readIndex, bufLen);
          break;
        }
        const double overflow = temp - endU;
        temp = endU - static_cast<double>(deltaU) + std::fmod(overflow, static_cast<double>(deltaU));
      }
      readIndex = static_cast<unsigned>(temp);
    }
    vri = readIndex;
  } else {
    for (int i = 0; i < framesToProcess; ++i) {
      unsigned r0 = static_cast<unsigned>(vri);
      const double f = vri - r0;
      unsigned r1 = r0 + 1;
      if (loop_ && r0 < endFrame && r1 >= endFrame) {
        double wrapped;
        if (deltaFrames >= 1.0) {
          wrapped = vri + 1.0 - deltaFrames;
        } else if (deltaFrames > 0) {
          wrapped = startFrame + std::fmod(vri + 1.0 - startFrame, deltaFrames);
        } else {
          wrapped = startFrame;
        }
        r1 = wrapped >= 0 ? static_cast<unsigned>(wrapped) : 0;
      } else if (r1 >= bufLen) {
        r1 = r0;
      }
      r0 = std::min(r0, max_index);
      r1 = std::min(r1, max_index);
      for (unsigned c = 0; c < nch; ++c) {
        double s;
        if (r0 == r1 && r0 >= 1) {
          const double s1 = sampleAt(c, r0 - 1), s2 = sampleAt(c, r0);
          s = s2 + (s2 - s1) * f;
        } else {
          const double s1 = sampleAt(c, r0), s2 = sampleAt(c, r1);
          s = (1.0 - f) * s1 + f * s2;
        }
        out[c][w] = static_cast<float>(std::clamp(s, -static_cast<double>(FLT_MAX), static_cast<double>(FLT_MAX)));
      }
      ++w;
      vri += rate;
      if (deltaFrames <= 0) {
        ended_ = true;
        break;
      }
      if (rate >= 0 && vri >= endFrame) {
        if (!loop_) {
          ended_ = true;
          vri = std::min(vri, static_cast<double>(bufLen));
          break;
        }
        const double overflow = vri - endFrame;
        vri = endFrame - deltaFrames + std::fmod(overflow, deltaFrames);
      } else if (rate < 0 && vri < startFrame) {
        if (!loop_) {
          ended_ = true;
          vri = std::max(0.0, vri);
          break;
        }
        const double overflow = startFrame - vri;
        vri = startFrame + deltaFrames - std::fmod(overflow, deltaFrames);
      }
    }
  }

  if (rate != 0) playedFrames_ += static_cast<double>(w - info.offset) * std::fabs(rate);
  if (stopping) {
    for (unsigned c = 0; c < nch; ++c)
      if (w < wEnd) std::memset(out[c] + w, 0, (wEnd - w) * sizeof(float));
    ended_ = true;
  }
  pos_ = vri;
}

}  // namespace rig::wa
