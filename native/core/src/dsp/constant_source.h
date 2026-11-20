// ConstantSource: ConstantSourceNode (an a-rate offset Param as a signal; fx.js uses one, SETUP_REVIEW 3).
// Interface FROZEN by T00b; T11a implements (dsp/constant_source.cpp).
#pragma once
#include <cstddef>
#include <cstdint>

#include "time/param.h"

namespace rig::wa {

class ConstantSource {
 public:
  explicit ConstantSource(double offset = 1.0) : offset_(offset) {}
  Param &offset() { return offset_; }
  void start(double t);
  void stop(double t);
  bool finished() const { return finished_; }  // INTERFACE-CHANGE(T11a): additive accessor
  void process(std::int64_t frame0, double sampleRate, float *out, std::size_t n);

 private:
  Param offset_;
  double start_ = -1.0, stop_ = -1.0;
  bool playing_ = false, finished_ = false;  // INTERFACE-CHANGE(T11a)
};

}  // namespace rig::wa
