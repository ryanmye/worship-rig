// Shared counters of the unit.runtime probe module (tests/test_runtime_probe_register.cpp).
#pragma once
#include <atomic>

namespace t08 {
extern std::atomic<int> g_rateChanges, g_rescans, g_rescanSlot;
extern std::atomic<double> g_lastRate;
extern std::atomic<int> g_floodPerQuantum;
}  // namespace t08
