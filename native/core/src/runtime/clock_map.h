// Host clock <-> engine time map (T08, M3). The audio thread publishes, once per rig_render call that carries a host
// timestamp, which time-grid frame reaches the output at which host time (AudioTimeStamp.mHostTime + output latency,
// in ns). The control thread converts both ways: CoreMIDI receive times -> engine time for the direct MIDI path
// (`route.jitterFree`: + one block), engine times of MIDI clock pulses -> host times for `midi_send` (contract 3.10,
// 6.3). Lock-free (seqlock), wait-free for the writer.
#pragma once
#include <cstdint>

#include "runtime/seqlock.h"

namespace rig {

struct ClockPoint {
  std::uint64_t hostNs = 0;  // 0 = no anchor yet
  std::int64_t frame = 0;    // time-grid frame that plays at hostNs
  double sampleRate = 48000;
  std::uint32_t blockFrames = 0;  // frames of the call that published it (the jitter-free delay)
};

class ClockMap {
 public:
  /** Audio thread (rig_render). */
  void publish(std::uint64_t hostNs, std::int64_t frame, double sr, std::uint32_t block) {
    point_.write(ClockPoint{hostNs, frame, sr, block});
  }
  ClockPoint anchor() const { return point_.read(); }
  bool valid() const { return anchor().hostNs != 0; }

  /** Engine seconds at which a host instant plays (extrapolated from the last anchor); -1 without an anchor. */
  double engineTimeAt(std::uint64_t hostNs) const {
    const ClockPoint p = anchor();
    if (!p.hostNs) return -1.0;
    const double dt = (static_cast<double>(hostNs) - static_cast<double>(p.hostNs)) * 1e-9;
    return static_cast<double>(p.frame) / p.sampleRate + dt;
  }
  /** Host ns at which engine time t plays; 0 without an anchor or when t maps before host time 0. */
  std::uint64_t hostTimeAt(double t) const {
    const ClockPoint p = anchor();
    if (!p.hostNs) return 0;
    const double ns = static_cast<double>(p.hostNs) + (t - static_cast<double>(p.frame) / p.sampleRate) * 1e9;
    return ns > 0 ? static_cast<std::uint64_t>(ns + 0.5) : 0;
  }

 private:
  Seqlock<ClockPoint> point_;
};

}  // namespace rig
