// Perform (T14): the perform half of audio.js on the control thread, as real Model state (Model::perform(),
// INTERFACE-CHANGE(T14) in model/model.h). Replaces the STOPGAP(T12) overlay that kept notes in a global map.
//   perform.cpp  notes (split, transpose, touch curves, re-strike), pedal (sustain, pedalHold timers), mono / legato,
//                allNotesOff (panic), fadeOutAll, noteInput / quietFor, the `notes` / `chord` events, state JSON
//   wheels.cpp   wheels (pickup, virtual glide, swell), _applyWheels' FX / drone / master part + macro.wash, the bend
//                modes (pitch, morph, drone-swell, tape), routing / commit hooks (neutral bend, pedal swell)
//   chords.cpp   shared/chords.js chordName + music.js spelling (the held-chord readout)
// JS references are app/js/engine/audio.js line numbers. Notes record the channel ID they were started on (T13): a
// note-off or pedal-up resolves its target through SongGraph::instUnitOf(id) (live Inst<i>, RetireInst<j>, or gone).
//
// Voice addressing (DECISIONS O-W3-1): the Model holds the pedal, so a pedaled voice is still Held in its
// instrument; "fade that one voice" (re-strike 30 ms, pedalHold 25 % of the hold, mono retrigger 30 ms) is
// Op::FadeNote(sounding note) on the channel's instrument.
#pragma once
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "model/patch.h"
#include "runtime/command.h"

struct yyjson_val;

namespace rig {

class Model;
struct Routing;
struct Channel;

/** What perform needs from the drone (T16). The "drone" service implements it next to DroneService (multiple
 *  inheritance); while it does not, these calls are no-ops. All on the control thread, `t` = engine seconds. */
class PerformDrone {
 public:
  virtual ~PerformDrone() = default;
  /** audio.js _applyWheels: rampTo(drone.wheel.gain, factor('drone.gain'), t, tc). */
  virtual void droneWheel(double gain, double t, double tc) {
    (void)gain, (void)t, (void)tc;
  }
  /** audio.js _syncPedalSwell -> drone.pedalSwell(on, t) (routing swell.pedal while the sustain pedal is down). */
  virtual void dronePedalSwell(bool on, double t) {
    (void)on, (void)t;
  }
  /** bend mode 'drone-swell': drone.bendSwell(x, t), x in -1..1. */
  virtual void droneBendSwell(double x, double t) {
    (void)x, (void)t;
  }
  /** audio.js _notesChanged -> drone.notesChanged(held, t) (chord follow). `held` = physical notes, ascending. */
  virtual void droneNotesChanged(const std::vector<int> &held, double t) {
    (void)held, (void)t;
  }
  /** audio.js commit -> drone.songChanged({when: t}). */
  virtual void droneSongChanged(double t) { (void)t; }
};

/** The chord readout of shared/chords.js chordName (null = name empty). */
struct ChordInfo {
  std::string name;  // "" = no chord (null)
  int root = 0;
  std::string quality;
  int bass = -1;  // -1 = null
  bool omit5 = false;
};
/** shared/chords.js chordName(pcs, bassPc, pref) (pref: true = 'sharp'). False = null. */
bool chordName(const std::vector<int> &pcs, int bassPc, bool sharp, ChordInfo &out);
/** shared/music.js spellingPreference(pc, minor) === 'sharp'. */
bool spellingSharp(int pc, bool minor);

/** shared/touch-curve.js compileTouch + touchAt. */
struct Touch {
  double g = 1, lo = 0, span = 1, top = 127;
  bool linear = true;
  static Touch compile(double shape, double min, double max, double top);
  static Touch preset(int velocityCurve);  // slots.<i>.velocityCurve enum: soft|normal|hard|fixed|custom
  double at(double vel127) const;
};

class Perform {
 public:
  explicit Perform(Model &m);
  ~Perform();
  Perform(const Perform &) = delete;
  Perform &operator=(const Perform &) = delete;

  // ---- contract 1.4 (perform.cpp) -------------------------------------------------------------------------------
  bool noteOn(int note, int vel, double when, const yyjson_val *touch);
  bool noteOff(int note, double when);
  bool sustain(bool down, double when);
  void allNotesOff(double when);
  void fadeOutAll(double seconds, double when);
  void noteInput(double when);
  /** audio.js quietFor: 0 while keys / pedal hold, else seconds since the last input (the reverb quiet gate). */
  double quietFor() const;
  bool pedal() const { return pedal_; }
  const std::set<int> &held() const { return held_; }
  std::size_t soundingCount() const { return sounding_.size(); }
  std::size_t pedaledCount() const { return pedaled_.size(); }
  bool faded() const { return fadeSeq_ != 0; }
  std::string runtimeStateJson() const;
  /** `_debugStats` members: sounding, pedaled. */
  void statsFields(std::string &out) const;

