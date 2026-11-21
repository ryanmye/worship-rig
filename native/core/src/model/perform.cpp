// Perform input (contract 1.4): noteOn ... runtimeStateJson. Moved UNCHANGED out of model.cpp by T13 (BUILD_PLAN:
// T13's first step), together with the STOPGAP(T12) perform overlay; T14 owns this file and replaces the overlay.
// T13 deltas (marked "T13:"): a note follows its channel into retirement (audio.js `sounding` keeps the channel, so
// held and pedal-held notes are released on the retired instrument), notes go to the slots that have a channel, a
// disposed retiring channel drops its pedaled notes (_unpedal), and ~Model forgets the overlay state (T12 O5).
#include <algorithm>
#include <map>
#include <vector>

#include "model/model.h"
#include "model/song.h"

namespace rig {

// ---- perform (skeleton: every note to every slot; T14 owns splits, pedal, mono, wheels) ---------------------------

// ---- STOPGAP(T12) perform overlay, kept until T14 replaces it (T14 owns perform) ----
// audio.js noteOn / noteOff / sustain for polyphonic slots: split on the physical note, sounding note = n + song
// transpose + 12 octave + slot transpose, duplicate note-on = re-strike, pedal holds released notes of slots with
// `sustain`, pedal up releases them. Linear velocity only (touch curves, mono, pedalHold, re-strike fade: T14).
namespace {
struct OvEntry {
  int slot, sn;
  std::uint32_t ch = 0;  // T13: the channel (SongGraph id) the note was started on
};
struct OvPerform {
  std::map<int, std::vector<OvEntry>> sounding;
  std::vector<OvEntry> pedaled;
  bool pedal = false;
};
std::map<const Model *, OvPerform> gOv;
}  // namespace

static Command ovNote(Op op, UnitSlot target, int sn, int vel, std::int64_t frame) {  // T13: unit slot target
  Command c{};
  c.op = op;
  c.frame = frame;
  c.target = static_cast<std::uint32_t>(target);
  c.aux = static_cast<std::uint32_t>(sn & 0xff) | (static_cast<std::uint32_t>(std::clamp(vel, 0, 127)) << 8);
  return c;
}

bool Model::noteOn(int note, int vel, double when, const yyjson_val *) {
  if (!(vel > 0)) return noteOff(note, when);
  OvPerform &P = gOv[this];
  const int n = std::clamp(note, 0, 127);
  if (P.sounding.count(n)) noteOff(n, when);
  std::vector<OvEntry> entries;
  for (std::size_t i = 0; i < std::size(active_.slots); ++i) {
    const SlotPatch &sp = active_.slots[i];
    const Channel *ch = sg_->liveChannel(static_cast<int>(i));  // T13: audio.js `const sc = this.slots[i]`
    if (!ch || !ch->hasInst) continue;
    if (n < sp.spec.lowNote || n > sp.spec.highNote) continue;
    const int sn = n + song_.transpose + 12 * sp.octave + sp.transpose;
    if (sn < 0 || sn > 127) continue;
    send(ovNote(Op::NoteOn, instSlot(i), sn, vel, frameFor(when)));
    entries.push_back({static_cast<int>(i), sn, ch->id});
  }
  P.sounding[n] = entries;
  ++stats_.notesOn;
  return true;
}

bool Model::noteOff(int note, double when) {
  OvPerform &P = gOv[this];
  const int n = std::clamp(note, 0, 127);
  auto it = P.sounding.find(n);
  if (it != P.sounding.end()) {
    for (const OvEntry &e : it->second) {
      const Channel *ch = sg_->channelById(e.ch);  // T13: the channel's own cfg (sc.cfg), also when retiring
      if (!ch) continue;                          // disposed
      const bool sus = ch->retire >= 0 ? ch->cfg.sustain : active_.slots[e.slot].sustain;
      if (P.pedal && sus) P.pedaled.push_back(e);
      else send(ovNote(Op::NoteOff, sg_->instUnitOf(e.ch), e.sn, 0, frameFor(when)));
    }
    P.sounding.erase(it);
  }
  ++stats_.notesOff;
  return true;
}

bool Model::sustain(bool down, double when) {
  OvPerform &P = gOv[this];
  if (down == P.pedal) return true;
  P.pedal = down;
  if (!down) {
    for (const OvEntry &e : P.pedaled) {
      const UnitSlot u = sg_->instUnitOf(e.ch);  // T13: where that channel plays now
      if (u != UnitSlot::Count) send(ovNote(Op::NoteOff, u, e.sn, 0, frameFor(when)));
    }
    P.pedaled.clear();
  }
  return true;
}
void Model::pitchBend(double, double) {}
bool Model::setWheel(std::string_view, double, double, double) {
  return false;
}
bool Model::swell(int, double) {
  return false;
}

void Model::allNotesOff(double when) {
  Command c{};
  c.op = Op::Panic;  // T00 behaviour kept (hard kill); T14: AllNotesOff 30 ms fade + pedal/swell/bend/delay rules
  c.frame = frameFor(when);
  c.target = kAllSlots;
  send(c);
}

void Model::fadeOutAll(double, double) {}
void Model::noteInput(double) {}
std::string Model::wheelValuesJson() const {
  return R"({"mod":0,"expr":1,"vol":1,"owner":"hw","swelling":false})";
}
std::string Model::runtimeStateJson() const {
  return R"({"wheel":{"mod":0,"expr":1,"vol":1},"modOwner":"hw","faded":false})";
}

// T13: audio.js _pollRetiring -> _unpedal(e) for a disposed channel; ~Model (T12 O5: no state for a reused address)
void performChannelDisposed(const Model &m, std::uint32_t channelId) {
  auto it = gOv.find(&m);
  if (it == gOv.end()) return;
  auto &v = it->second.pedaled;
  v.erase(std::remove_if(v.begin(), v.end(), [channelId](const OvEntry &e) { return e.ch == channelId; }), v.end());
}
void performForget(const Model &m) {
  gOv.erase(&m);
}

}  // namespace rig
