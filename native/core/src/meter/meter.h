// M16 meters (T08): the `meter` sink unit (audio thread) and the "meter" service (control thread): out peaks since
// the last read (Q14: never misses a peak), the RTA ring and spectrum (contract 3.11, 6.5 `tick.rta`), meter
// subscriptions (`config.meters`, contract 6.4) and the tick rate. Slot levels (`slotLevel`, 256 frames, post-pan,
// mono down-mix) are computed by the graph into rig_meters.slot_peak/slot_rms (INTERFACE-CHANGE(T08) in graph.cpp)
// because the meter unit only sees `out`.
#pragma once
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "graph/unit.h"
#include "model/services.h"

struct PFFFT_Setup;

namespace rig {

class Model;

inline constexpr const char *kKindMeter = "meter";

/** Audio-thread -> control-thread state of one engine's meter unit. Every field is atomic (TSan-clean). */
struct MeterShared {
  static constexpr std::size_t kRtaSize = 2048;  // AnalyserNode fftSize (contract 3.11)
  static constexpr std::size_t kRing = 4096;     // power of two >= kRtaSize + one quantum of slack
  std::atomic<std::uint32_t> peakBits[2] = {};   // float bits of max |out| since the last takePeak (CAS max)
  std::atomic<float> ring[2][kRing] = {};        // last kRing frames of `out` (written only while rtaOn)
  std::atomic<std::uint64_t> written{0};         // frames written into ring (release after each quantum)
  std::atomic<bool> rtaOn{false};
  std::atomic<std::uint64_t> quanta{0};          // meter unit renders (liveness, tests)
  std::atomic<bool> attached{false};

  /** Control thread: peak since the previous call, then reset (Q14). */
  float takePeak(int ch);
};

/** The `meter` sink (UnitSlot::Meter, io.in = out). Measured 0.6 us per quantum, 1.4 us with the RTA ring on
 *  (unit.meter, g++ Release on the loaded 2-CPU box: < 0.06 % of a 48 kHz quantum). */
class MeterUnit final : public Unit {
 public:
  explicit MeterUnit(MeterShared *s) : s_(s) {}
  void process(const RenderContext &ctx, UnitIO &io) override;

 private:
  MeterShared *s_;
};

/** Tick rates (Hz). The contract's idle 4 Hz equals the shim's 0.25 s clock cap (G6): the engine never ticks below
 *  kIdleTickHz, so a running engine cannot look stalled to the watchdog. */
inline constexpr double kIdleTickHz = 8.0, kActiveTickHz = 30.0, kMaxTickHz = 60.0;

class MeterServiceImpl final : public MeterService {
 public:
  explicit MeterServiceImpl(Model &m);
  ~MeterServiceImpl() override;

  // MeterService
  void subscribe(const yyjson_val *meters) override;
  void onRateChanged(double sampleRate) override;
  std::string statsFields() override;

  /** Effective tick rate: the requested rate clamped to [kIdleTickHz, kMaxTickHz]; without a request 30 Hz while
   *  something is subscribed, else kIdleTickHz. */
  double tickHz() const;
  bool slotSubscribed(int slot) const { return slot >= 0 && slot < 4 && slots_[static_cast<std::size_t>(slot)]; }
  bool anySlot() const;
  bool rtaOn() const { return rta_; }
  /** Base64 of Uint8[1024 x 2] (L then R): clamp(round(-dB * 2), 0, 255), Blackman 2048, smoothing 0.8 per call
   *  (= per tick, "at the stream rate"); contract 6.5 / engine-api.json messages.rta. */
  std::string rtaBase64();
  /** Raw smoothed dB spectrum of the last rtaBase64 call (tests). */
  const std::vector<float> &lastDb(int ch) const { return db_[static_cast<std::size_t>(ch)]; }
  MeterShared &shared() { return *shared_; }
  static MeterServiceImpl *of(Model &m);
  /** The shared state registered for an engine (UnitEnv::config), null when no service exists. */
  static MeterShared *sharedFor(const void *engineKey);

 private:
  Model &m_;
  MeterShared *shared_;
  double rate_ = 0;  // requested Hz (0 = none)
  std::array<bool, 4> slots_{};
  bool rta_ = false;
  PFFFT_Setup *fft_ = nullptr;
  float *in_ = nullptr, *out_ = nullptr, *work_ = nullptr;
  std::vector<float> window_, smooth_[2], db_[2];
};

/** Base64 (RFC 4648, padded). */
std::string base64(const std::uint8_t *data, std::size_t n);

}  // namespace rig
