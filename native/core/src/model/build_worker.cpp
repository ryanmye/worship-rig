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

BuildWorker::BuildWorker(std::function<void()> wake) : wake_(std::move(wake)) {
  thread_ = std::thread([this] { loop(); });
}

BuildWorker::~BuildWorker() {
  {
    std::lock_guard<std::mutex> l(mu_);
    stop_ = true;
    q_.clear();  // queued jobs are dropped (their owners free them); a running one finishes first
  }
  cv_.notify_all();
  thread_.join();
}

void BuildWorker::setWake(std::function<void()> wake) {
  std::lock_guard<std::mutex> l(mu_);
  wake_ = std::move(wake);
}

void BuildWorker::post(const std::shared_ptr<BuildJob> &job, int priority) {
  {
    std::lock_guard<std::mutex> l(mu_);
    job->priority = priority;
    if (priority == 0) {  // after the other priority-0 jobs, before every prebuild
      auto it = q_.begin();
      while (it != q_.end() && (*it)->priority == 0) ++it;
      q_.insert(it, job);
    } else {
      q_.push_back(job);
    }
  }
  cv_.notify_one();
}

void BuildWorker::reprioritize(const std::shared_ptr<BuildJob> &job, int priority) {
  {
    std::lock_guard<std::mutex> l(mu_);
    auto it = std::find(q_.begin(), q_.end(), job);
    if (it == q_.end() || job->priority == priority) return;
    q_.erase(it);
  }
  post(job, priority);
}

bool BuildWorker::buildHere(BuildJob &job) {
  int expected = BuildJob::Queued;
  if (!job.state.compare_exchange_strong(expected, BuildJob::Running, std::memory_order_acq_rel)) return false;
  // the worker never started it: build it here (a commit takes effect at once); the worker skips it later
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
  return q_.size() + running_;
}

void BuildWorker::loop() {
  lowerThreadPriority();
  for (;;) {
    std::shared_ptr<BuildJob> job;
    {
      std::unique_lock<std::mutex> l(mu_);
      cv_.wait(l, [this] { return stop_ || !q_.empty(); });
      if (stop_) return;
      job = std::move(q_.front());
      q_.pop_front();
      ++running_;
    }
    int expected = BuildJob::Queued;
    const bool mine = !job->unwanted.load(std::memory_order_acquire) &&
                      job->state.compare_exchange_strong(expected, BuildJob::Running, std::memory_order_acq_rel);
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
