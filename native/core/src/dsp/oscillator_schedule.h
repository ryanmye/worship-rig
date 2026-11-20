// Shared start/stop scheduling of the source nodes: a port of Chromium 157.0.8103.78
// third_party/blink/renderer/modules/webaudio/audio_scheduled_source_handler.cc (UpdateSchedulingInfo) and
// platform/audio/audio_utilities.cc (TimeToSampleFrame). BSD-3, The Chromium Authors (third_party/chromium/LICENSE).
// Used by Oscillator, BufferSource and ConstantSource (T11a). Header-only, RT-safe, no allocation.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace rig::wa::sched {

enum class Rounding { Nearest, Up };

/** audio_utilities::TimeToSampleFrame: round at 1/1024 frame first so that Fs * (k / Fs) gives k back. */
inline std::uint64_t timeToSampleFrame(double time, double sampleRate, Rounding mode = Rounding::Nearest) {
  double frame = std::round(time * sampleRate * 1024.0) / 1024.0;
  frame = mode == Rounding::Up ? std::ceil(frame) : std::round(frame);
  if (!(frame < static_cast<double>(std::numeric_limits<std::uint64_t>::max()))) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  return frame < 0 ? 0 : static_cast<std::uint64_t>(frame);
}

/** The lifecycle of an AudioScheduledSourceHandler. */
struct State {
  double start = -1.0;  // start time in seconds, < 0 = unscheduled
  double end = -1.0;    // end time (kUnknownTime = -1)
  bool playing = false;
  bool finished = false;

  bool scheduled() const { return start >= 0.0 && !playing && !finished; }
  /** AudioScheduledSourceHandler::Start: start_time = max(when, currentTime); a second start() is ignored. */
  void startAt(double when) {
    if (start >= 0.0 || !(when >= 0.0)) return;
    start = when;
  }
  /** Stop: only after start(); the last call wins unless the node already finished. */
  void stopAt(double when) {
    if (start < 0.0 || finished) return;
    end = when < 0.0 ? 0.0 : when;
  }
};

struct Info {
  std::size_t offset = 0;      // first frame of the quantum that is not silence
  std::size_t count = 0;       // frames to render from `offset`
  double startFrameOffset = 0;  // true start minus the rounded-up start frame (frames, usually <= 0)
  bool silentAll = true;       // nothing to render
};

/**
 * UpdateSchedulingInfo for the quantum [frame0, frame0 + n). Before the start frame, after the end frame and in a
 * finished node the quantum is silence. `out` channels must already be zeroed by the caller for the silent parts:
 * the caller zero-fills the whole quantum first and renders into [offset, offset + count).
 */
inline Info update(State &s, std::int64_t frame0, double sr, std::size_t n) {
  Info r;
  if (s.start < 0.0) return r;  // unscheduled
  // A start in the past starts now (Chromium clamps to currentTime when start() is called).
  const double now = static_cast<double>(frame0) / sr;
  if (s.scheduled() && s.start < now) s.start = now;
  const std::uint64_t qStart = static_cast<std::uint64_t>(frame0 < 0 ? 0 : frame0);
  const std::uint64_t qEnd = qStart + n;
  const std::uint64_t startFrame = timeToSampleFrame(s.start, sr, Rounding::Up);
  std::uint64_t endFrame = 0;
  if (s.end >= 0.0) endFrame = timeToSampleFrame(s.end, sr, Rounding::Up);
  if (s.end >= 0.0 && endFrame <= qStart) s.finished = true;
  if (s.finished || startFrame >= qEnd) return r;
  if (!s.playing) {
    s.playing = true;
    r.startFrameOffset = s.start * sr - static_cast<double>(startFrame);
  }
  r.offset = startFrame > qStart ? static_cast<std::size_t>(startFrame - qStart) : 0;
  r.offset = std::min(r.offset, n);
  r.count = n - r.offset;
  if (!r.count) return r;
  if (s.end >= 0.0 && endFrame >= qStart && endFrame <= qEnd) {
    if (endFrame < qEnd) {
      const std::size_t zeroStart = static_cast<std::size_t>(endFrame - qStart);
      const std::size_t framesToZero = n - zeroStart;
      r.count = framesToZero > r.count ? 0 : r.count - framesToZero;
    }
    s.finished = true;
  }
  r.silentAll = r.count == 0;
  return r;
}

}  // namespace rig::wa::sched
