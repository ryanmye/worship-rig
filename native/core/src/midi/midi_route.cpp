// MIDI direct perform path (T07). See midi_route.h.
#include "midi/midi_route.h"

#include <algorithm>
#include <cmath>

#include "num/js_math.h"
#include "yyjson.h"

namespace rig::midi {

int applyVelocitySens(double v, std::string_view sens) {
  const double x = std::min(127.0, std::max(1.0, js::round(v))) / 127;
  if (sens == "fixed") return 100;
  double y;
  if (sens == "soft")
    y = js::pow(x, 0.6);  // light touch -> louder
  else if (sens == "hard")
    y = js::pow(x, 1.6);
  else
    y = x;
  return static_cast<int>(std::min(127.0, std::max(1.0, js::round(y * 127))));
}

Router::Router() = default;
Router::~Router() {
  if (touchDoc_) yyjson_doc_free(touchDoc_);
}

void Router::configure(const yyjson_val *cmsg, Perform &p, double when) {
  yyjson_val *msg = const_cast<yyjson_val *>(cmsg);
  if (yyjson_val *v = yyjson_obj_get(msg, "on"); yyjson_is_bool(v)) on_ = yyjson_get_bool(v);
  if (yyjson_val *v = yyjson_obj_get(msg, "jitterFree"); yyjson_is_bool(v)) jitterFree_ = yyjson_get_bool(v);
  if (yyjson_val *v = yyjson_obj_get(msg, "velocitySens"); yyjson_is_str(v)) velocitySens_ = yyjson_get_str(v);
  if (yyjson_val *v = yyjson_obj_get(msg, "learn"); yyjson_is_obj(v)) {
    learned_.clear();
    std::size_t i, n;
    yyjson_val *k, *m;
    yyjson_obj_foreach(v, i, n, k, m) {
      if (!yyjson_is_obj(m)) continue;
      Learned l;
      l.id = yyjson_get_str(k);
      if (yyjson_val *c = yyjson_obj_get(m, "cc"); yyjson_is_num(c)) l.cc = static_cast<int>(yyjson_get_num(c));
      if (yyjson_val *c = yyjson_obj_get(m, "note"); yyjson_is_num(c)) l.note = static_cast<int>(yyjson_get_num(c));
      if (yyjson_val *c = yyjson_obj_get(m, "channel"); yyjson_is_num(c))
        l.channel = static_cast<int>(yyjson_get_num(c));
      learned_.push_back(std::move(l));
    }
  }
  if (yyjson_val *v = yyjson_obj_get(msg, "touch"); yyjson_is_obj(v)) {
    if (touchDoc_) yyjson_doc_free(touchDoc_);
    touchDoc_ = nullptr;
    if (yyjson_mut_doc *md = yyjson_mut_doc_new(nullptr)) {
      yyjson_mut_doc_set_root(md, yyjson_val_mut_copy(md, v));
      touchDoc_ = yyjson_mut_doc_imut_copy(md, nullptr);
      yyjson_mut_doc_free(md);
    }
  }
  if (yyjson_val *v = yyjson_obj_get(msg, "pedalInvert"); yyjson_is_bool(v) && yyjson_get_bool(v) != pedalInvert_) {
    pedalInvert_ = yyjson_get_bool(v);
    for (auto &[src, raw] : pedalRaw_) pedalBySrc_[src] = (pedalInvert_ ? !raw : raw) && pedalBySrc_[src];
    updatePedal(p, when);
  }
}

const Router::Learned *Router::learnedFor(bool cc, int num, int channel) const {
  if (cc && num == 64) return nullptr;  // the sustain pedal is never remapped (M2)
  for (const Learned &l : learned_)
    if ((cc ? l.cc : l.note) == num && (l.channel < 0 || l.channel == channel)) return &l;
  return nullptr;
}

const yyjson_val *Router::touchFor(std::string_view portName) const {
  if (!touchDoc_ || portName.empty()) return nullptr;
  yyjson_val *root = yyjson_doc_get_root(touchDoc_);
  yyjson_val *t = yyjson_obj_getn(root, portName.data(), portName.size());
  return yyjson_is_obj(t) ? t : nullptr;
}

void Router::noteOnFrom(Perform &p, const std::string &src, int note, int vel, double when, const yyjson_val *touch) {
  if (note < 0 || note > 127) return;
  std::set<int> &held = heldBySrc_[src];
  if (!held.insert(note).second) return;  // duplicate note-on from the same source
  if (heldCount_[static_cast<std::size_t>(note)]++ == 0) p.noteOn(note, vel, when, touch);
}

void Router::noteOffFrom(Perform &p, const std::string &src, int note, double when) {
  auto it = heldBySrc_.find(src);
  if (it == heldBySrc_.end() || !it->second.erase(note)) return;
  int &c = heldCount_[static_cast<std::size_t>(note)];
  if (--c <= 0) {
    c = 0;
    p.noteOff(note, when);
  }
}

void Router::updatePedal(Perform &p, double when) {
  bool down = false;
  for (const auto &[src, d] : pedalBySrc_) down = down || d;
  if (down != pedalDown_) {
    pedalDown_ = down;
    p.sustain(down, when);
  }
}

bool Router::handle(Perform &p, std::string_view portId, std::string_view portName, const Event &e, double when) {
  if (!on_) return false;
  const std::string src = std::string(portId) + ":" + std::to_string(e.channel);
  switch (e.type) {
    case Event::NoteOn: {
      if (learnedFor(false, e.note, e.channel)) return false;  // a learned key: the controller's action
      if (const yyjson_val *t = touchFor(portName)) {
        noteOnFrom(p, src, e.note, e.velocity, when, t);  // the keyboard's own curve gets the raw velocity
      } else {
        noteOnFrom(p, src, e.note, applyVelocitySens(e.velocity, velocitySens_), when, nullptr);
      }
      return true;
    }
    case Event::NoteOff:
      if (learnedFor(false, e.note, e.channel)) return false;
      noteOffFrom(p, src, e.note, when);
      return true;
    case Event::Cc: {
      if (learnedFor(true, e.cc, e.channel)) return false;  // learned button / fader with pickup: JS
      switch (e.cc) {
        case 64: {
          const bool raw = e.value >= 64;
          const std::string port(portId);
          pedalRaw_[port] = raw;
          pedalBySrc_[port] = pedalInvert_ ? !raw : raw;
          updatePedal(p, when);
          return true;
        }
        case 1:
          p.wheel("mod", e.value01, when);
          return true;
        case 11:
          p.wheel("expr", e.value01, when);
          return true;
        case 7:
          p.wheel("vol", e.value01, when);
          return true;
        case 120:
        case 123: {
          auto it = heldBySrc_.find(src);  // all-notes-off is per channel
          if (it != heldBySrc_.end()) {
            const std::vector<int> notes(it->second.begin(), it->second.end());
            for (int n : notes) noteOffFrom(p, src, n, when);
          }
          return true;
        }
        default:
          return false;
      }
    }
    case Event::Bend:
      p.bend(e.bend, when);
      return true;
    case Event::Program:
      return false;  // program change -> setlist song (JS)
  }
  return false;
}

void Router::releaseSource(Perform &p, std::string_view portId, double when) {
  const std::string prefix = std::string(portId) + ":";
  for (auto it = heldBySrc_.begin(); it != heldBySrc_.end();) {
    if (it->first != portId && it->first.rfind(prefix, 0) != 0) {
      ++it;
      continue;
    }
    const std::vector<int> notes(it->second.begin(), it->second.end());
    for (int n : notes) noteOffFrom(p, it->first, n, when);
    it = heldBySrc_.erase(it);
  }
  const std::string port(portId);
  pedalRaw_.erase(port);
  if (pedalBySrc_.erase(port)) updatePedal(p, when);
}

std::size_t Router::sounding() const {
  std::size_t n = 0;
  for (int c : heldCount_) n += c > 0 ? 1u : 0u;
  return n;
}

}  // namespace rig::midi
