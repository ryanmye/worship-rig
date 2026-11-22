#include "samples/decode_pool.h"

#if defined(__APPLE__)
#include <pthread.h>
#include <sys/qos.h>
#elif defined(__linux__)
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

namespace rig::samples {

ThreadPool::ThreadPool(unsigned threads) {
  for (unsigned i = 0; i < (threads ? threads : 1); ++i) threads_.emplace_back([this] { loop(); });
}

ThreadPool::~ThreadPool() {
  {
    std::lock_guard<std::mutex> l(m_);
    stop_ = true;
    q_.clear();  // queued jobs are dropped; running ones finish
  }
  cv_.notify_all();
  for (auto &t : threads_) t.join();
}

void ThreadPool::post(int priority, std::function<void()> job) {
  {
    std::lock_guard<std::mutex> l(m_);
    q_.emplace(std::make_pair(priority, -++seq_), std::move(job));
  }
  cv_.notify_one();
}

std::size_t ThreadPool::pending() const {
  std::lock_guard<std::mutex> l(m_);
  return q_.size() + running_;
}

namespace {
/** ARCHITECTURE section 3: decode workers run at utility QoS. CORE2A: decoding now overlaps live input on the control
 *  thread (it used to stop it), so a loading song must not compete with the control loop or the audio thread for a
 *  small device's cores. (On this 2-CPU box the ui-core tick gaps were the same with and without it.) */
void lowerThreadPriority() {
#if defined(__APPLE__)
  pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
#elif defined(__linux__)
  setpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)), 10);  // per thread on Linux; failure is harmless
#endif
}
}  // namespace

void ThreadPool::loop() {
  lowerThreadPriority();
  for (;;) {
    std::function<void()> job;
    {
      std::unique_lock<std::mutex> l(m_);
      cv_.wait(l, [this] { return stop_ || !q_.empty(); });
      if (stop_) return;
      job = std::move(q_.begin()->second);
      q_.erase(q_.begin());
      ++running_;
    }
    job();
    std::lock_guard<std::mutex> l(m_);
    --running_;
  }
}

}  // namespace rig::samples
