// ReverbPool: the "reverb" service (model/services.h ReverbService) = the control half of fx.js Reverb: which IR
// plays when (stage / commitTo / request / warm / retain), the pool of built kernels (LRU, capped in units AND in
// bytes), the predelay crossfade bookkeeping, the deferred / quiet-gated builds (v11-memory, v11-reverb-quiet) and the
// IR worker. Control thread only (the worker thread touches only its job and the mailbox).
//
// Native differences (contract 3.4 allows them; reported by T04):
//  - A kernel is built off the audio thread in one piece (IR + partition spectra), so commit never blocks; the quiet
//    rules still decide WHEN a deferred or speculative space starts playing (same "which IR plays" outcome).
//  - The pool holds kernels; the running state (convolver history + predelay lines) lives only in the render
//    unit's slots (at most kReverbSlots). Swapping back to a space whose unit still sits in a slot reuses that state
//    (its tail rings on, as in JS); a space rebuilt from the pool starts silent.
//  - No IR cache besides the kernels (IR_CACHE_MAX 12 in JS): rebuilding an IR is cheap natively.
//  - Effective size: callers that know the wheels (T14, macro.wash) call request() / stage() with lerp(size, .9, W);
//    the set handler and onCommit use the patch size.
#pragma once
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "fx/reverb_unit.h"
#include "model/services.h"

namespace rig {
class Model;
struct UnitEnv;
struct UnitSpec;
struct PatchSpec;
}  // namespace rig

namespace rig::fx {

inline constexpr double kReverbQuietSec = 2;      // REVERB_QUIET_SEC
inline constexpr double kReverbWarmQuietSec = 6;  // REVERB_WARM_QUIET_SEC
inline constexpr double kReverbQuietPoll = 0.02;  // REVERB_QUIET_POLL_SEC
inline constexpr double kReverbDebounce = 0.3;    // Reverb.request debounce (event time)

class ReverbPool final : public ReverbService {
 public:
  using KernelPtr = std::shared_ptr<const ReverbKernel>;
  struct Stage {
    std::string key;
    double size = 0.5, damp = 0.5;
    bool deferred = false;
  };

  explicit ReverbPool(Model &m);
  ~ReverbPool() override;

  /** The pool of the engine whose Model owns `patch` (UnitSpec::patch), or null. */
  static ReverbPool *forPatch(const PatchSpec *patch);

  // ---- Service / ReverbService ----
  bool retain(const yyjson_val *patches) override;
  void onCommit(const PatchSpec &patch, double when) override;
  void onRateChanged(double sampleRate) override;
  void onMemoryPressure(int level) override;
  std::string statsFields() override;

  // ---- fx.js Reverb API (also for T13 prepare / T14 wheels) ----
  /** The render unit for UnitSlot::Reverb (makeReverb): Reverb.init with the patch's space. */
  Unit *buildUnit(const UnitEnv &env, const UnitSpec &spec);
  /** prepare phase: make sure the space exists (offline: built now; realtime: on the worker). `defer` (keys held):
   *  a space not built yet is only started; commitTo then waits for a pause. */
  Stage stage(double size, double damp, bool defer = false);
  /** commit phase: switch to the staged space and/or predelay at `when` (engine s; < 0 = now). */
  void commitTo(const Stage *stage, double predelay, double when);
  /** Live size / damp edit (knob, macro.wash): 300 ms debounce, then build + 0.8 s crossfade. */
  void request(double size, double damp, double when, bool quiet = false);
  /** Live predelay edit: 0.5 s crossfade between the active unit's two lines (never a delayTime ramp). */
  void setPredelay(double seconds, double when);
  /** Preload: build a neighbour's space after REVERB_WARM_QUIET_SEC of quiet (realtime only). */
  void warm(double size, double damp);
  /** Seconds of player quiet (fx.js env.quietFor: 0 while keys are held / the pedal is down). Until T14 installs
   *  one, the player counts as always quiet (builds still wait for the time since the last build). */
  void setQuietProbe(std::function<double()> probe) { quietFor_ = std::move(probe); }
  /** Tests: run the realtime policy (async builds, quiet gate, deferral) in an offline engine; builds stay inline
   *  (delivered at once instead of by the worker). */
  void setSimulateRealtime(bool on) { offline_ = !on && inline_; }
  /** Tests: build kernels with this instead of the IR generator (e.g. an identity IR). */
  using BuildFn = std::function<KernelPtr(const std::string &key, double sampleRate, double size, double damp)>;
  void setBuildOverride(BuildFn fn) { override_ = std::move(fn); }
  /** Build a space into the pool without staging it (offline: now; realtime: on the worker). */
  void ensureBuilt(double size, double damp);

  /** Deliver finished worker builds (also polled by a control timer every 20 ms while builds run). */
  std::size_t pump();
  /** Block until no build is running or waiting for the worker (tests, rig_offline_wait). */
  void waitBuilds();

