#include "samples/decode_pool.h"

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
    q_.emplace(priority, std::move(job));
  }
  cv_.notify_one();
}

std::size_t ThreadPool::pending() const {
  std::lock_guard<std::mutex> l(m_);
  return q_.size() + running_;
}

void ThreadPool::loop() {
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
