// SongGraph (T13): the song / graph half of audio.js on the control thread. prepare / commit / tokens / instSeq
// (audio.js:586-648, 846-898), instrument + strip reuse, RETIRE into the retiring channels (MoveUnit: state kept;
// disposed once the instrument's live voice count has been 0 for 1 s, polled every 0.25 s on the audio clock,
// audio.js:1029-1068), the slot rows the Model owns (slots.<i>.gain with 10 ms coalescing and trackedMove, the
// stored-only rows, bendEnabled, release; audio.js _setSlotParam), the song routing state and the wheel factors a
// commit needs (fresh strips start at their wheel factor, audio.js REVIEW #11), eqAudition, settings.dynamicRange,
// stats and state. 1..16 slots: slots 4..15 follow exactly the slot-0 rules (DECISIONS D3); a 4-slot song is the
// web engine's song.
//
// Owned by T13 (BUILD_PLAN). T14 (perform) reads channel targets through instUnitOf() and writes the wheel values.
#pragma once
#include <cmath>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "graph/unit.h"
#include "model/build_worker.h"  // CORE3
#include "model/graph_build.h"
#include "model/patch.h"
#include "time/coalescer.h"

struct yyjson_val;

namespace rig {

class Model;
class JsonOut;
struct ParamRow;

/** Song routing (contract 2.2 modWheel / expression / volume / bend / swell; audio.js _routing). */
struct Routing {
  struct Wheel {
    std::string target;
    double min = 0, max = 1;
    bool logCurve = false;  // expression `curve: 'log'` (shared/touch-curve.js pedalCurve)
  };
  Wheel mod{"slots.1.gain"}, expr{"slots.1.gain"};
  std::string volTarget = "master.volume";
  std::string bendMode = "pitch";
  double bendRange = 2;
  double swellSeconds = 8;
  bool swellPedal = false;
};

/** Wheel values 0..1 (audio.js this.wheel, start {1, 1, 1}); T14's setWheel writes them. */
struct WheelValues {
  double mod = 1, expr = 1, vol = 1;
};

/** A recorded param move (fx.js trackedMove / moveAt): linear over `dur`, or setTarget with `tc`, or a set. */
struct Move {
  double from = 0, to = 0, t0 = 0, dur = 0, tc = 0;
  double at(double t) const;
};

/** One slot channel: instrument (+ its shell) and strip; live in Inst<i>/Strip<i>, or retiring in RetireInst/Strip<j>.
 */
struct Channel {
  bool live = false;
  std::uint32_t id = 0;  // unique per engine (> 0); note targets resolve through it (instUnitOf)
  int slot = -1;         // origin slot 0..15
  int retire = -1;       // retiring channel index 0..31 while retiring
  bool hasInst = false;
  std::string kind;  // "inst.<type>" (empty without an instrument)
  InstShell *shell = nullptr;  // owned by the graph once attached; valid while this channel is live
  SlotPatch cfg;               // the slot config it plays (audio.js sc.cfg)
  Move fader;                  // sc.faderMove
  double wheel = 1;            // wheel factor last sent
  double morph = 0;            // sc.morph
  double zeroSince = NAN;      // retire poll: first audio time seen with no live voice
};

class SongGraph {
 public:
  explicit SongGraph(Model &m);
  ~SongGraph();
  SongGraph(const SongGraph &) = delete;
  SongGraph &operator=(const SongGraph &) = delete;

  // ---- 1.2 song switching --------------------------------------------------------------------------------------
  /** Builds the plan (instruments + strips of fresh slots, reuse of matching ones); only the latest token commits. */
  std::uint32_t prepare(PatchSpec &&patch, std::uint32_t token);
  bool commit(std::uint32_t token, double when);

  // ---- 1.3 rows the Model owns ---------------------------------------------------------------------------------
  /** `slots.<i>.*` rows without a module handler. Returns the JS boolean (false = slot empty / not applicable). */
  bool setSlotRow(const ParamRow &row, int slot, double v, double glide, double when, double prevGain);
  /** audio.js eqAudition: true for any slot 0..15 (also empty, T02 #4); the strip hears it when it exists. */
  bool eqAudition(int slot, std::string_view mode, double when);
  bool auditioned(int slot) const { return slot >= 0 && slot < kMaxSlots && (bypass_ >> slot & 1u); }
  double setDynamicRange(double range);
  double dynamicRange() const { return dynRange_; }
  /** The engine's 10 ms coalescer (fx.js Coalescer, contract 2.3 "co") for the Model's rows; `when` < 0 = now. */
  bool coalesce(std::string_view key, double when, std::function<void(double)> fn) {
    co_.push(key, tOf(when), std::move(fn));
    return true;
  }

