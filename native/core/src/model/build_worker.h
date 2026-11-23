// CORE3 (CORE2A O2): synth / organ units built off the control thread. A song switch used to build every fresh
// instrument inside Model::prepare on the control thread; an organ is ~60-70 ms (8 drawbar PeriodicWaves), a first use
// of a wavetable family 80-300 ms (WaveBank / XWaveBank), a 16-slot song with 4 organs ~250-290 ms on this box, and
// for all of that time no `play`, scene or tick was handled. Now SongGraph::prepare posts those builds here and keeps
// the control loop running (the old song plays on), and the realtime `prepare` reply goes out once they are done.
//
// One worker thread, utility priority (like the sample decode workers). Jobs run the unit's registry factory
// unchanged, on a private copy of everything it reads (the slot's patch, the UnitEnv, the song state), so the worker
// never touches the Model. The kinds sent here are the pure ones (graph_build.cpp offThreadKind): their factories read
// only env + spec, and the wavetable banks they share are built under the banks' own mutexes.
//
// A job is claimed exactly once (Queued -> Running by compare-exchange): by the worker, or by the control thread when
// a commit needs the unit now and the worker has not started it (then it builds inline: a commit takes effect at once,
// as before). A job claimed by the worker is waited for. A job nobody wants any more (superseded, evicted) is only
// marked: the worker skips it if queued, and its unit, if built, is freed with the last reference (worker or control
// thread; it was never attached, the audio thread never saw it).
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "api/registry.h"
#include "graph/unit.h"
#include "model/patch.h"

namespace rig {

/** One unit to build. Fields above `state` are set by the control thread before posting and read-only afterwards. */
struct BuildJob {
  enum State : int { Queued = 0, Running = 1, Done = 2 };
  UnitFactory factory = nullptr;
  UnitEnv env;
  PatchSpec patch;  // a copy: the factory reads patch.slots[channel]
  SongState song;
  int channel = -1;
  UnitSlot slot = UnitSlot::Count;
  std::uint32_t instSeq = 0;
  std::string kind;
  double sampleRate = 0;

  std::atomic<int> state{Queued};
  std::atomic<bool> unwanted{false};  // superseded / evicted: skip if queued
  int priority = 1;                   // 0 = a song switch, 1 = a neighbour prebuild (worker-side, under its mutex)
  Unit *result = nullptr;             // written by the claimer before state = Done (release)
  double buildMs = 0;
  bool builtOnControl = false;

  ~BuildJob() { delete result; }
  /** The built unit (null if the factory declined); ownership passes to the caller. Only after Done. */
  Unit *take() {
    Unit *u = result;
    result = nullptr;
    return u;
  }
  bool done() const { return state.load(std::memory_order_acquire) == Done; }
  /** Run the factory (the claimer only). */
  void run();
};

class BuildWorker {
 public:
  /** `wake` is called (worker thread) after each finished job; it must be thread-safe. */
  explicit BuildWorker(std::function<void()> wake = {});
  ~BuildWorker();
  BuildWorker(const BuildWorker &) = delete;
  BuildWorker &operator=(const BuildWorker &) = delete;

  void setWake(std::function<void()> wake);
  /** Queue a job (control thread). Priority 0 runs before 1; FIFO within a priority. */
  void post(const std::shared_ptr<BuildJob> &job, int priority);
  /** A queued job moves to `priority` (0: a song switch now needs the neighbour being prebuilt; 1: the switch that
   *  wanted it was superseded). No-op for a job not queued. */
  void reprioritize(const std::shared_ptr<BuildJob> &job, int priority);
  /** Make the job Done now (control thread): claim and build it inline if the worker has not started it, else wait
   *  for the worker to finish it. Returns at once for a Done job. */
  void finish(BuildJob &job);
  /** Claim the job if no one has (control thread) and build it here; false when the worker has it (or it is done). */
  bool buildHere(BuildJob &job);
  /** Jobs queued or running (tests, stats). */
  std::size_t pending() const;

 private:
  void loop();
  mutable std::mutex mu_;
  std::condition_variable cv_, doneCv_;
  std::deque<std::shared_ptr<BuildJob>> q_;
  std::size_t running_ = 0;
  bool stop_ = false;
  std::function<void()> wake_;
  std::thread thread_;
};

}  // namespace rig
