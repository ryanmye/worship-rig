// Model (control thread): engine state and policy; emits timestamped Commands. Public surface FROZEN by T00b: one
// method per contract section 1 member (names mirror the JS ones), plus the module helpers modules call from their
// set handlers and services. Bodies are skeletons: what a wave task owns is reached through the registry
// (api/registry.h: units, set handlers, services) so no task edits model.cpp; T13/T14 replace the skeleton policy
// (retire, coalescing, routing, wheels, notes) inside model/ files they own (BUILD_PLAN).
//
// Return conventions: bool = the JS boolean; std::string results are complete JSON values, and an EMPTY string
// means "unsupported in this build" (the bridge replies {ok:false, error:{code:'unsupported'}}).
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "api/registry.h"
#include "graph/graph.h"
#include "graph/unit.h"
#include "model/patch.h"
#include "model/services.h"
#include "runtime/command.h"

struct yyjson_val;

namespace rig {

/** What the Model needs from the engine. Implemented by Engine. */
class CommandSink {
 public:
  virtual ~CommandSink() = default;
  virtual bool send(Command c) = 0;  // stamps seq; false when the queue is full
  /** Latest published clock (time-grid frame + rate; graph/graph.h TimeBase). */
  virtual TimeBase timeBase() const = 0;
  /** Queue one bridge event (JSON object text) for the event callback. */
  virtual void emit(std::string &&json) = 0;
  /** Run fn on the control thread at engine time t (AudioTimer semantics, quantised; contract 0). */
  virtual void at(double t, std::function<void(double)> fn) = 0;
};

struct SetResult {
  enum Status { Applied, NotApplied, Unknown, Bad } status = Applied;
  std::string message;
};

struct ModelStats {
  std::uint32_t prepares = 0, commits = 0, sets = 0, notesOn = 0, notesOff = 0, voicesEnded = 0, droppedCommands = 0;
  std::uint32_t unitsAttached = 0, unitsFreed = 0, rateChanges = 0, memoryWarnings = 0;
};

class Model {
 public:
  Model(CommandSink &sink, const UnitEnv &env);
  ~Model();
  Model(const Model &) = delete;
  Model &operator=(const Model &) = delete;

  // ---- 1.1 lifecycle ------------------------------------------------------------------------------------------
  /** The audio output started (bridge `audio start`): build the global units (FX, master, click, drone, sinks). */
  void audioStarted(double when);
  bool sleep(double ramp);  // T08: realtime only; skeleton returns false
  bool wake(double ramp);
  const char *sleepState() const;
  std::string sleepBlockersJson() const;  // ["voices", ...]
  bool setLowResource(bool on);
  bool lowResource() const { return lowResource_; }

  // ---- 1.2 song switching and memory ----------------------------------------------------------------------------
  std::uint32_t prepare(PatchSpec &&patch);
  /** False when the token is unknown (stale). `when` < 0 means now. */
  bool commit(std::uint32_t token, double when);
  std::string preload(const yyjson_val *patches, std::string_view pin);  // "cache" service
  std::string estimatePreloadMB(const yyjson_val *patches);              // "cache" service
  bool retainReverb(const yyjson_val *patches);                          // "reverb" service
  bool reloadManifests();                                                 // "cache" service
  std::string listInstruments();                                          // "instruments" service
  std::string sampleStatus(const yyjson_val *patches);                    // "cache" service

  // ---- 1.3 parameters, routing, song-level state ----------------------------------------------------------------
  SetResult set(std::string_view path, const yyjson_val *value, double glide, double when);
  void setTranspose(int semis);
  void setRouting(const yyjson_val *routing, double when);
  void setTempo(double bpm);  // <= 0 = none
  void setTimeSig(std::string_view sig, bool newBar);
  void setKeyContext(int pc, bool minor);
  void setMono(bool on);
  bool eqAudition(int slot, std::string_view mode, double when);  // slot 0..15 (T00c D3)
  // INTERFACE-CHANGE(T00c) D1: per-slot polyphony cap (`config {polyphony}`: 32 | 64 | 128, default 64). Applied
  // to every instrument attached from now on (Op::VoiceCap right after its AttachUnit) and at once to every live
  // one (slots and retiring channels). False (unchanged) for any other value.
  bool setPolyphony(unsigned cap);
  unsigned polyphony() const { return polyphony_; }
  static constexpr unsigned kPolyphonyDefault = 64;
  bool droneSetKey(int pc, bool minor, double fade, double when);  // "drone" service
  void droneConfigure(const yyjson_val *cfg, double when);         // "drone" service
  int droneAttachFiles(const yyjson_val *files);                    // "drone" service; -1 unsupported

  // ---- 1.4 perform input ------------------------------------------------------------------------------------------
  bool noteOn(int note, int vel, double when, const yyjson_val *touch = nullptr);
  bool noteOff(int note, double when);
  bool sustain(bool down, double when);
  void pitchBend(double x, double when);
  bool setWheel(std::string_view source, double value, double when, double glide);
  bool swell(int start /* -1 toggle */, double when);
  void allNotesOff(double when);
  void panic(double when) { allNotesOff(when); }
  void fadeOutAll(double seconds, double when);
  void noteInput(double when);
  std::string wheelValuesJson() const;
  std::string runtimeStateJson() const;

