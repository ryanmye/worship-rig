// Slot EQ (contract 3.3; fx.js:1614-1990, design/eq DECISION + AMENDMENT).
//
//   SlotEqSpec       the resolved EQ (fx.js resolveSlotEq: 8 bands + cuts) plus the sparse stored rows it was resolved
//                    from (b-rows per band, legacy low/mid/high rows), so a later `set` resolves like the JS.
//   SlotEqChains     T02's RT port of the JS SlotEq class: one or two chains of k-rate BiquadFilterNodes, each into a
//                    chain gain; in-place Hz glides / Q and gain ramps; peak/shelf type change = 30 ms to 0 dB, swap,
//                    30 ms back; a change of the wired set = a new chain warmed 50 ms muted, then a 30 ms linear
//                    crossfade. The JS control logic (diffs, `_needsSwitch`, timers) runs inside the unit on the audio
//                    thread, driven by SlotChannel (mix/slot_channel.cpp); its timers follow AudioTimer's offline
//                    semantics (due at the quantum ceil(t*sr/128 - 1e-6), callback time max(t, quantum start)).
//   SlotEq           the T00 skeleton chain (hard switch, no fades), kept for graph/builtin_units.cpp only.
#pragma once
#include <cstddef>
#include <cstdint>

#include "dsp/biquad.h"
#include "dsp/gain.h"

struct yyjson_val;

namespace rig {

inline constexpr int kEqBands = 8;
enum EqBandType { EqOff = 0, EqLowshelf, EqPeak, EqHighshelf, EqNotch, EqLowcut, EqHighcut };
/** Fields of a band row (`slots.<i>.eq.b<k>.<field>`), bit index in SlotEqSpec::stored. */
enum EqField { EqFOn = 0, EqFType, EqFHz, EqFDb, EqFQ };
/** Legacy rows (pre-AMENDMENT): bit index in SlotEqSpec::legacyHas. */
enum EqLegacyRow { EqLLow = 0, EqLLowHz, EqLMid1, EqLMid1Hz, EqLMid1Q, EqLMid2, EqLMid2Hz, EqLMid2Q, EqLHigh, EqLHighHz,
                   kEqLegacyRows };

struct EqBand {
  bool on = false;
  int type = EqPeak;
  double hz = 1000, db = 0, q = 0.707;
};

struct SlotEqSpec {
  // ---- resolved (what the filters use) ----
  EqBand bands[kEqBands];
  double cutHz = 20, hiCutHz = 20000;
  // ---- the stored sparse slot.eq it came from (T02; zero = nothing stored = PARAMS defaults) ----
  std::uint8_t stored[kEqBands] = {};  // bit EqField: b<k>.<field> is stored
  EqBand raw[kEqBands];                // stored b-row values (where the bit is set; clamped)
  std::uint16_t legacyHas = 0;         // bit EqLegacyRow: stored
  double legacy[kEqLegacyRows] = {};   // clamped by the legacy row
  bool cutStored = false, hiCutStored = false;
};

/** PARAMS defaults (resolveSlotEq({})): b1 low shelf 120 Hz on, b8 high shelf 6 kHz on, b2..b7 off, no cuts. */
const SlotEqSpec &defaultSlotEqSpec();
/** Recompute `bands` / cuts from the stored rows (fx.js resolveSlotEq; legacy rows read where a band has no b-row). */
void resolveSlotEq(SlotEqSpec &s);
/** Parse a JSON slot.eq object (sparse; null = defaults) into a resolved spec. */
void parseSlotEqJson(const yyjson_val *eq, SlotEqSpec &out);
/**
 * Store one clamped `slots.<i>.eq.*` row value (field below "eq.": "b3.type", "cutHz", "mid1Q", ...) and re-resolve.
 * False when the key is not an EQ row.
 */
bool storeSlotEqRow(SlotEqSpec &s, const char *key, double value);

/** A wired filter (what slotEqMembers + eqSpec produce). */
struct EqFilter {
  wa::BiquadType type;
  double hz, q, db;
};

inline constexpr std::size_t kMaxEqFilters = kEqBands + 2;

/** Filters of a spec in chain order; returns the count. */
std::size_t buildEqChain(const SlotEqSpec &spec, EqFilter out[kMaxEqFilters]);

/** T00 skeleton chain for the builtin strip (graph/builtin_units.cpp): hard switch, no glides. */
class SlotEq {
 public:
  void configure(const SlotEqSpec &spec, double sampleRate);
  /** In-place over `nch` channels of n frames. */
  void process(float *const *ch, int nch, std::size_t n);
  std::size_t filters() const { return count_; }

