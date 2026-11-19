// Real-time guard: a thread-local "in render" flag. Tests replace global operator new with a hook that counts or
// aborts when it fires inside a scope (ARCHITECTURE 3.2). The FTZ/DAZ scope also lives here.
#pragma once
#include <cstdint>

#if defined(__SSE2__) || defined(_M_X64)
#include <xmmintrin.h>
#endif

namespace rig::rt {

inline thread_local int g_renderDepth = 0;
inline bool inRender() { return g_renderDepth > 0; }

/** Marks the audio-thread section and sets flush-to-zero / denormals-are-zero, restoring both on exit. */
class RenderScope {
 public:
  RenderScope() {
    ++g_renderDepth;
#if defined(__SSE2__) || defined(_M_X64)
    saved_ = _mm_getcsr();
    _mm_setcsr(saved_ | 0x8040u);  // FTZ (bit 15) | DAZ (bit 6)
#elif defined(__aarch64__)
    std::uint64_t fpcr;
    __asm__ volatile("mrs %0, fpcr" : "=r"(fpcr));
    saved_ = fpcr;
    __asm__ volatile("msr fpcr, %0" ::"r"(fpcr | (1ull << 24)));  // FZ
#endif
  }
  ~RenderScope() {
#if defined(__SSE2__) || defined(_M_X64)
    _mm_setcsr(saved_);
#elif defined(__aarch64__)
    __asm__ volatile("msr fpcr, %0" ::"r"(saved_));
#endif
    --g_renderDepth;
  }
  RenderScope(const RenderScope &) = delete;
  RenderScope &operator=(const RenderScope &) = delete;

 private:
#if defined(__aarch64__)
  std::uint64_t saved_ = 0;
#else
  unsigned saved_ = 0;
#endif
};

}  // namespace rig::rt