  // ---- 1.5 click, meters, recording -------------------------------------------------------------------------------
  std::string clickStart(int countIn, bool quietAfter, double when);  // "click" service
  bool clickStop(double when);
  std::string setClick(const yyjson_val *cfg, double when);
  std::string clickStateJson();
  void setClockPort(const char *portId);
  void subscribeMeters(const yyjson_val *meters);  // "meter" service
  std::string recStart(const yyjson_val *args);    // "rec" service
  std::string recStop();

  // ---- MIDI (contract 5), host notifications, test/state --------------------------------------------------------
  std::string midiOp(const yyjson_val *msg);  // "midi" service
  void midiBytes(std::uint16_t port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs);
  bool midiPorts(const char *json, std::size_t len);
  /** rig_host_memory_pressure (SETUP_REVIEW 21a): services trim, a `warn` event is emitted. */
  void memoryPressure(int level);
  /** rig_set_paths (SETUP_REVIEW 21b): new My Samples manifest / pad folder after startup. */
  void setPaths(const EnginePaths &paths);
  const EnginePaths &paths() const { return paths_; }
  /** Audio -> control events: frees handed-back objects, counts voice ends, rate changes; offered to services. */
  void onAudioEvent(const AudioEvent &e);

  double now() const;
  const ModelStats &stats() const { return stats_; }
  bool committed() const { return committedAny_; }
  std::string stateJson() const;
  std::string statsJson() const;  // `_debugStats` members contributed by the Model and services ("k":v,...)

  // ---- module helpers (stable; used by set handlers and services) -----------------------------------------------
  const PatchSpec &patch() const { return active_; }
  PatchSpec &patchMut() { return active_; }
  const SongState &song() const { return song_; }
  const UnitEnv &env() const { return env_; }
  CommandSink &sink() { return sink_; }
  Service *service(std::string_view name) const;
  template <class T>
  T *service() const {
    return static_cast<T *>(service(T::kName));
  }
  /** Build a unit of `kind` (registry) for `slot` from the current patch and attach it at `when`. False when the
   *  kind is not registered, the factory declined, or the queue is full (the unit is freed). */
  bool attachUnit(UnitSlot slot, std::string_view kind, double when, int channel = -1);
  void detachUnit(UnitSlot slot, double when);
  /** INTERFACE-CHANGE(T00c) D3: move the live unit (state kept) from `from` to `to` at `when` (Op::MoveUnit; the
   *  unit in `to` is freed). The bookkeeping (attachedKind) moves with it. For T13's retire. */
  bool moveUnit(UnitSlot from, UnitSlot to, double when);
  /** Kind attached (or scheduled) in a slot, "" = none. */
  const std::string &attachedKind(UnitSlot slot) const { return attached_[static_cast<std::size_t>(slot)].kind; }
  bool attachedIsModule(UnitSlot slot) const { return attached_[static_cast<std::size_t>(slot)].module; }
  /** Send a module opcode to the unit in `slot` (c.op/sub/aux/f or p filled by the caller). */
  bool sendUnitOp(UnitSlot slot, Command c, double when);
  /** Same with an Owned payload (sub = kSubOwnedPayload; freed here if the queue is full). */
  bool sendOwned(UnitSlot slot, Op op, Owned *payload, double when, std::uint32_t aux = 0);
  /** contract trackedMove / rampTo on a unit param: glide > 0 = linear from the tracked value, else setTarget
   *  tau 15 ms + pinned end at t + 12 tau. Tracked per (slot, index). */
  void moveParam(UnitSlot slot, std::uint32_t index, double value, double when, double glide);
  /** Step a param at `when` (fresh channel; ParamSet at the attach frame so it lands after the attach). */
  void setParamAt(UnitSlot slot, std::uint32_t index, double value, double when);
  std::int64_t frameFor(double when) const;
  double timeFor(double when) const;
  void emit(std::string &&json) { sink_.emit(std::move(json)); }
  void warn(std::string_view message, std::string_view code);
  /** Instrument lifetime counter (contract 7.15): incremented per instrument unit built. */
  std::uint32_t instSeq() const { return instSeq_; }

 private:
  bool send(Command c);
  void ensureGlobalUnits(double when);
  bool builtinSet(const ParamRow &row, std::string_view path, int slot, double v, double glide, double when);
  void forEachService(const std::function<void(Service &)> &fn) const;

  struct Attached {
    std::string kind;
    bool module = false;
  };
  CommandSink &sink_;
  UnitEnv env_;
  std::uint32_t nextToken_ = 1;
  std::map<std::uint32_t, PatchSpec> plans_;
  PatchSpec active_;
  SongState song_;
  EnginePaths paths_;
  bool committedAny_ = false, lowResource_ = false;
  Attached attached_[kUnitSlots];
  std::map<std::uint32_t, double> tracked_;  // paramTarget -> last value sent (trackedMove)
  std::vector<std::pair<std::string, std::unique_ptr<Service>>> services_;
  std::uint32_t instSeq_ = 0;
  ModelStats stats_;
  unsigned polyphony_ = kPolyphonyDefault;  // INTERFACE-CHANGE(T00c) D1
};

}  // namespace rig
