// MIDI direct perform path (T07; contract 5 "midi route", bridge v1.1): the part of app/js/controller.js
// (midiHandlers, noteOnFrom/noteOffFrom, updatePedal, releaseSource, reapplyPedalInvert, learnedFor,
// applyVelocitySens) that turns parsed messages into perform calls without the WebView round trip. Policy stays in
// JS: learned controls (buttons, faders with pickup), program change -> song, touch capture are diverted (not
// handled) and still forwarded, as is every message (the `midi` event carries `handled`).
//
// Per-source refcount: a source is `<port id>:<channel>`; a note sounds while any source holds it, a duplicate
// note-on from the same source is ignored. Sustain = OR over the ports' pedals (CC64 >= 64, pedalInvert applied).
// CC1/11/7 -> wheels mod/expr/vol, bend -> pitchBend, CC120/123 release that source's notes.
#pragma once
#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "midi/midi_parser.h"

struct yyjson_val;
struct yyjson_doc;

namespace rig::midi {

/** What the router plays (the Model's perform methods; a fake in tests). */
class Perform {
 public:
  virtual ~Perform() = default;
  virtual void noteOn(int note, int vel, double when, const yyjson_val *touch) = 0;
  virtual void noteOff(int note, double when) = 0;
  virtual void sustain(bool down, double when) = 0;
  virtual void wheel(const char *source, double value01, double when) = 0;  // "mod" | "expr" | "vol"
  virtual void bend(double value, double when) = 0;
};

/** controller.js applyVelocitySens(v, sens): 'soft' x^0.6, 'hard' x^1.6, 'fixed' 100, else linear. */
int applyVelocitySens(double v, std::string_view sens);

class Router {
 public:
  Router();
  ~Router();
  /** `midi route` fields; absent fields keep their value. A pedalInvert change re-applies the pedals (it may only
   *  release the sustain, controller.js reapplyPedalInvert). */
  void configure(const yyjson_val *msg, Perform &p, double when);
  bool on() const { return on_; }
  bool jitterFree() const { return jitterFree_; }
  void setOn(bool on) { on_ = on; }

  /** Play one parsed message; true = handled here (the JS controller must not play it again). */
  bool handle(Perform &p, std::string_view portId, std::string_view portName, const Event &e, double when);
  /** midi.js 'disconnected' -> controller releaseSource(inputId): notes of every channel and the port's pedal. */
  void releaseSource(Perform &p, std::string_view portId, double when);

  /** Notes sounding through the router (heldCount > 0). */
  std::size_t sounding() const;
  bool pedalDown() const { return pedalDown_; }

 private:
  struct Learned {
    std::string id;
    int cc = -1, note = -1, channel = -1;  // channel -1 = any
  };
  const Learned *learnedFor(bool cc, int num, int channel) const;
  void noteOnFrom(Perform &p, const std::string &src, int note, int vel, double when, const yyjson_val *touch);
  void noteOffFrom(Perform &p, const std::string &src, int note, double when);
  void updatePedal(Perform &p, double when);
  const yyjson_val *touchFor(std::string_view portName) const;

  bool on_ = false, jitterFree_ = false, pedalInvert_ = false;
  std::string velocitySens_ = "normal";
  std::vector<Learned> learned_;
  std::map<std::string, std::set<int>> heldBySrc_;
  std::array<int, 128> heldCount_{};
  std::map<std::string, bool> pedalRaw_, pedalBySrc_;  // by port id
  bool pedalDown_ = false;
  yyjson_doc *touchDoc_ = nullptr;  // copy of route.touch {deviceName: spec}
};

}  // namespace rig::midi