  // ---- state for the Model, services and T14 ---------------------------------------------------------------------
  const Channel &channel(int slot) const { return slots_[slot]; }
  const Channel &retiring(int j) const { return retiring_[j]; }
  int retiringCount() const;
  /** Where the instrument of channel `id` plays now: Inst<i>, RetireInst<j>, or UnitSlot::Count (disposed). */
  UnitSlot instUnitOf(std::uint32_t channelId) const;
  /** W3A (T13 review O4): the frame from which the Model's current occupant of `u` plays (the gate's slotFrame). */
  std::int64_t occupantFrame(UnitSlot u) const { return slotFrame_[static_cast<std::size_t>(u)]; }
  /** A live or retiring channel by id, or nullptr (disposed). */
  const Channel *channelById(std::uint32_t id) const;
  /** The live channel of slot i, or nullptr (audio.js this.slots[i]). */
  const Channel *liveChannel(int slot) const { return slots_[slot].live ? &slots_[slot] : nullptr; }
  /** Instrument id of the channel whose instrument sits in `inst` (Inst* or RetireInst*), "" = none (T11 O3). */
  std::string instIdAt(UnitSlot inst) const;
  const Routing &routing() const { return routing_; }
  /** audio.js setRouting(r, {when}): merged into the song routing, the wheel factors follow (tau 30 ms). */
  void setRouting(const yyjson_val *r, double when);
  WheelValues &wheel() { return wheel_; }
  /** audio.js _macro / _factorFor / _slotWheelFactor / _morphFor over the current routing and wheel values. */
  std::optional<double> macro(std::string_view name) const;
  double factorFor(std::string_view target) const;
  double slotWheelFactor(int slot) const;
  double morphFor(const Channel &c) const;
  /** audio.js _applyWheels(t, tc) for the strips (wheel gain rampTo tc) and the morph of the live channels. T14
   *  extends it with the drone / reverb return / master wheels, macro.wash and the bend morph (coalesced 'wheels'). */
  void applyWheels(double t, double tc);
  /** Called when a retiring channel is disposed (perform state drops its pedaled notes, audio.js _unpedal). */
  void setDisposeHook(std::function<void(std::uint32_t channelId)> fn) { onDispose_ = std::move(fn); }
  bool planPending() const { return plan_ != nullptr; }

  // ---- CORE3 (CORE2A O2): synth / organ builds off the control thread, neighbour prebuilds ----------------------
  // Realtime only (offline every unit is built inline at prepare, as before: renders are unchanged). prepare posts
  // the instruments of kinds offThreadKind() to the build worker (model/build_worker.h) and builds the strips inline;
  // the plan is "built" once every job is done. commit finishes a job still pending (claims and builds it inline, or
  // waits for the worker), so a commit always takes effect at once.
  /** Control loop, every turn: runs the pending plan's whenBuilt callbacks once its builds are all done. */
  void pumpBuilds();
  /** fn runs on the control thread once the plan of `token` has every unit built: at once when it has, when the
   *  token is not the pending plan's (committed, superseded), and at the latest at its commit. Dropped (never run)
   *  when the plan is superseded or destroyed: the bridge has answered those prepares already. */
  void whenBuilt(std::uint32_t token, std::function<void()> fn);
  /** True when the pending plan (if any) has no build in flight. */
  bool planBuilt() const;
  /** The worker's wake (any thread; Engine: wakeControl through its WakeLink). */
  void setBuildWake(std::function<void()> fn);
  /** `cache preload` with a pin (contract 1.2; controller.js pinWindow / preloadNeighbors: the songs around the
   *  current one): prebuild the synth / organ units of these patches in the background, so a switch to one of them
   *  adopts them and builds nothing. LRU, capped at prebuildCapBytes(); slots the playing song would reuse are
   *  skipped. Realtime only. */
  void prebuild(const std::vector<PatchSpec> &patches);
  /** Memory pressure / tests: drop every prebuilt unit. */
  void dropPrebuilt();
  std::size_t prebuiltCount() const { return prebuilt_.size(); }
  std::size_t prebuiltBytes() const;
  std::size_t prebuildCapBytes() const;
  /** Build jobs queued or running on the worker (tests). */
  std::size_t buildsPending() const { return worker_ ? worker_->pending() : 0; }

  /** Every Model command passes here (Model::send). Units change at a commit's frame, which may lie ahead (a commit
   *  `when` in the future, e.g. an offline render posting the whole song up front); the Model's view of a unit slot
   *  changes at once. So a command for a slot whose occupant changes at frame F > now is moved to F (after the
   *  attach / move by submission order): it reaches the unit the Model meant (JS automates that very AudioParam).
   *  Attach / Detach / MoveUnit record F for their slots. `now` = the published time-grid frame. */
  void gate(Command &c, std::int64_t now);
  /** A device rate change: retiring synth.js instruments get the new rate's wavetables too (T11 O3); the gate's
   *  frames are rescaled like the graph's pending commands. */
  void onRateChanged(double sampleRate, double oldRate);
  void statsFields(std::string &out) const;
  void stateFields(JsonOut &j) const;

