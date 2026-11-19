// Master EQ (inside the master chain): lowshelf 100 Hz, peaking 1 kHz Q .8, highshelf 8 kHz, gains +-12 dB
// (tau 15 ms, k-rate biquads). Interface FROZEN by T00b; T02 implements (mix/master_eq.cpp) and registers set
// handler "fx.eq."; T03's MasterChain owns one instance and exposes its gains as kMasterEqLow/Mid/High.
#pragma once
#include <cstdint>

#include "graph/unit.h"

namespace rig {
namespace wa {
class Param;
}

class MasterEq {
 public:
  MasterEq(double sampleRate, double lowDb, double midDb, double highDb);
  ~MasterEq();
  MasterEq(const MasterEq &) = delete;
  MasterEq &operator=(const MasterEq &) = delete;

  /** In place over bus.channels channels; `frame0`/`sampleRate` evaluate the gain params (k-rate). */
  void process(Bus &bus, std::int64_t frame0, double sampleRate);
  void setSampleRate(double sr);
  /** 0 low, 1 mid, 2 high (dB). */
  wa::Param *gain(int band);

 private:
  struct Impl;
  Impl *impl_;
};

}  // namespace rig
