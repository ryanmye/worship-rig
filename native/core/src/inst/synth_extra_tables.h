// The "t15-tables" service (T15): control-thread wavetable work for the synth-extra / organ units.
//   * onRateChanged (T11a O4): every live synth-extra / organ unit gets the new rate's wavetables and re-attaches
//     its shared DelayNodes at that rate (T15Op::SetTables with `sampleRate`, T15 review item 4; the oscillators keep
//     their phase). Retiring channels keep the old tables until they end (as T11 O3 for synth.js).
//   * drawbarsChanged (T15 review item 3, organ.js _scheduleWave): a drawbar change arms one 30 ms timer per slot;
//     when it fires, drawbarWaves() of the slot's current params goes to the organ as a drawbars-only SetTables
//     (about 4.7 MB and 50 ms of control-thread work per rebuild, never on the audio thread).
#pragma once
#include <cstdint>
#include <memory>

#include "model/patch.h"
#include "model/services.h"

namespace rig {
class Model;
}

namespace rig::inst {

class T15TablesService final : public Service {
 public:
  static constexpr const char *kName = "t15-tables";
  explicit T15TablesService(Model &m) : m_(m) {}
  ~T15TablesService() override { *alive_ = false; }
  T15TablesService(const T15TablesService &) = delete;
  T15TablesService &operator=(const T15TablesService &) = delete;

  void onRateChanged(double sampleRate) override;
  /** organDrawbarsChanged (inst/organ.h): arm the slot's rebuild at `when` + 30 ms unless one is pending. */
  void drawbarsChanged(int slot, double when);
  /** Tests: drawbar rebuilds sent so far. */
  std::uint32_t drawbarRebuilds() const { return rebuilds_; }

 private:
  void rebuildDrawbars(int slot);

  Model &m_;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
  bool pending_[kMaxSlots] = {};
  std::uint32_t rebuilds_ = 0;
};

}  // namespace rig::inst
