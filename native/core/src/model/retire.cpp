// T13 retire (audio.js _retire / _pollRetiring / _disposeChannel, contract 1.2 commit): an outgoing slot channel is
// MOVED with its state into a retiring channel (Op::MoveUnit, T00c), so held and pedal-held voices keep sounding
// there, and its strip keeps metering the origin slot (T08 #1). Once its instrument's live voice count has been 0 for
// 1 s (polled every 0.25 s on the audio clock) both units are detached (they come back as Garbage).
#include <algorithm>
#include <cmath>

#include "model/model.h"
#include "model/song.h"
#include "samples/cache_service.h"

namespace rig {

int SongGraph::pickRetireIndex() {
  for (int j = 0; j < static_cast<int>(kRetiring); ++j)
    if (!retiring_[j].live && m_.attachedKind(retireInstSlot(static_cast<std::size_t>(j))).empty() &&
        m_.attachedKind(retireStripSlot(static_cast<std::size_t>(j))).empty())
      return j;
  // all 32 busy (more than two back-to-back switches of 16-slot songs inside one tail): the channel retired first
  // gives way (its units are replaced by the move and freed). JS keeps every retiring channel.
  int best = -1;
  std::uint32_t oldest = 0;
  for (int j = 0; j < static_cast<int>(kRetiring); ++j)
    if (retiring_[j].live && (best < 0 || retiring_[j].id < oldest)) {
      best = j;
      oldest = retiring_[j].id;
    }
  if (best >= 0) {
    if (onDispose_) onDispose_(retiring_[best].id);
    retiring_[best] = Channel{};
    ++n_.forcedRetire;
  }
  return best < 0 ? 0 : best;
}

void SongGraph::retire(int slot, double when) {
  Channel &c = slots_[slot];
  if (!c.live) return;
  const int j = pickRetireIndex();
  const auto i = static_cast<std::size_t>(slot), r = static_cast<std::size_t>(j);
  if (!m_.attachedKind(instSlot(i)).empty()) m_.moveUnit(instSlot(i), retireInstSlot(r), when);
  if (!m_.attachedKind(stripSlot(i)).empty()) m_.moveUnit(stripSlot(i), retireStripSlot(r), when);
  c.retire = j;
  c.zeroSince = NAN;
  retiring_[j] = std::move(c);
  c = Channel{};
  ++n_.retired;
  armRetirePoll(tOf(when));
}

void SongGraph::armRetirePoll(double t) {
  if (pollArmed_ || retiringCount() == 0) return;
  pollArmed_ = true;
  m_.sink().at(t + 0.25, [this](double tt) { pollRetiring(tt); });
}

void SongGraph::pollRetiring(double tt) {
  pollArmed_ = false;
  bool changed = false;
  for (int j = 0; j < static_cast<int>(kRetiring); ++j) {
    Channel &c = retiring_[j];
    if (!c.live) continue;
    const std::uint32_t live = c.shell ? c.shell->publishedVoices() : 0;
    if (live == 0) {
      if (std::isnan(c.zeroSince)) c.zeroSince = tt;
      if (tt - c.zeroSince >= 1.0) {
        dispose(j);
        changed = true;
      }
    } else {
      c.zeroSince = NAN;
    }
  }
  const int left = retiringCount();
  if (changed && left == 0)  // v11-memory: the old song's buffers are free now
    if (auto *cs = dynamic_cast<samples::CacheServiceImpl *>(m_.service<CacheService>())) cs->rewarmPins();
  if (left > 0) armRetirePoll(tt);
}

void SongGraph::dispose(int j) {
  Channel &c = retiring_[j];
  const auto r = static_cast<std::size_t>(j);
  m_.detachUnit(retireInstSlot(r), -1.0);
  m_.detachUnit(retireStripSlot(r), -1.0);
  const std::uint32_t id = c.id;
  c = Channel{};
  ++n_.disposed;
  if (onDispose_) onDispose_(id);
}

int SongGraph::retiringCount() const {
  return static_cast<int>(std::count_if(std::begin(retiring_), std::end(retiring_), [](const Channel &c) {
    return c.live;
  }));
}

}  // namespace rig
