// CORE3 (CORE2A O2): synth / organ units built off the control thread. A song switch used to build every fresh
// instrument inside Model::prepare on the control thread; an organ is ~60-70 ms (8 drawbar PeriodicWaves), a first use
// of a wavetable family 80-300 ms (WaveBank / XWaveBank), a 16-slot song with 4 organs ~250-290 ms on this box, and
// for all of that time no `play`, scene or tick was handled. Now SongGraph::prepare posts those builds here and keeps
// the control loop running (the old song plays on), and the realtime `prepare` reply goes out once they are done.
//
// Two worker threads (lanes). Lane 0 runs the jobs of a song switch at the default thread priority: the user is
// waiting for that `prepare` reply. Lane 1 runs neighbour prebuilds at utility priority (Apple QoS utility, Linux
// nice 10, like the sample decode workers), so they never compete with the control loop or the audio thread. A
// switch is therefore never queued behind a prebuild: its jobs never wait in lane 1, and a lane-1 job still queued
// when a switch needs it moves to lane 0 (promote). (One shared lane at utility priority, the first CORE3 cut, made
// a switch wait for the prebuild in progress and starved its own builds on a loaded box: 16 organs took 13-14 s
// instead of 1.1 s next to two busy threads; CORE3 builder, finish pass.) Jobs run the unit's registry factory
// unchanged, on a private copy of everything it reads (the slot's patch, the UnitEnv, the song state), so the
// workers never touch the Model. The kinds sent here are the pure ones (graph_build.cpp offThreadKind): their
// factories read only env + spec, and the wavetable banks they share are built outside the banks' mutexes.
//
// A job is claimed exactly once (Queued -> Running by compare-exchange): by a worker, or by the control thread when
// a commit needs the unit now and no worker has started it (then it builds inline: a commit takes effect at once,
// as before). A job claimed by a worker is waited for. A job nobody wants any more (superseded, evicted) is only
// marked: the workers skip it if queued, and its unit, if built, is freed with the last reference (worker or control
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
  int priority = 1;  // lane: 0 = a song switch, 1 = a neighbour prebuild (under the worker's mutex)
  int runLane = -1;  // the lane whose worker popped it (under the worker's mutex); -1 = not popped
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
  static constexpr int kLanes = 2;
  /** `wake` is called (worker thread) after each finished job; it must be thread-safe. */
  explicit BuildWorker(std::function<void()> wake = {});
  ~BuildWorker();
  BuildWorker(const BuildWorker &) = delete;
  BuildWorker &operator=(const BuildWorker &) = delete;

  void setWake(std::function<void()> wake);
  /** Queue a job (control thread) in lane `priority` (0 = a song switch, 1 = a prebuild); FIFO within a lane. */
  void post(const std::shared_ptr<BuildJob> &job, int priority);
  /** A queued job moves to lane `priority` (1: the switch that wanted it was superseded). No-op for a job not
   *  queued. */
  void reprioritize(const std::shared_ptr<BuildJob> &job, int priority);
  /** A song switch needs this job (control thread): true when it is done, queued (now in lane 0) or being built in
   *  lane 0; false when the prebuild lane is building it (the caller builds its own copy in lane 0 instead of
   *  waiting for a utility-priority thread). */
  bool promote(const std::shared_ptr<BuildJob> &job);
  /** Make the job Done now (control thread): claim and build it inline if the worker has not started it, else wait
   *  for the worker to finish it. Returns at once for a Done job. */
  void finish(BuildJob &job);
  /** Claim the job if no one has (control thread) and build it here; false when the worker has it (or it is done). */
  bool buildHere(BuildJob &job);
  /** Jobs queued or running (tests, stats). */
  std::size_t pending() const;

  /** While held (control thread; nests), lane 1 starts no new job; the one it is building runs on. A switch holds the
   *  worker over its whole slot loop, so the set of its jobs the prebuild lane has is fixed when the loop starts: at
   *  most the one job lane 1 was building then (core3f: per-slot `promote` let lane 1 pop the switch's next job
   *  between two slots, so the switch built a second duplicate; macos-15 CI, test_core3 "switch back to B" 8 + 2). */
  void holdPrebuilds();
  void releasePrebuilds();
  /** RAII holdPrebuilds / releasePrebuilds; null worker = no-op (no worker yet: nothing is prebuilt). */
  class PrebuildHold {
   public:
    explicit PrebuildHold(BuildWorker *w) : w_(w) {
      if (w_) w_->holdPrebuilds();
    }
    ~PrebuildHold() {
      if (w_) w_->releasePrebuilds();
    }
    PrebuildHold(const PrebuildHold &) = delete;
    PrebuildHold &operator=(const PrebuildHold &) = delete;

   private:
    BuildWorker *w_;
  };

 private:
  void loop(int lane);
  mutable std::mutex mu_;
  std::condition_variable cv_[kLanes], doneCv_;
  std::deque<std::shared_ptr<BuildJob>> q_[kLanes];
  std::size_t running_ = 0;
  int held_ = 0;  // holdPrebuilds depth (under mu_): lane 1 pops nothing while > 0
  std::uint64_t lane1Starts_ = 0;  // jobs lane 1 popped (under mu_; tests: testWaitPrebuildStart)
  bool stop_ = false;
  std::function<void()> wake_;
  std::thread threads_[kLanes];

 public:
  /** Tests only (unit.core3): every lane-1 job sleeps this long after it is claimed and before it builds (a
   *  prebuild starved on a loaded box), interruptible by the destructor. 0 = off. */
  static std::atomic<int> testPrebuildDelayMs;
  /** Tests only (unit.core3, core3f): after each off-thread slot of a switch has taken its unit (adopted or posted),
   *  the control thread waits up to this long for the prebuild lane to start another job, for as long as it could
   *  (queued work, not held; held, ms / 100: testWaitPrebuildStart): a control loop preempted mid-switch for as long
   *  as it takes, deterministically on a starved utility-priority lane too. 0 = off. */
  static std::atomic<int> testSwitchSlotWaitMs;
  /** The wait above (control thread; tests only). Held, it still waits ms / 100 for lane 1 to start a job, which it
   *  must not (core3f-skeptic S1: returning at once let a hold that lane 1 ignores pass the core3f case, 5/5). */
  void testWaitPrebuildStart(int ms);
};

}  // namespace rig
