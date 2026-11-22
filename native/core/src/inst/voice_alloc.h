// Voice allocator for the instruments (T11; reused by T12's sampler and T15). Port of the stealing policy of
// app/js/engine/voice.js `VoiceAllocator` (synth, organ) and app/js/engine/instruments.js `BasicAllocator` (sampler),
// with the 2.0 polyphony of DECISIONS D1: storage for kVoicePoolSize (128) sounding voices per instrument plus
// kVoiceSpare slots for voices that are still fading after a steal, and a per-instrument cap (default 64, set by
// Instrument::setVoiceCap: 32 / 64 / 128) enforced at note-on. Nothing here allocates after construction.
//
// Usage (one pool per instrument, audio thread only after construction):
//   struct MyVoice { ... };                            // or a polymorphic base + emplace<Derived>()
//   VoicePool<MyVoice> pool;                           // control thread: reserves raw storage, constructs nothing
//   pool.setCap(cap);                                  // Instrument::setVoiceCap
//   pool.makeRoom(t, [&](int i) { fadeOut(i, t, kStealFade); pool.markKilled(i, t); });   // before every note-on
//   int i = pool.emplace(note, t, ctorArgs...);        // constructs the voice in place (state Held)
//   pool.markReleased(i, t);                           // note-off (the instrument starts its release itself)
//   pool.destroy(i);                                   // the voice has rendered its last frame (raise VoiceEnded)
//   pool.forEach([&](int i, MyVoice &v) { ... });      // every constructed voice, in slot order
// `makeRoom` counts Held + Released voices (voice.js `_playing`: killed voices do not count) and steals while that
// count is >= cap: the released voice with the earliest release (voice.js: released by `when`; BasicAllocator: any
// released voice, StealPolicy::AnyReleased), else the oldest voice. Ties go to the voice constructed first (JS Set
// insertion order). If every slot is occupied (all spare slots hold fading voices), emplace() destroys the oldest
// killed voice first (it is at most one steal fade from silence) and reports it through the `evicted` callback.
// Voice ids (VoiceId, inst/instrument.h) are `generation << 8 | slot`: stable while the voice lives, never reused
// for 2^24 constructions of the same slot, so a stale ReleaseVoice id is ignored.
//
// D4 (engine-wide voice limit, DECISIONS D4): `playing()` is a running count (O(1): the Graph sums it over every
// instrument at each note-on while a limit is on), and `oldestReleased` / `oldestPlaying` expose the two steal
// candidates of `makeRoom` so the Graph can pick the globally oldest across slots. Nothing else changes: the per-slot
// policy and every existing call keep their behaviour (the goldens are byte-identical).
//
// Memory: the storage is one raw block of Capacity * sizeof(V) bytes from operator new: nothing is constructed or
// touched until a slot is first used, so resident memory follows the voices actually played (the first use of a
// slot touches its pages on the audio thread: a page fault, not an allocation).
#pragma once
#include <cstddef>
#include <cstring>
#include <cstdint>
#include <limits>
#include <new>
#include <type_traits>
#include <utility>