 private:
  EqFilter f_[kMaxEqFilters];
  wa::Biquad bq_[2][kMaxEqFilters];
  std::size_t count_ = 0;
};

/** The JS SlotEq on the audio thread (see the file comment). Fixed storage; every method is RT-safe. */
class SlotEqChains {
 public:
  static constexpr int kIds = kEqBands + 2;  // 0 = lc, 1..8 = b1..b8, 9 = hc
  static constexpr double kTypeFade = 0.03, kWarm = 0.05, kXfade = 0.03;  // EQ_TYPE_FADE, EQ_WARM, EQ_XFADE

  /** A fresh strip's EQ: the active chain is built from `want` directly (JS: SlotEq() + set(eq, t, step)). */
  explicit SlotEqChains(const SlotEqSpec &want = defaultSlotEqSpec());

  /**
   * SlotEq.set(raw, when, step): target a resolved spec. `nowFrame` is the context frame at the call (the quantum
   * start the call is applied in), `sr` the rate.
   */
  void set(const SlotEqSpec &want, double when, bool step, std::int64_t nowFrame, double sr);
  /** Run due timers for the quantum at frame0, then filter `nch` channels in place. */
  void process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr);

  /** Silent input: run due timers and advance every param only (filter memory frozen, as Chromium's tail). */
  void advance(std::size_t n, std::int64_t frame0, double sr);
  /** Wired filters of the live (active) chain. */
  std::size_t filters() const;
  /** Chains alive (1, or 2 while switching). */
  int chains() const { return (active_ >= 0 ? 1 : 0) + (incoming_ >= 0 ? 1 : 0); }
  std::uint32_t switches() const { return switches_; }
  const SlotEqSpec &want() const { return want_; }
  /** Pending internal timers (tests). */
  int pendingTimers() const;

 private:
  struct Node {
    int id = -1;
    wa::BiquadFilter bq;
    wa::BiquadType web = wa::BiquadType::Peaking, webTarget = wa::BiquadType::Peaking;
    double hz = 0, q = 0, db = 0;
    bool hasQ = false, fading = false, dead = true;
    std::uint32_t fadeSeq = 0;
  };
  struct Side {
    bool used = false;
    wa::Gain gain;
    Node nodes[kIds];
    int count = 0;  // nodes[0..count) in chain order
    Node *find(int id) {
      for (int i = 0; i < count; ++i)
        if (nodes[i].id == id) return &nodes[i];
      return nullptr;
    }
  };
  /** eqSpec(eq, id) */
  struct Spec {
    bool hasWeb = false, engaged = false, hasQ = false, hasDb = false;
    wa::BiquadType web = wa::BiquadType::Peaking;
    double hz = 0, q = 0, db = 0;
  };
  enum class TimerKind : std::uint8_t { None, SwitchDone, FadeDone };
  struct Timer {
    TimerKind kind = TimerKind::None;
    std::int64_t quantum = 0;
    std::uint64_t order = 0;
    double t = 0;
    std::uint32_t seq = 0;
    int side = -1, oldSide = -1, node = -1;
  };
  static constexpr int kTimers = 16;

  Spec eqSpec(int id) const;
  int members(int out[kIds]) const;
  int makeSide(const int *ids, int n, double gain, std::int64_t nowFrame, double sr);
  void dropSide(int s);
  bool needsSwitch(const int *ids, int n);
  void reconcile(double when, bool step, std::int64_t nowFrame, double sr);
  void doSwitch(const int *ids, int n, double when, std::int64_t nowFrame, double sr);
  void applyParams(double when, bool step, std::int64_t nowFrame, double sr);
  void fadeType(int side, int node, wa::BiquadType web, double when, std::int64_t nowFrame, double sr);
  void at(double t, double sr, Timer tm);
  void runTimers(std::int64_t frame0, double sr);
  void fire(const Timer &tm, double tt, std::int64_t nowFrame, double sr);

  SlotEqSpec want_;
  Side sides_[2];
  int active_ = -1, incoming_ = -1;
  std::uint32_t seq_ = 0, switches_ = 0, fadeSeqs_ = 0;
  bool dirty_ = false;
  Timer timers_[kTimers];
  std::uint64_t order_ = 0;
  bool inTimers_ = false;
  float scratch_[2][wa::Param::kQuantum];
};

}  // namespace rig
