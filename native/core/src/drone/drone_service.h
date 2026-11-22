// The engine's "drone" service (model/services.h DroneService + model/perform.h PerformDrone), T16: owns the
// DroneCore (drone.js Drone) of the engine, hosts it on the Model (commands to UnitSlot::Drone, audio-clock
// timers, warnings), runs pad decodes and frozen-loop renders on a worker thread (inline offline), and applies the
// low-resource freeze (DECISIONS D5 / O-W3-2: SongState.lowResource x config {droneFreeze}).
#pragma once
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "drone/drone_core.h"
#include "model/perform.h"
#include "model/services.h"

namespace rig {
class Model;
struct UnitEnv;
struct UnitSpec;
}  // namespace rig

namespace rig::drone {

/** One background thread for decodes and loop renders; results run on the control thread (Model timers). */
class DroneWorker {
 public:
  DroneWorker() = default;
  ~DroneWorker();
  /** `job` runs on the worker and returns the control-thread continuation. */
  void post(std::function<std::function<void()>()> job);
  /** Continuations ready now (control thread). */
  std::size_t drain();
  std::size_t outstanding() const;

 private:
  void loop();
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::function<std::function<void()>()>> jobs_;
  std::deque<std::function<void()>> done_;
  std::size_t outstanding_ = 0;
  bool stop_ = false;
  std::thread th_;
};

class DroneServiceImpl final : public DroneService, public PerformDrone, public DroneHost {
 public:
  explicit DroneServiceImpl(Model &m);
  ~DroneServiceImpl() override;

  /** The engine's service for a Model's patch (the unit factory's way in), null when none. */
  static DroneServiceImpl *forPatch(const PatchSpec *patch);
  /** Unit factory: builds the unit and (first time) the DroneCore, as AudioEngine._build does at start(). */
  Unit *buildUnit(const UnitEnv &env, const UnitSpec &spec);

  // DroneService
  bool setKey(int pc, bool minor, double fade, double when) override;
  void configure(const yyjson_val *cfg, double when) override;
  int attachFiles(const yyjson_val *files) override;
  // Service
  void onSongState(const SongState &s) override;
  void onRateChanged(double sampleRate) override;
  void onPaths(const EnginePaths &paths) override;
  std::string statsFields() override;
  // PerformDrone (T14 calls these)
  void droneWheel(double gain, double t, double tc) override;
  void dronePedalSwell(bool on, double t) override;
  void droneBendSwell(double x, double t) override;
  void droneNotesChanged(const std::vector<int> &held, double t) override;
  void droneSongChanged(double t) override;
  // DroneHost
  double now() const override;
  double sampleRate() const override;
  std::uint32_t seed() const override;
  bool offline() const override;
  void send(Command c, double when) override;
  void at(double t, std::function<void(double)> fn) override;
  void warn(const std::string &msg) override;
  /** INTERFACE-CHANGE(W3A) lowres2: a drone that starts wakes the audio (audio.js drone env wake -> this.wake()). */
  void wake() override;
  FreezeEnv freezeEnv() override;
  void decodePad(const std::string &path, std::function<void(std::shared_ptr<const AudioBuf>)> done) override;
  void renderLoop(const LoopRequest &req, std::function<void(LoopResult)> done) override;

  /** config {droneFreeze}: true (default) = freeze whenever low-resource is on, false = always the live drone. */
  bool setFreezeConfig(bool on);
  bool freezeConfig() const { return freezeCfg_; }
  DroneCore *core() { return core_.get(); }
  double trimDb() const { return trimDb_; }
  std::string stateJson() const;
  /** Tests (offline engines only: the audio thread owns it in realtime). */
  const DroneUnit *unitForTests() const { return unit_; }

 private:
  void applyFreeze();
  void armPoll();
  bool realtimeJobs() const;

  Model &m_;
  std::unique_ptr<DroneCore> core_;
  DroneUnit *unit_ = nullptr;  // the last unit built (tests)
  double trimDb_ = 0;
  bool freezeCfg_ = true, lowRes_ = false, pretendRealtime_ = false, pollArmed_ = false;
  std::string padsDir_;
  std::unique_ptr<DroneWorker> worker_;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

/** Bridge `config {droneFreeze}` (src/bridge): false when the engine has no drone service. */
bool setDroneFreeze(Model &m, bool on, bool *now);

}  // namespace rig::drone