  struct Counters {
    std::uint32_t built = 0, reused = 0, retired = 0, disposed = 0, discarded = 0, forcedRetire = 0, prefaulted = 0;
    // CORE3: instruments built on the worker, built inline by a commit that came before its build, adopted from the
    // prebuilt set, prebuild jobs posted, prebuilt units evicted (LRU / cap / memory pressure / rate change)
    std::uint32_t offThread = 0, atCommit = 0, prebuildHits = 0, prebuildPosted = 0, prebuildEvicted = 0;
  };
  const Counters &counters() const { return n_; }

 private:
  struct PlanSlot {
    enum Kind { None, Reuse, Fresh } kind = None;
    std::uint32_t reuseId = 0;
    BuiltChannel built;
    std::shared_ptr<BuildJob> job;  // CORE3: the instrument, built off the control thread (built.inst null until commit)
  };
  struct Plan {
    std::uint32_t token = 0;
    PatchSpec patch;
    PlanSlot slots[kMaxSlots];
    Routing routing;
    std::vector<std::function<void()>> onBuilt;  // CORE3: whenBuilt callbacks
  };
  struct Prebuilt {  // CORE3: a neighbour's instrument, built (or being built) ahead of its song switch
    std::string key;
    std::shared_ptr<BuildJob> job;
    std::uint64_t used = 0;
    std::size_t bytes = 0;
  };

  // graph_build.cpp
  BuiltChannel build(const PatchSpec &patch, int slot, double sampleRate = 0);  // 0 = the engine's rate now
  void discard(Plan &plan);
  bool attachBuilt(UnitSlot slot, const std::string &kind, Unit *u, double when, int channel);
  void instrumentSetup(UnitSlot slot, const std::string &kind, std::int64_t frame);
  // CORE3 (graph_build.cpp)
  bool realtime() const;
  bool offThreadKind(const SlotPatch &sp) const;
  Unit *buildStrip(const PatchSpec &patch, int slot, double sampleRate);
  std::shared_ptr<BuildJob> makeJob(const SlotPatch &sp, int slot, double sampleRate);
  void startFresh(Plan &plan, int slot);
  void takeBuilt(Plan &plan);
  void fireBuilt(Plan &plan);
  BuildWorker &worker();
  static std::string buildKey(const SlotPatch &sp, int slot, double sampleRate);
  std::shared_ptr<BuildJob> takePrebuilt(const std::string &key);
  void keepPrebuilt(const std::string &key, std::shared_ptr<BuildJob> job);
  void evictPrebuilt(std::size_t capBytes);
  // retire.cpp
  void retire(int slot, double when);
  int pickRetireIndex();
  void armRetirePoll(double t);
  void pollRetiring(double t);
  void dispose(int j);
  // song.cpp
  bool paramsMatch(const SlotPatch &have, const SlotPatch &want) const;
  void applyFresh(Channel &c, double when);
  void applyReused(Channel &c, const SlotPatch &cfg, const SlotPatch &prev, double when);
  void faderMove(Channel &c, double to, double when, double glide, double fallback);
  void sendParamOps(UnitSlot u, std::uint32_t index, std::initializer_list<Command> cmds);
  void sendInstParam(const Channel &c, std::uint32_t index, double v, double t);
  void sendRelease(const Channel &c, double release, double when);
  static void parseRouting(const std::string &json, Routing &r);
  static void mergeRouting(const yyjson_val *r, Routing &into);
  /** audio.js _t(when): `when` when it lies ahead of the engine clock, else now (automation times). */
  double tOf(double when) const;

  Model &m_;
  std::unique_ptr<Plan> plan_;
  std::uint32_t latestToken_ = 0, nextChannelId_ = 1;
  Channel slots_[kMaxSlots];
  Channel retiring_[kRetiring];
  bool pollArmed_ = false;
  Routing routing_;
  WheelValues wheel_;
  Coalescer co_;
  std::int64_t slotFrame_[kUnitSlots];  // frame from which the Model's current occupant of each unit slot plays
  std::uint32_t bypass_ = 0;  // eqAudition 'bypass' per slot (audio.js _eqBypass)
  double dynRange_ = 1;
  std::function<void(std::uint32_t)> onDispose_;
  Counters n_;
  std::vector<Prebuilt> prebuilt_;  // CORE3: LRU by `used`
  std::uint64_t useClock_ = 0;
  std::function<void()> buildWake_;
  std::unique_ptr<BuildWorker> worker_;  // CORE3: created on first realtime use; declared last = joined first
};

/** Implemented in model/perform.cpp (STOPGAP(T12) overlay, T14): a disposed channel's pedaled notes go; a Model's
 *  perform state is forgotten when it is destroyed. */
void performChannelDisposed(const Model &m, std::uint32_t channelId);
void performForget(const Model &m);

/** A slot of a patch that plays (audio.js normalizePatch: an instrument with type and id; null otherwise). */
inline bool slotUsed(const SlotPatch &sp) {
  return sp.present && !sp.instType.empty() && !sp.instId.empty();
}

}  // namespace rig