  // ---- limits and introspection ----
  void setLimits(unsigned maxUnits, std::size_t maxBytes);
  unsigned maxUnits() const { return maxUnits_; }
  std::size_t maxBytes() const { return maxBytes_; }
  std::size_t units() const { return pool_.size(); }
  /** Kernels in the pool + the running state of every occupied render slot (T00c, T04 finding 1). */
  std::size_t bytes() const;
  std::size_t kernelBytes() const;
  std::vector<std::string> keys() const;  // LRU order, oldest first
  bool has(const std::string &key) const { return pool_.count(key) != 0; }
  std::string activeKey() const;
  std::string targetKey() const;
  std::string irKeyFor(double size, double damp) const;
  std::size_t quietWaiting() const;
  unsigned quietBuilds() const { return quietBuilds_; }
  unsigned deferredBuilds() const { return deferredBuilds_; }
  unsigned kernelBuilds() const { return builds_; }
  double activePredelay() const;

 private:
  enum class SlotState { Empty, Active, Fading, Idle };
  struct SlotMirror {
    std::string key;
    SlotState st = SlotState::Empty;
    bool connected = false;
    double idleAt = 0;
    unsigned cur = 0;
    double pdV[2] = {0.02, 0.02};
    double pdBusyUntil = 0;
    bool pdPendingSet = false;
    double pdPending = 0;
    std::uint64_t gen = 0;  // bumped whenever the slot gets another unit (stale timer callbacks check it)
    std::uint64_t lastUse = 0;
    // T00c (T04 finding 1): ConvUnit::bytes() of the unit in this render slot (convolver FDL + buffers + predelay
    // lines; about as large as the kernel), counted in bytes() until the slot is released
    std::size_t stateBytes = 0;
  };
  struct Need {
    double q;
    std::function<bool()> f;
  };
  using Done = std::function<void(KernelPtr)>;
  struct Inflight {
    KernelPtr kernel;  // set when the worker finished
    bool gated = false, hurried = false, claimed = false, queued = false;
    std::vector<Need> needs;
    std::vector<Done> then;
    std::uint64_t seq = 0;
  };
  struct Job {
    std::string key;
    double sr, size, damp;
    std::uint32_t seed;
  };

  double now() const;
  double t(double when) const;
  void at(double time, std::function<void(double)> fn);
  bool offline() const { return offline_; }
  bool gateActive() const { return !offline_ && static_cast<bool>(quietFor_); }
  KernelPtr buildKernel(const std::string &key, double sr, double size, double damp) const;

  KernelPtr cached(const std::string &key);
  KernelPtr unitSync(double size, double damp);
  void newUnit(const std::string &key, KernelPtr k);
  void unitAsync(double size, double damp, double quiet, std::function<bool()> need, Done cb);
  void startJob(const std::string &key, double size, double damp);
  void tryFinish(const std::string &key);
  void evict();
  bool busy(const std::string &key) const;
  void dropKernel(const std::string &key);
  void releaseSlot(unsigned s);  // T00c: ReverbOp::Release + mirror reset (an Idle slot's state goes)

  void swapUnit(const std::string &key, KernelPtr k, const Stage &st, double when, std::uint32_t seq,
                double fade = kReverbFade);
  void finishNull(const std::string &key);
  void armPoll();
  void pdTo(int slot, double p, double when);
  int slotOf(const std::string &key) const;
  int pickSlot() const;
  void sendSetPredelay(int slot, double p, double when, bool immediate);

  // quiet gate (fx.js _whenQuiet / _armQuiet / _quietTick)
  double quietNow() const;
  double waitSec(const Inflight &e) const;
  void armQuiet(double delay);
  void quietTick();

  void workerLoop();

  Model &m_;
  const void *patchKey_;
  bool offline_ = true;  // policy: OfflineAudioContext rules (sync builds, no deferral, no quiet gate)
  bool inline_ = true;   // builds run on the calling thread (offline engines), else on the IR worker
  BuildFn override_;
  std::uint32_t seed_ = 1;
  double sr_ = 48000;
  unsigned maxUnits_ = 10;
  std::size_t maxBytes_ = 160u << 20;

  std::map<std::string, std::pair<KernelPtr, std::uint64_t>> pool_;  // key -> (kernel, LRU tick)
  std::uint64_t tick_ = 0;
  std::optional<std::set<std::string>> retain_;
  std::set<std::string> songKeys_, keep_;

  bool unitBuilt_ = false;
  ReverbUnit *building_ = nullptr;  // the unit buildUnit() is constructing (not attached yet)
  SlotMirror slots_[kReverbSlots];
  int active_ = -1;
  double size_ = 0.5, damp_ = 0.5, predelayV_ = 0.02;
  std::string target_;
  std::uint32_t reqSeq_ = 0;

  std::map<std::string, Inflight> inflight_;
  std::map<std::string, KernelPtr> prebuilt_;  // finished builds nobody waits for yet (fx.js irCache role)
  std::set<std::string> jobKeys_;              // keys queued or running on the worker
  std::uint64_t inflightSeq_ = 0;
  std::function<double()> quietFor_;
  double builtAt_ = -1e300;
  bool quietArmed_ = false;
  double quietAt_ = 1e300;
  std::uint64_t quietGen_ = 0;
  unsigned quietBuilds_ = 0, deferredBuilds_ = 0, builds_ = 0;
  bool pollArmed_ = false;

  // IR worker (realtime): one thread, started on the first asynchronous build
  std::mutex mu_;
  std::condition_variable cv_;
  std::vector<Job> jobs_;
  std::vector<std::pair<std::string, KernelPtr>> mailbox_;
  std::size_t running_ = 0;
  bool stop_ = false;
  std::thread worker_;
};

}  // namespace rig::fx
