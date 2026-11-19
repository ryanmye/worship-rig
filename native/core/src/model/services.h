// Control-side services behind the Model's contract methods. FROZEN by T00b.
//
// A wave task that owns control-thread logic (click grid, MIDI parser, drone state machine, sample cache, meters,
// recorder, instrument catalogue, reverb policy) implements one of these interfaces and registers a factory with
// Registry::addService(name, ...) from its `<name>_register.cpp`. The Model creates one instance per engine at
// construction, forwards the matching contract calls, and answers `unsupported` while no service is registered.
// All methods run on the control thread (realtime) or inline (offline). JSON arguments are the bridge message
// fields as parsed (valid during the call only); JSON results are complete values ("{...}", "[...]", "null").
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#include "runtime/command.h"

struct yyjson_val;

namespace rig {

class Model;
class BufferCacheApi;
struct PatchSpec;
struct SongState;

/** Paths that can change after rig_create (rig_set_paths; SETUP_REVIEW 21b). Empty = unchanged / none. */
struct EnginePaths {
  std::string appDir, userManifest, padsDir, recordingsDir;
};

class Service {
 public:
  virtual ~Service() = default;
  /** Every audio -> control event is offered to every service after the Model's own handling. */
  virtual void onAudioEvent(const AudioEvent &) {}
  /** After the Model has committed `patch` (new units are queued for `when`). */
  virtual void onCommit(const PatchSpec &, double when) { (void)when; }
  virtual void onSongState(const SongState &) {}
  /** The audio thread adopted a new rate: rebuild rate-dependent tables, re-attach (contract 6.3; review 16). */
  virtual void onRateChanged(double sampleRate) { (void)sampleRate; }
  /** rig_host_memory_pressure: 1 = warning (drop unpinned / idle), 2 = critical (also pins beyond current song). */
  virtual void onMemoryPressure(int level) { (void)level; }
  virtual void onPaths(const EnginePaths &) {}
  /** Extra `_debugStats` members as `"k":v,...` without braces ("" = none). */
  virtual std::string statsFields() { return {}; }
};

/** "cache" (T06): preload / estimate / sampleStatus / reloadManifests (contract 1.2, 6.4 `cache`, `get`). */
class CacheService : public Service {
 public:
  static constexpr const char *kName = "cache";
  virtual std::string preload(const yyjson_val *patches, std::string_view pin) = 0;  // {decodedMB,pinnedMB,deferred}
  virtual std::string estimate(const yyjson_val *patches) = 0;                     // {mb,exact,samples,capMB}
  virtual std::string sampleStatus(const yyjson_val *patches) = 0;                 // {loaded:[],failed:[]}
  virtual bool reloadManifests() = 0;                                              // emits load{phase:'instruments'}
  /** The cache units read from (UnitEnv::cache). */
  virtual BufferCacheApi *bufferCache() = 0;
};

/** "instruments" (T11): catalogue (`get instruments`, contract 1.2 listInstruments). */
class InstrumentService : public Service {
 public:
  static constexpr const char *kName = "instruments";
  virtual std::string listJson() = 0;
};

/** "reverb" (T04): reverb pool policy outside the patch (contract 1.2 retainReverb, preload warm-ups). */
class ReverbService : public Service {
 public:
  static constexpr const char *kName = "reverb";
  virtual bool retain(const yyjson_val *patches) = 0;
};

/** "click" (T07): metronome (contract 1.5, 6.4 `click`). */
class ClickService : public Service {
 public:
  static constexpr const char *kName = "click";
  virtual std::string start(int countIn, bool quietAfter, double when) = 0;  // {t0, downbeat} | null
  virtual bool stop(double when) = 0;                                        // was running
  virtual std::string configure(const yyjson_val *cfg, double when) = 0;    // {output, auxAvailable}
  virtual std::string stateJson() = 0;
  virtual void setClockPort(const char *portId) = 0;  // MIDI clock out (null = off)
};

/** "midi" (T07): parser, port table, direct route (contract 5, 6.4 `midi`). */
class MidiService : public Service {
 public:
  static constexpr const char *kName = "midi";
  /** Raw bytes as queued by rig_midi_in (control thread drain). */
  virtual void onBytes(std::uint16_t port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs) = 0;
  virtual bool ports(const char *portsJson, std::size_t len) = 0;  // rig_host_midi_ports
  virtual std::string op(const yyjson_val *msg) = 0;               // `midi` op (listen/route/send) -> result JSON
};

/** "drone" (T16): drone state machine (contract 1.3 drone.*, 3.9). */
class DroneService : public Service {
 public:
  static constexpr const char *kName = "drone";
  virtual bool setKey(int pc, bool minor, double fade, double when) = 0;  // fade < 0 = drone.fade
  virtual void configure(const yyjson_val *cfg, double when) = 0;
  virtual int attachFiles(const yyjson_val *files) = 0;
};

/** "meter" (T08): tick builder, slot taps, RTA subscriptions (contract 6.5 `tick`, `config.meters`). */
class MeterService : public Service {
 public:
  static constexpr const char *kName = "meter";
  virtual void subscribe(const yyjson_val *meters) = 0;
};

/** "rec" (T08): recorder (contract 6.4 `rec`). */
class RecService : public Service {
 public:
  static constexpr const char *kName = "rec";
  virtual std::string start(const yyjson_val *args) = 0;  // {path}
  virtual std::string stop() = 0;                         // {path, seconds, bytes}
};

}  // namespace rig