namespace rig::inst {

inline constexpr unsigned kVoicePoolSize = 128;    // D1: the largest cap
inline constexpr unsigned kVoiceSpare = 32;        // slots for stolen voices still fading out
inline constexpr unsigned kDefaultVoiceCap = 64;   // D1 default
inline constexpr unsigned kWebVoiceCap = 16;       // voice.js MAX_VOICES (synth/organ), the goldens' polyphony
inline constexpr unsigned kWebSamplerVoiceCap = 32;  // sampler.js SAMPLER_MAX_VOICES
inline constexpr double kStealFade = 0.02;         // voice.js STEAL_FADE (s)
// T13 (T11 review O1): pool slots written once by the constructor (control thread; since T13 instruments are built
// at prepare), so the first chord of a fresh instrument never page-faults on the audio thread. freeSlot() hands out
// the lowest free index, so ordinary playing stays inside them. 16 = one full chord (web MAX_VOICES).
inline constexpr unsigned kPrefaultVoices = 16;

// ---- D4: engine-wide voice limit (total live voices across all slots, retiring channels included) ------------------
// `config {voiceLimit}`: 'auto' | 128 | 256 | 512 | 0 (off). 'auto' = a per-profile number sized so a held-pedal worst
// case (every voice held, the costliest voice) renders in <= ~60 % of the 128-frame quantum (2667 us at 48 kHz):
//   auto = (0.60 * 2667 us - fixed16) / perVoice, rounded to a multiple of 16
// fixed16 = 16 synth slots committed, nothing sounding; perVoice = the costliest voice per quantum (warm-pad).
// Measured by unit.voice-limit-cpu (g++ Release, 2-vCPU Linux box, 3 runs): fixed16 212-221 us, warm-pad 9.0 / 9.4 /
// 11.1 us per voice -> fit 154 / 147 / 125 -> desktop 128 (53 % at the median cost, 61 % at the worst run).
// iPad: the same fit with an assumed 2x slower core, (1600 - 2 x 218) / (2 x 9.4) = 62 -> 64.
// PROVISIONAL until the Mac and the oldest supported iPad are measured (Mac list; ARCHITECTURE 7.1 "D4").
inline constexpr unsigned kAutoVoiceLimitDesktop = 128;
inline constexpr unsigned kAutoVoiceLimitIpad = 64;
/** The manual choices of Settings > Sound > Total voice limit (0 = Off). */
inline constexpr unsigned kVoiceLimitChoices[] = {128, 256, 512};
/** D4 'auto' for a profile (rig_engine.h RIG_PROFILE_IPAD -> `ipad`). */
constexpr unsigned autoVoiceLimit(bool ipad) {
  return ipad ? kAutoVoiceLimitIpad : kAutoVoiceLimitDesktop;
}
/** Steals one note-on may make for the limit: a live lowering (512 -> 128 with 400 voices sounding) converges over
 *  later note-ons (net 3 voices each) instead of one burst of fades, and the audio thread's work per note-on stays
 *  bounded. */
inline constexpr unsigned kMaxLimitStealsPerNote = 4;

enum class VoiceState : std::uint8_t { Free, Held, Released, Killed };
enum class StealPolicy : std::uint8_t { ReleasedByWhen, AnyReleased };

/** Clamp a requested cap (Op::VoiceCap aux) to 1..kVoicePoolSize; 0 = the default. */
constexpr unsigned clampVoiceCap(unsigned cap) {
  return cap == 0 ? kDefaultVoiceCap : (cap > kVoicePoolSize ? kVoicePoolSize : cap);
}

template <class V, unsigned Capacity = kVoicePoolSize + kVoiceSpare, std::size_t SlotBytes = sizeof(V)>
class VoicePool {
  static_assert(Capacity >= 2 && Capacity <= 256, "voice ids keep the slot in 8 bits");

 public:
  struct Meta {
    VoiceState state = VoiceState::Free;
    int note = -1;
    double startedAt = 0, releasedAt = std::numeric_limits<double>::infinity();
    std::uint64_t seq = 0;  // construction order (JS Set insertion order, tie-breaks)
    std::uint32_t gen = 0;
  };

  explicit VoicePool(StealPolicy policy = StealPolicy::ReleasedByWhen, unsigned prefaultSlots = kPrefaultVoices)
      : policy_(policy) {
    storage_ = static_cast<unsigned char *>(::operator new(kStride * Capacity, std::align_val_t(kAlign)));
    prefault(prefaultSlots);  // T13 (T11 O1)
  }
  /** Touch the storage of the first `slots` voices (control thread only; nothing is constructed). */
  void prefault(unsigned slots) {
    std::memset(storage_, 0, kStride * (slots < Capacity ? slots : Capacity));
  }
  ~VoicePool() {
    for (unsigned i = 0; i < Capacity; ++i)
      if (meta_[i].state != VoiceState::Free) ptr(i)->~V();
    ::operator delete(storage_, std::align_val_t(kAlign));
  }
  VoicePool(const VoicePool &) = delete;
  VoicePool &operator=(const VoicePool &) = delete;

  static constexpr unsigned capacity() { return Capacity; }
  void setCap(unsigned cap) { cap_ = clampVoiceCap(cap); }
  unsigned cap() const { return cap_; }
  void setPolicy(StealPolicy p) { policy_ = p; }

