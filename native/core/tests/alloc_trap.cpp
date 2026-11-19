// Replaces global operator new/delete so that an allocation made inside a render scope (the audio thread rule of
// ARCHITECTURE 3.2) is counted; tests assert the counter stays 0. With RIG_ALLOC_ABORT=1 it aborts instead.
#include <cstdio>
#include <cstdlib>
#include <new>

#include "runtime/rt_guard.h"

namespace rigtest {
long g_rtAllocs = 0;
}

static void *trapAlloc(std::size_t n) {
  if (rig::rt::inRender()) {
    ++rigtest::g_rtAllocs;
    if (std::getenv("RIG_ALLOC_ABORT")) {
      std::fprintf(stderr, "allocation on the audio thread (%zu bytes)\n", n);
      std::abort();
    }
  }
  void *p = std::malloc(n ? n : 1);
  if (!p) throw std::bad_alloc();
  return p;
}

void *operator new(std::size_t n) {
  return trapAlloc(n);
}
void *operator new[](std::size_t n) {
  return trapAlloc(n);
}
void *operator new(std::size_t n, const std::nothrow_t &) noexcept {
  try {
    return trapAlloc(n);
  } catch (...) {
    return nullptr;
  }
}
void *operator new[](std::size_t n, const std::nothrow_t &) noexcept {
  try {
    return trapAlloc(n);
  } catch (...) {
    return nullptr;
  }
}
void operator delete(void *p) noexcept {
  std::free(p);
}
void operator delete[](void *p) noexcept {
  std::free(p);
}
void operator delete(void *p, std::size_t) noexcept {
  std::free(p);
}
void operator delete[](void *p, std::size_t) noexcept {
  std::free(p);
}
