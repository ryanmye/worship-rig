// Decode workers (ARCHITECTURE section 3: "decode x1-2, utility QoS"). A tiny priority pool; the cache hands it
// closures that only touch their own data (decode + resample + processSample) and push the result to a mailbox.
#pragma once
#include <condition_variable>
#include <functional>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace rig::samples {

class JobRunner {
 public:
  virtual ~JobRunner() = default;
  /** Lower `priority` first (0 = song switch, 1 = preload, 2 = re-warm). */
  virtual void post(int priority, std::function<void()> job) = 0;
  /** True when post() runs the job before returning (offline mode, tests). */
  virtual bool inlineMode() const = 0;
};

class InlineRunner final : public JobRunner {
 public:
  void post(int, std::function<void()> job) override { job(); }
  bool inlineMode() const override { return true; }
};

class ThreadPool final : public JobRunner {
 public:
  explicit ThreadPool(unsigned threads);
  ~ThreadPool() override;
  void post(int priority, std::function<void()> job) override;
  bool inlineMode() const override { return false; }
  /** Jobs queued or running. */
  std::size_t pending() const;

 private:
  void loop();
  mutable std::mutex m_;
  std::condition_variable cv_;
  std::multimap<int, std::function<void()>> q_;
  std::size_t running_ = 0;
  bool stop_ = false;
  std::vector<std::thread> threads_;
};

}  // namespace rig::samples