  /** Constructed voices (any state but Free). */
  unsigned live() const { return live_; }
  /** Voices that count toward the cap (Held + Released). D4: a running count, O(1). */
  unsigned playing() const { return playing_; }

  /** Steal until one more voice fits under the cap; `fade(slot)` must fade the victim and call markKilled. */
  template <class Fade>
  unsigned makeRoom(double when, Fade &&fade) {
    unsigned stolen = 0;
    unsigned n = playing();
    while (n >= cap_ && n > 0) {
      const int victim = pickVictim(when);
      if (victim < 0) break;
      fade(victim);
      if (counts(meta_[victim])) markKilled(victim, when);  // the callback may have done it already
      ++stolen;
      ++steals_;
      --n;
    }
    return stolen;
  }

  /** Construct a voice (state Held). `evicted(slot)` runs (before destroy) if a fading voice had to make way. */
  template <class T = V, class Evicted, class... A>
  int emplaceEvicting(Evicted &&evicted, int note, double when, A &&...args) {
    static_assert(std::is_base_of_v<V, T> || std::is_same_v<V, T>, "T must be V or derive from it");
    static_assert(sizeof(T) <= kStride && alignof(T) <= kAlign, "T does not fit the pool slot");
    int s = freeSlot();
    if (s < 0) {
      s = oldestKilled();
      if (s < 0) s = oldest();
      if (s < 0) return -1;
      evicted(s);
      destroy(s);
    }
    Meta &m = meta_[s];
    m.state = VoiceState::Held;
    m.note = note;
    m.startedAt = when;
    m.releasedAt = std::numeric_limits<double>::infinity();
    m.seq = ++seq_;
    m.gen = (m.gen + 1) & 0xffffffu;
    ++live_;
    ++playing_;
    ::new (static_cast<void *>(storage_ + kStride * static_cast<std::size_t>(s))) T(std::forward<A>(args)...);
    return s;
  }
  template <class T = V, class... A>
  int emplace(int note, double when, A &&...args) {
    return emplaceEvicting<T>([](int) {}, note, when, std::forward<A>(args)...);
  }

  void markReleased(int s, double when) {
    Meta &m = meta_[s];
    if (m.state != VoiceState::Held) return;
    m.state = VoiceState::Released;
    m.releasedAt = when;
  }
  /** voice.js fadeOut / kill bookkeeping: releasedAt = min(releasedAt, when) unless already killed. */
  void markKilled(int s, double when) {
    Meta &m = meta_[s];
    if (m.state == VoiceState::Free) return;
    if (m.state != VoiceState::Killed && when < m.releasedAt) m.releasedAt = when;
    if (counts(m)) --playing_;
    m.state = VoiceState::Killed;
  }
  /** INTERFACE-CHANGE(T14) O-W3-1 (Instrument::fadeNote): fade(slot) for every Held voice playing `note`, in slot
   *  order; `fade` must fade the voice and call markKilled (done here if it did not). Returns the voices faded. */
  template <class Fade>
  unsigned fadeNote(int note, double when, Fade &&fade) {
    unsigned n = 0;
    for (unsigned i = 0; i < Capacity; ++i) {
      if (meta_[i].state != VoiceState::Held || meta_[i].note != note) continue;
      fade(static_cast<int>(i));
      markKilled(static_cast<int>(i), when);
      ++n;
    }
    return n;
  }
  /** Legato retune: the voice now plays `note`. */
  void setNote(int s, int note) { meta_[s].note = note; }
  void destroy(int s) {
    Meta &m = meta_[s];
    if (m.state == VoiceState::Free) return;
    ptr(s)->~V();
    if (counts(m)) --playing_;
    m.state = VoiceState::Free;
    m.note = -1;
    --live_;
  }
  void destroyAll() {
    for (unsigned i = 0; i < Capacity; ++i) destroy(static_cast<int>(i));
  }

  V &voice(int s) { return *ptr(s); }
  const Meta &meta(int s) const { return meta_[s]; }
  std::uint32_t idOf(int s) const { return (meta_[s].gen << 8) | static_cast<std::uint32_t>(s); }
  /** Slot of a live voice id, -1 if it ended (or never existed). */
  int slotOf(std::uint32_t id) const {
    const unsigned s = id & 0xffu;
    if (s >= Capacity || meta_[s].state == VoiceState::Free || meta_[s].gen != (id >> 8)) return -1;
    return static_cast<int>(s);
  }
  std::uint64_t steals() const { return steals_; }

