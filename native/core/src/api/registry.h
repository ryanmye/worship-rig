// Module registry: the single self-registration point of the core. FROZEN by T00b.
//
// Adding a module = adding files. A module ships `src/<dir>/<name>_register.cpp` defining
//     void rig_register_<dir>_<name>(rig::Registry &r) { r.addUnit("reverb", &makeReverb, info); ... }
// (the function name is the file's path below src/ without `_register.cpp`, every non-alphanumeric character
// replaced by `_`; e.g. src/fx/reverb_register.cpp -> rig_register_fx_reverb). CMake globs these files and generates
// `rig_modules.inc`; ensureModulesRegistered() calls every function once per process. Test-only modules under
// tests/**/ use the same convention with the prefix `tests_` and are registered by the test binary only.
//
// Three kinds of entries:
//   - unit factories by kind name (the Model attaches units to UnitSlots; see the kind names in each module header)
//   - set handlers by PARAMS row prefix (Model::set dispatch; priority, then longest prefix)
//   - services by name (per-engine control-thread objects behind the Model's contract methods; model/services.h)
// Priority: builtins (graph/builtin_register.cpp) register at kBuiltinPriority; modules at kModulePriority replace
// them; the highest priority wins, ties go to the later registration. Register only from rig_register_* functions
// (process start, before any engine exists): the registry is not locked.
#pragma once
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "graph/unit.h"
#include "rig/rig_engine.h"

namespace rig {

struct PatchSpec;
struct SongState;
class Model;
class Service;
class BufferCacheApi;
struct SetResult;
struct ParamRow;

inline constexpr int kBuiltinPriority = 0, kModulePriority = 10;

/** Engine-wide facts every factory may need. Valid for the engine's lifetime. */
struct UnitEnv {
  double sampleRate = 48000;  // current device rate (control side view)
  std::uint32_t seed = 1;     // engine seed (rngFor(seed, name) streams, contract 0)
  const rig_config *config = nullptr;
  BufferCacheApi *cache = nullptr;  // null until T06 registers the "cache" service
};

/** What a factory builds from: the RESOLVED patch (model/patch.h) plus song state. Valid during the call only. */
struct UnitSpec {
  UnitSlot slot = UnitSlot::Count;
  int channel = -1;  // 0..15 for Inst*/Strip* (also a retiring channel's patch slot), else -1 (INTERFACE-CHANGE(T00c))
  const PatchSpec *patch = nullptr;
  const SongState *song = nullptr;
  std::uint32_t instSeq = 0;  // instrument lifetime counter (contract 7.15) for seeds: rngFor(seed, "...#instSeq")
};

using UnitFactory = Unit *(*)(const UnitEnv &, const UnitSpec &);  // nullptr = cannot build (warned by the Model)

/** Static facts about a unit kind (control side; lets rig_test_tap answer before the unit is attached). */
struct UnitInfo {
  std::uint32_t tapPoints = 0;     // bit k = unit-local tap point k exists (graph/test_points.h)
  std::uint32_t injectPoints = 0;  // bit k = unit-local inject point k exists
};

/** A `set` that reached a module: the row is validated and clamped, Model::patch() already holds the new value. */
struct SetRequest {
  const ParamRow *row;
  std::string_view path;  // concrete path ("slots.2.sends.reverb")
  int slot;               // 0..15 for slots.<i>.*, else -1 (INTERFACE-CHANGE(T00c) D3)
  double value;           // clamped numeric value (bool 0/1, enum index)
  double glide;           // s (0 = row's own smoothing)
  double when;            // engine time; < 0 = now
};
using SetHandler = bool (*)(Model &, const SetRequest &);  // false = not applied (reply applied:false)

using ServiceFactory = Service *(*)(Model &);  // per-engine control-side object, owned by the Model

class Registry {
 public:
  static Registry &global();

  void addUnit(std::string_view kind, UnitFactory f, UnitInfo info = {}, int priority = kModulePriority);
  void addSetHandler(std::string_view rowPrefix, SetHandler h, int priority = kModulePriority);
  void addService(std::string_view name, ServiceFactory f, int priority = kModulePriority);

  struct UnitEntry {
    std::string kind;
    UnitFactory factory;
    UnitInfo info;
    int priority;
  };
  struct SetEntry {
    std::string prefix;
    SetHandler handler;
    int priority;
  };
  struct ServiceEntry {
    std::string name;
    ServiceFactory factory;
    int priority;
  };
  /** Highest-priority entry for `kind`, or nullptr. */
  const UnitEntry *unit(std::string_view kind) const;
  /** Matching handler for a PARAMS row path ("fx.reverb.size", "slots.<i>.sends.reverb"): highest priority, then
   *  longest prefix, then latest registration; nullptr when none matches. */
  const SetEntry *setHandler(std::string_view rowPath) const;
  const ServiceEntry *service(std::string_view name) const;
  const std::vector<ServiceEntry> &services() const { return services_; }

 private:
  std::vector<UnitEntry> units_;
  std::vector<SetEntry> sets_;
  std::vector<ServiceEntry> services_;
};

/** Runs every generated rig_register_* once (thread-safe). Called by rig_create. */
void ensureModulesRegistered();

}  // namespace rig