  // ---- wheels, bend, swell (wheels.cpp) ---------------------------------------------------------------------------
  void pitchBend(double x, double when);
  bool setWheel(std::string_view source, double value, double when, double glide);
  bool swell(int start, double when);
  std::string wheelValuesJson() const;
  double bend() const { return bend_; }
  /** audio.js _applyWheels(t, tc): SongGraph's strips + morph, then the drone, reverb return, master wheels and
   *  macro.wash (delay feedback, reverb size). */
  void applyWheels(double t, double tc);
  /** Model::setRouting after SongGraph merged it: neutral bend on a mode change, wheels (tau 30 ms, done by
   *  SongGraph for the strips), pedal swell. */
  void afterRouting(const yyjson_val *r, const std::string &oldBendMode, double when);
  /** Model::commit after SongGraph committed: neutral bend, the FX wheels (30 ms), drone songChanged, pedal swell. */
  void afterCommit(const std::string &oldBendMode, double when);
  /** `slots.<i>.bendEnabled` true in pitch mode: inst.setBend(bend * range) (audio.js _setSlotParam). */
  void bendEnabled(int slot, double when);
  /** audio.js _stageReverbSize under the plan's routing; `playing` = keys held or pedalled (prepare deferral). */
  double stageReverbSize(const Routing &r, double size) const;
  bool playing() const { return !sounding_.empty() || !pedaled_.empty(); }

  // ---- hooks --------------------------------------------------------------------------------------------------
  /** A retiring channel was disposed (audio.js _pollRetiring -> _unpedal). */
  void channelDisposed(std::uint32_t channelId);
  /** The audio thread adopted a new rate (T05 R6: the lofi unit is rebuilt without the tape hold). */
  void onRateChanged();

 private:
  struct Entry {
    int slot = -1, sn = -1, phys = -1;
    std::uint32_t ch = 0;  // SongGraph channel id
    bool mono = false;
    std::uint32_t hold = 0;  // pedalHold timer token (0 = none)
  };
  struct MonoNote {
    int phys, sn;
    double v;
  };
  struct Mono {  // audio.js sc.mono
    std::vector<MonoNote> notes;  // Map insertion order
    bool cur = false;
    int curPhys = -1, curSn = -1;
    bool pedalHold = false;
    std::uint32_t gen = 0;    // a reset (allNotesOff / fadeOutAll) makes a fresh object: stale timers see a new gen
    std::uint32_t curId = 0;  // identity of `cur` (JS object identity: every switch makes a new one)
  };
  struct WheelGlide {
    double from = 0, to = 0, t0 = 0, dur = 0;
  };
  struct Swell {
    bool up = true;
    double pre = 0, from = 0, to = 1, t0 = 0, dur = 0;
  };
  struct TapeSeg {
    double t0, dur, from, to;
  };
  class ParamOut;

  bool send(const Command &c);
  double tOf(double when) const;
  std::int64_t frameOf(double t) const;
  void sendNote(Op op, UnitSlot u, int sn, double vel01, double t, int vel = 0);
  void sendFade(UnitSlot u, int sn, double t, double seconds);
  const SlotPatch *cfgOf(std::uint32_t ch) const;
  std::string kindOf(std::uint32_t ch) const;
  void release(const Entry &e, double t);
  void pedalHold(Entry &e, double t);
  void unpedal(std::size_t i);
  void unpedalAll();
  Mono &mono(std::uint32_t ch);
  void monoOn(const Channel &c, int phys, int sn, double v, double t);
  void monoOff(std::uint32_t ch, int phys, double t);
  void monoSwitch(std::uint32_t ch, const MonoNote &target, double t);
  bool monoTarget(std::uint32_t ch, const SlotPatch &cfg, MonoNote &out);
  void resetMono();
  void notesChanged(double t);
  void warnOnce(const std::string &message);
  void updateChord(bool force, std::string &chordJson);
  // wheels.cpp
  bool setWheelAt(std::string_view source, double v, double t, bool fromSwell);
  void glideWheel(double to, double t, double dur);
  void swellStep(std::uint32_t seq, double tt, double tStart);
  void applyBend(double t, const std::string &mode);
  void neutralBend(const std::string &oldMode, double t);
  void tape(double x, double t);
  double tapeAt(double t) const;
  void tapeSeg(double t0, double dur, double from, double to);
  void syncPedalSwell(double t);
  void emitWheel(std::string_view source, double value);

  Model &m_;
  // notes (audio.js sounding / held / pedaled / pedal)
  std::map<int, std::vector<Entry>> sounding_;
  std::set<int> held_;
  std::vector<Entry> pedaled_;  // Set insertion order
  std::map<std::uint32_t, Mono> mono_;
  bool pedal_ = false;
  double pedalDownAt_ = 0, inputAt_ = -1e300;
  std::uint32_t nextHold_ = 0, monoGen_ = 0;
  std::uint32_t fadeSeq_ = 0, fadeCount_ = 0;  // fadeOutAll in effect (audio.js _fade) and its generation
  double fadeT0_ = 0, fadeS_ = 0, fadeFrom_ = 1;
  ChordInfo lastChord_;
  std::set<std::string> warned_;  // audio.js _warn(message, once = true)
  // wheels (values in SongGraph::wheel(); audio.js _modOwner / _pickup / _wheelGlide / _swell)
  bool modVirtual_ = false, pickup_ = false, pickupHasLast_ = false;
  double pickupLast_ = 0;
  std::uint32_t glideSeq_ = 0, glideActive_ = 0;
  WheelGlide glide_;
  std::uint32_t swellSeq_ = 0, swellActive_ = 0;
  Swell swell_;
  double washFb_ = NAN;  // fx.delay washFb (NaN = null)
  // bend (audio.js bend / _tapeX / _tapeSegs / _tapeSeq) and the pedal swell
  double bend_ = 0, tapeX_ = 0;
  std::vector<TapeSeg> tapeSegs_;
  std::uint32_t tapeSeq_ = 0;
  bool tapeHeld_ = false, pedalSwell_ = false;
};

/** SongGraph -> perform (song.cpp): |bend| in morph mode (audio.js _morphFor). */
double performBendMorph(const Model &m);

}  // namespace rig