  /** D4: the released voice `makeRoom` would steal first at `when` (earliest release, this pool's policy), -1 if
   *  none. */
  int oldestReleased(double when) const {
    int v = -1;
    for (unsigned i = 0; i < Capacity; ++i) {
      const Meta &m = meta_[i];
      if (m.state != VoiceState::Released) continue;
      if (policy_ == StealPolicy::ReleasedByWhen && !(m.releasedAt <= when)) continue;
      if (v < 0 || m.releasedAt < meta_[v].releasedAt ||
          (m.releasedAt == meta_[v].releasedAt && m.seq < meta_[v].seq))
        v = static_cast<int>(i);
    }
    return v;
  }
  /** D4: the oldest voice that counts toward the cap (earliest start, then construction order), -1 if none. */
  int oldestPlaying() const {
    int v = -1;
    for (unsigned i = 0; i < Capacity; ++i) {
      const Meta &m = meta_[i];
      if (!counts(m)) continue;
      if (v < 0 || m.startedAt < meta_[v].startedAt || (m.startedAt == meta_[v].startedAt && m.seq < meta_[v].seq))
        v = static_cast<int>(i);
    }
    return v;
  }

  /** fn(slot, voice) for every constructed voice, slot order (the callback may destroy the slot it is given). */
  template <class F>
  void forEach(F &&fn) {
    for (unsigned i = 0; i < Capacity; ++i)
      if (meta_[i].state != VoiceState::Free) fn(static_cast<int>(i), *ptr(static_cast<int>(i)));
  }
  /** Constructed voices in construction order (JS Set iteration), into `out` (>= Capacity ints); returns count. */
  unsigned ordered(int *out) const {
    unsigned n = 0;
    for (unsigned i = 0; i < Capacity; ++i)
      if (meta_[i].state != VoiceState::Free) out[n++] = static_cast<int>(i);
    for (unsigned a = 1; a < n; ++a)  // insertion sort by seq (n <= 160, rarely more than a few)
      for (unsigned b = a; b > 0 && meta_[out[b]].seq < meta_[out[b - 1]].seq; --b) std::swap(out[b], out[b - 1]);
    return n;
  }

 private:
  static constexpr std::size_t kAlign =
      alignof(V) > alignof(std::max_align_t) ? alignof(V) : alignof(std::max_align_t);
  static constexpr std::size_t kStride = (SlotBytes + kAlign - 1) / kAlign * kAlign;

  V *ptr(int s) { return std::launder(reinterpret_cast<V *>(storage_ + kStride * static_cast<std::size_t>(s))); }

  bool counts(const Meta &m) const { return m.state == VoiceState::Held || m.state == VoiceState::Released; }
  int pickVictim(double when) const {
    const int v = oldestReleased(when);  // oldest released first, else the oldest playing voice
    return v >= 0 ? v : oldestPlaying();
  }
  int freeSlot() const {
    for (unsigned i = 0; i < Capacity; ++i)
      if (meta_[i].state == VoiceState::Free) return static_cast<int>(i);
    return -1;
  }
  int oldestKilled() const {
    int v = -1;
    for (unsigned i = 0; i < Capacity; ++i)
      if (meta_[i].state == VoiceState::Killed && (v < 0 || meta_[i].seq < meta_[v].seq)) v = static_cast<int>(i);
    return v;
  }
  int oldest() const {
    int v = -1;
    for (unsigned i = 0; i < Capacity; ++i)
      if (meta_[i].state != VoiceState::Free && (v < 0 || meta_[i].seq < meta_[v].seq)) v = static_cast<int>(i);
    return v;
  }

  unsigned char *storage_ = nullptr;
  Meta meta_[Capacity];
  unsigned cap_ = kDefaultVoiceCap;
  unsigned live_ = 0;
  unsigned playing_ = 0;  // Held + Released (D4: kept by emplace / markKilled / destroy)
  std::uint64_t seq_ = 0, steals_ = 0;
  StealPolicy policy_;
};

}  // namespace rig::inst
