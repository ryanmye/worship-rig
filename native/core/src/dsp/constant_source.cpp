// ConstantSource: a port of Chromium 157.0.8103.78 constant_source_handler.cc (BSD-3, The Chromium Authors;
// third_party/chromium/LICENSE). The a-rate offset param is rendered for the whole quantum (Param is stateless in the
// frame) and copied into the active part; an unautomated offset of exactly 0 is silence.
#include "dsp/constant_source.h"

#include <cstring>

#include "dsp/oscillator_schedule.h"

namespace rig::wa {

void ConstantSource::start(double t) {
  sched::State s{start_, stop_, playing_, finished_};
  s.startAt(t);
  start_ = s.start;
}

void ConstantSource::stop(double t) {
  sched::State s{start_, stop_, playing_, finished_};
  s.stopAt(t);
  stop_ = s.end;
}

void ConstantSource::process(std::int64_t frame0, double sampleRate, float *out, std::size_t n) {
  if (n > Param::kQuantum) n = Param::kQuantum;
  std::memset(out, 0, n * sizeof(float));
  sched::State st{start_, stop_, playing_, finished_};
  const sched::Info info = sched::update(st, frame0, sampleRate, n);
  start_ = st.start;
  playing_ = st.playing;
  finished_ = st.finished;
  if (info.silentAll) return;
  float v[Param::kQuantum];
  offset_.processARate(frame0, sampleRate, v, n);
  std::memcpy(out + info.offset, v + info.offset, info.count * sizeof(float));
}

}  // namespace rig::wa
