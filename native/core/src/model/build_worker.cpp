// CORE3: the unit build worker (model/build_worker.h).
#include "model/build_worker.h"

#include <algorithm>
#include <chrono>

#if defined(__APPLE__)
#include <pthread.h>
#include <sys/qos.h>
#elif defined(__linux__)
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

namespace rig {

namespace {
/** Like the sample decode workers (samples/decode_pool.cpp): a build never competes with the control loop or the
 *  audio thread for a small device's cores. */
void lowerThreadPriority() {
#if defined(__APPLE__)
  pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
#elif defined(__linux__)
  setpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)), 10);  // per thread on Linux; failure is harmless
#endif
}
}  // namespace

void BuildJob::run() {
  const auto t0 = std::chrono::steady_clock::now();
  UnitSpec spec;
  spec.slot = slot;
  spec.channel = channel;
  spec.patch = &patch;
  spec.song = &song;
  spec.instSeq = instSeq;
  result = factory ? factory(env, spec) : nullptr;
  buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

std::atomic<int> BuildWorker::testPrebuildDelayMs{0};

BuildWorker::BuildWorker(std::function<void()> wake) : wake_(std::move(wake)) {
  for (int l = 0; l < kLanes; ++l) threads_[l] = std::thread([this, l] { loop(l); });
}

BuildWorker::~BuildWorker() {
  {
    std::lock_guard<std::mutex> l(mu_);
    stop_ = true;
    for (auto &q : q_) q.clear();  // queued jobs are dropped (their owners free them); a running one finishes first
  }
  for (auto &cv : cv_) cv.notify_all();
  for (auto &t : threads_) t.join();
}

void BuildWorker::setWake(std::function<void()> wake) {
  std::lock_guard<std::mutex> l(mu_);
  wake_ = std::move(wake);
}

void BuildWorker::post(const std::shared_ptr<BuildJob> &job, int priority) {
  const int lane = priority <= 0 ? 0 : 1;
  {
    std::lock_guard<std::mutex> l(mu_);
    job->priority = lane;
    q_[lane].push_back(job);
  }
  cv_[lane].notify_one();
}

void BuildWorker::reprioritize(const std::shared_ptr<BuildJob> &job, int priority) {
  const int lane = priority <= 0 ? 0 : 1;
  {
    std::lock_guard<std::mutex> l(mu_);
    auto &from = q_[1 - lane];
    auto it = std::find(from.begin(), from.end(), job);
    if (it == from.end()) return;
    from.erase(it);
  }
  post(job, lane);
}

bool BuildWorker::promote(const std::shared_ptr<BuildJob> &job) {
  {
    std::lock_guard<std::mutex> l(mu_);
    if (job->done()) return true;
    auto it = std::find(q_[1].begin(), q_[1].end(), job);
    if (it == q_[1].end()) return job->runLane != 1;  // lane 0 has it (queued or building), or no lane popped it
    q_[1].erase(it);
  }
  post(job, 0);
  return true;
}

bool BuildWorker::buildHere(BuildJob &job) {
  int expected = BuildJob::Queued;
  if (!job.state.compare_exchange_strong(expected, BuildJob::Running, std::memory_order_acq_rel)) return false;
  // no worker started it: build it here (a commit takes effect at once); the workers skip it later
  job.builtOnControl = true;
  job.run();
  job.state.store(BuildJob::Done, std::memory_order_release);
  return true;
}

void BuildWorker::finish(BuildJob &job) {
  if (buildHere(job)) return;
  std::unique_lock<std::mutex> l(mu_);
  doneCv_.wait(l, [&job] { return job.done(); });
}

std::size_t BuildWorker::pending() const {
  std::lock_guard<std::mutex> l(mu_);
  return q_[0].size() + q_[1].size() + running_;
}

void BuildWorker::loop(int lane) {
  if (lane == 1) lowerThreadPriority();  // lane 0 keeps the default priority: a switch is waited for
  for (;;) {
    std::shared_ptr<BuildJob> job;
    {
      std::unique_lock<std::mutex> l(mu_);
      cv_[lane].wait(l, [this, lane] { return stop_ || !q_[lane].empty(); });
      if (stop_) return;
      job = std::move(q_[lane].front());
      q_[lane].pop_front();
      job->runLane = lane;
      ++running_;
    }
    int expected = BuildJob::Queued;
    const bool mine = !job->unwanted.load(std::memory_order_acquire) &&
                      job->state.compare_exchange_strong(expected, BuildJob::Running, std::memory_order_acq_rel);
    if (mine && lane == 1) {
      if (const int d = testPrebuildDelayMs.load(std::memory_order_relaxed); d > 0) {
        std::unique_lock<std::mutex> l(mu_);
        cv_[lane].wait_for(l, std::chrono::milliseconds(d), [this] { return stop_; });
      }
    }
    if (mine) job->run();
    std::function<void()> wake;
    {
      std::lock_guard<std::mutex> l(mu_);
      // Done under the mutex: finish() checks done() under it before sleeping, so the notify below is never lost
      if (mine) job->state.store(BuildJob::Done, std::memory_order_release);
      --running_;
      wake = wake_;
    }
    doneCv_.notify_all();
    job.reset();  // an unwanted job's unit is freed here when this was the last reference (never attached)
    if (mine && wake) wake();
  }
}

}  // namespace rig
