// DroneCore: the control half of app/js/engine/drone.js (class Drone), T16. A near line-by-line port: the same
// state, the same AudioParam calls in the same order (time/automation.h helpers over a param proxy that turns each
// timeline call into one DroneOp::Param command), the same instrument calls, the same audio-clock timers. It drives
// one DroneUnit through a DroneHost: the engine's drone service (live) or the offline loop renderer (drone_freeze).
//
// Differences from drone.js (T16 report): pad files are decoded (worker) and played from memory by buffer sources
// instead of <audio> elements, so files mode also works offline and the loop crossfade is sample-exact (no media-clock
// resync, no `onended` fallback); the frozen loop is rendered on a worker thread; instrument slots are bounded
// (kMaxInst, the oldest fading layer is cut when they run out).
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "drone/drone_unit.h"
#include "drone/drone_voicing.h"
#include "num/prng.h"
#include "runtime/command.h"
#include "time/automation.h"

struct yyjson_val;

namespace rig::drone {

inline constexpr double kDroneParkSec = 10;          // DRONE_PARK_SEC
inline constexpr double kPedalSwellRiseTc = 0.55;    // PEDAL_SWELL_RISE_TC
inline constexpr double kPedalSwellFallTc = 3 / 4.6;  // PEDAL_SWELL_FALL_TC
inline constexpr double kParkResumeFade = 0.05;
inline constexpr double kXfadeAttackSec = 0.05;
inline constexpr double kThawSettleSec = 0.25;
inline constexpr double kStealFade = 0.15;
inline constexpr unsigned kPoolMin = 4;
inline constexpr unsigned kIdleInst = 2;
inline constexpr double kFollowSplit = 60;
// drone-freeze.js
inline constexpr double kFreezeLoopSec = 20, kFreezeSeamSec = 1.5, kFreezePrerollSec = 4, kFreezeSwapSec = 1.5,
                        kFreezeThawLeadSec = 1.5, kFreezeDebounceSec = 2, kFreezeWetTolDb = 1;
inline constexpr std::size_t kFreezeMaxBytes = 12 * 1024 * 1024;
inline constexpr double kFxIdlePollSec = 0.25;  // fx.js FX_IDLE_POLL_SEC (audio.js polls drone.freezeTick)

/** The live reverb as the frozen loop bakes it in (audio.js _droneFreezeEnv). */
struct FreezeEnv {
  bool hasIr = false;
  double size = 0, damp = 0;  // the IR (built again on the worker from these and the engine seed)
  std::string irKey;
  double predelay = 0, wet = 0;
};

/** What renderDroneLoop returns (drone-freeze.js). */
struct LoopResult {
  std::shared_ptr<const AudioBuf> buffer;
  double loopSec = 0, renderMs = 0;
  std::size_t bytes = 0;
  double seamDelta = 0, bodyDelta = 0;
  bool seamOk = true;
  std::string error;  // non-empty: the render failed
};

/** renderDroneLoop inputs. */
struct LoopRequest {
  std::uint32_t seed = 1;
  double sampleRate = 48000;
  int pc = 0;
  bool minor = false;
  double brightness = 0.5, movement = 0.3, width = 0.7, trimDb = 0;
  FreezeEnv reverb;  // !hasIr or wet <= 0: dry
  double loopSec = kFreezeLoopSec, seamSec = kFreezeSeamSec, prerollSec = kFreezePrerollSec;
};

class DroneHost {
 public:
  virtual ~DroneHost() = default;
  /** ctx.currentTime */
  virtual double now() const = 0;
  virtual double sampleRate() const = 0;
  virtual std::uint32_t seed() const = 0;
  /** Offline context (no freeze; JS has no pad files offline either, the native drone has: see the header). */
  virtual bool offline() const = 0;
  /** A DroneOp to the unit, delivered at the quantum of engine time `when` (< 0 or past: the next quantum). drone.js
   *  calls AudioParams immediately; the core delivers its param timeline calls at the time of the call that made them
   *  (`t`), so a fade scheduled ahead (an offline script) never meets the previous fade's events in one 64-event
   *  wa::Param timeline (T04 finding 4); everything else goes at once. */
  virtual void send(Command c, double when) = 0;
  /** AudioTimer.at(t, cb): cb(max(t, now)) on the control thread at the quantum of t. */
  virtual void at(double t, std::function<void(double)> fn) = 0;
  virtual void warn(const std::string &msg) = 0;
  /** o.wake: the engine's sleeping send effects / audio sleep (idle-cpu #2). */
  virtual void wake() {}
  virtual FreezeEnv freezeEnv() { return {}; }
  /** Decode a pad file to the engine rate: `done` on the control thread (null = failed), maybe synchronously. */
  virtual void decodePad(const std::string &path, std::function<void(std::shared_ptr<const AudioBuf>)> done) {
    (void)path;
    done(nullptr);
  }
  /** renderDroneLoop on a worker (inline offline): `done` on the control thread. */
  virtual void renderLoop(const LoopRequest &req, std::function<void(LoopResult)> done);
};

/** Pad file attached with attachFiles: {name, path}. */
struct PadFile {
  std::string name, path;
};

class DroneCore {
 public:
  DroneCore(DroneHost &host, Rng rng);
  ~DroneCore();
  DroneCore(const DroneCore &) = delete;
  DroneCore &operator=(const DroneCore &) = delete;

  /** The unit's construction state (the drone.js constructor + setTrim(trimDb) at time 0). */
  DroneInit unitInit(double trimDb);
  void setTrim(double db);

  bool setParam(std::string_view key, double value, double when, double glide = 0);
  double getParam(std::string_view key) const;
  /** configure(d, {when}) from a song.drone JSON object (mode, chordFollow, continueAcrossSongs,
   *  minorUsesRelativeMajorFile, gain, brightness, movement, width, fade). */
  void configure(const yyjson_val *d, double when);
  struct Config {
    std::optional<std::string> mode;
    std::optional<bool> chordFollow, continueAcrossSongs, minorUsesRelativeMajorFile;
    std::optional<double> gain, brightness, movement, width, fade;
  };
  void configure(const Config &d, double when);
  void songChanged(double when);
  void setMode(std::string_view mode, double when);
  bool setKey(int pc, bool minor, double fade, double when);  // fade < 0 or NaN: drone.fade
  void notesChanged(const std::vector<int> &held, double when);
  void bendSwell(double x, double when);
  bool pedalSwell(bool on, double when);
  void wheel(double gain, double when, double tc);
  int attachFiles(const std::vector<PadFile> &files);

  // ---- freeze (lowres2) ----
  bool setFrozen(bool on, double when);
  void setFreezeOptions(double loopSec, double debounceSec, double prerollSec);
  void freezeTick(double t);
  /** Test hook (drone-freeze fixtures): render a loop now and play it alone at unit level from `when`. */
  void playLoopTest(const LoopRequest &req, double when);
  bool freezeOn() const { return freezeOn_; }

  // ---- state / stats ----
  bool sounding() const { return sounding_; }
  bool parked() const { return parked_; }
  const std::string &mode() const { return cfg_.mode; }
  const std::string &effectiveMode() const { return effectiveMode_; }
  bool hasKey() const { return key_.has_value(); }
  int keyPc() const { return key_ ? key_->pc : -1; }
  bool keyMinor() const { return key_ && key_->minor; }
  bool chordFollow() const { return cfg_.chordFollow; }
  std::size_t layerCount() const { return layers_.size(); }
  std::size_t followCount() const { return follow_.voices.size(); }
  std::size_t idleCount() const { return idle_.size(); }
  std::size_t instCount() const;
  std::size_t activeEls() const { return activeEls_.size(); }
  bool frozen() const { return static_cast<bool>(frozen_); }
  unsigned renders() const { return fz_.renders; }
  unsigned reused() const { return fz_.reused; }
  bool freezePending() const { return fz_.pendingSig.has_value(); }
  /** Target frequencies (Hz) of the chord-follow voicing, bass first; empty when not following. */
  std::vector<double> debugTargets() const;
  const PadFile *fileFor(int pc, bool minor) const;
  void setMinorUsesRelativeMajorFile(bool v) { cfg_.minorUsesRelativeMajorFile = v; }
  /** Tests: drone-osc instruments built so far; pad players released while still audible (> 0.05, REVIEW #3). */
  unsigned instBuilds() const { return builds_; }
  unsigned hardCuts() const { return hardCuts_; }
  struct ElInfo {
    unsigned idx;
    bool busy, started;
    std::string name;
  };
  std::vector<ElInfo> pool() const;
  /** freezeStats() as `"k":v,...` (_debugStats members). */
  std::string freezeStatsJson() const;
  /** getState() as JSON. */
  std::string stateJson() const;
  /** The unit's instrument-slot table changed rate: new wavetables for every instrument (T11a O4). */
  void rateChanged(double sampleRate);

 private:
  struct Key {
    int pc = 0;
    bool minor = false;
  };
  struct Fade {
    double t = 0, dur = 0, from = 0, to = 1;
    bool lin = false;
  };
  struct InstEntry {  // drone.js {inst, gain, armed}
    int slot = -1;
    bool armed = false;
  };
  struct Layer {
    InstEntry pe;
    std::vector<int> notes;
    Fade fade;
    bool dead = false;
    double voiceT = 0, attack = 0;
    bool hasKey = false;
    Key key;
    int base = 0;  // follow voice
    double bend = 0;
  };
  using LayerP = std::shared_ptr<Layer>;
  struct Region {
    bool loop = true;
    double ls = 0, le = 0, xf = 0;
  };
  struct El {  // a pool element (drone.js `<audio>` + its gain)
    unsigned idx = 0;
    bool busy = false, pending = false, started = false, fadingOut = false, stealing = false;
    unsigned seq = 0;
    std::optional<Fade> fade;
    const PadFile *file = nullptr;
    PadFile fileCopy;
    Region region;
    double t0 = 0, off = 0;  // playback started at t0 from offset `off` (media position = off + (t - t0))
  };
  using ElP = std::shared_ptr<El>;
  struct Sig {
    int pc = 0;
    bool minor = false;
    double brightness = 0, movement = 0, width = 0, trimDb = 0;
    std::string irKey;  // "" = null
    double predelay = 0, wet = 0;
    FreezeEnv env;
  };
  struct Frozen {
    int loop = -1;
    Sig sig;
    bool dead = false;
    double t0 = 0;
    Fade fade;
    double loopSec = 0;
    std::size_t bytes = 0;
    double renderMs = 0, seamDelta = 0, bodyDelta = 0;
    bool seamOk = true;
    double thawAt = 0;
    std::optional<double> end;
    std::shared_ptr<const AudioBuf> buf;
  };
  using FrozenP = std::shared_ptr<Frozen>;

  /** AudioParam proxy for time/automation.h: each call = one DroneOp::Param. */
  struct PRef {
    DroneCore *d;
    std::uint32_t idx;
    bool setValueAtTime(double v, double t) { return d->paramOp(idx, ParamCall::Set, v, t, 0); }
    bool linearRampToValueAtTime(double v, double t) { return d->paramOp(idx, ParamCall::Linear, v, t, 0); }
    bool exponentialRampToValueAtTime(double v, double t) { return d->paramOp(idx, ParamCall::Exp, v, t, 0); }
    bool setTargetAtTime(double v, double t, double tc) { return d->paramOp(idx, ParamCall::Target, v, t, tc); }
    bool cancelAndHoldAtTime(double t) { return d->paramOp(idx, ParamCall::CancelHold, 0, t, 0); }
    bool cancelScheduledValues(double t) { return d->paramOp(idx, ParamCall::CancelScheduled, 0, t, 0); }
    double intrinsic() const;  // param.value: never read by drone.js helpers (every call passes `from`)
  };
  bool paramOp(std::uint32_t idx, ParamCall call, double v, double t, double tc);
  /** The time of the outermost public call in progress (param ops are delivered at it). */
  struct CallTime {
    DroneCore &d;
    bool outer;
    CallTime(DroneCore &dc, double tt) : d(dc), outer(dc.callT_ < 0) {
      if (outer) d.callT_ = tt;
    }
    ~CallTime() {
      if (outer) d.callT_ = -1;
    }
  };
  double callT_ = -1;
  PRef prm(std::uint32_t idx) { return PRef{this, idx}; }
  void op(DroneOp o, unsigned aux, double a = 0, double b = 0, double c = 0, std::uint16_t sub = 0);
  void opOwned(DroneOp o, unsigned aux, Owned *payload, double u0 = 0, double u1 = 0, double u2 = 0);

  double t(double when) const;
  double levelTarget() const;
  void swellLevel(double t, double tc);
  void gainChanged(double t);
  void applyWidth(double t);
  void applyInstParams(const InstEntry &e, double t);
  double voiceAttack() const;
  std::optional<InstEntry> buildInst();
  std::optional<InstEntry> takeInst(double t);
  void returnInst(const InstEntry &e);
  void freeSlot(int slot);
  void start(const Key &key, double fade, double t, bool modeSwitch);
  void fadeOutAll(double t, double fade);
  LayerP newLayer(const std::vector<int> &notes, double t, double fade, double vel, double fadeAt,
                  std::optional<double> attack);
  void fadeOutLayer(const LayerP &L, double t, double fade);
  void synthTo(const Key &key, double fade, double t, std::optional<double> attack);
  void revoice(double t);
  void applyFollow(const std::vector<int> &input, double t);
  LayerP followVoice(int note, double t, double fade);
  void endFollow(double t);
  void warnOnce(const std::string &key, const std::string &msg);
  // files
  void filesTo(const PadFile *file, double fade, double t);
  void ensurePool();
  ElP addEl();
  double elLevel(const El &e, double t) const;
  std::pair<ElP, double> grab();
  void releaseEl(const ElP &e);
  void fadeOutEl(const ElP &e, double t, double fade);
  using OnStarted = std::function<void(const ElP &, double)>;
  ElP play(const PadFile *file, double fade, double t, std::optional<double> offset, OnStarted onStarted,
           std::optional<double> startAt = std::nullopt);
  void fadeInEl(const ElP &e, double t, double fade);
  void scheduleLoop(const ElP &e, double t);
  std::shared_ptr<const AudioBuf> padBuffer(const std::string &path) const;
  // freeze
  bool freezable() const;
  Sig freezeSig();
  static bool sigSame(const Sig *a, const Sig *b);
  void freezeInvalidate();
  void freezeUpdate(double t);
  void freezeRender(unsigned seq);
  void freezeSwap(const LoopResult &res, const Sig &sig, double t);
  void fadeOutFrozen(const FrozenP &fz, double t, double fade, bool lin = false);
  void disposeFrozen(const FrozenP &fz);
  double thawLead() const;
  void thaw(double t);
  void unthaw(const FrozenP &fz, double t);
  int freeLoopSlot() const;
  void armFreezePoll();

  DroneHost &h_;
  Rng rng_;
  // params / cfg
  struct P {
    double gain = 0.5011872336272722, brightness = 0.5, movement = 0.3, width = 0.7, fade = 4;
  } p_;
  struct Cfg {
    std::string mode = "off";
    bool chordFollow = false, continueAcrossSongs = true, minorUsesRelativeMajorFile = true;
  } cfg_;
  double trimDb_ = 0;
  std::optional<Key> key_;
  bool sounding_ = false, parked_ = false;
  std::string effectiveMode_ = "off";
  std::vector<LayerP> layers_;
  struct Follow {
    std::vector<LayerP> voices;
    bool pendingSet = false;
    std::optional<std::vector<int>> targets;
    unsigned seq = 0;
    struct Change {
      double t;
      unsigned seq;
      std::vector<int> input;
    };
    std::vector<std::shared_ptr<Change>> changes;
    std::shared_ptr<Change> pending;
  } follow_;
  std::vector<InstEntry> idle_;
  bool slotUsed_[kMaxInst] = {};
  bool disposed_ = false;
  std::map<std::string, bool> warned_;
  unsigned parkSeq_ = 0;
  wa::Move levelMove_;
  bool pedalOn_ = false;
  double bendUp_ = 0, bendDuck_ = 1;
  // files
  std::map<std::string, PadFile> files_;  // 'pc|minor' -> file
  std::vector<ElP> pool_;
  std::vector<ElP> activeEls_;
  std::map<std::string, std::shared_ptr<const AudioBuf>> padCache_;  // decoded pads (the playing ones + 1)
  std::vector<std::string> padLru_;
  // freeze
  FrozenP frozen_;
  std::vector<FrozenP> fzOut_;
  bool freezeOn_ = false, sendMuted_ = false, pollArmed_ = false;
  struct Fz {
    unsigned seq = 0;
    bool cancelArmed = false;
    std::optional<Sig> pendingSig;
    bool rendering = false, immediate = false;
    unsigned renders = 0, reused = 0;
    std::optional<double> lastRenderMs;
    double loopSec = kFreezeLoopSec, debounce = kFreezeDebounceSec;
    std::optional<double> prerollSec;
    std::string lastError;
    struct Last {
      Sig sig;
      LoopResult res;
      std::string opts;
    };
    std::optional<Last> last;
    std::optional<unsigned> rerunSeq;
  } fz_;
  unsigned builds_ = 0, hardCuts_ = 0;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);  // async results check it
};

/** renderDroneLoop (drone-freeze.js): renders a private DroneCore + DroneUnit (+ the reverb chain) offline. Worker. */
LoopResult renderDroneLoop(const LoopRequest &req);

/** drone-freeze.js pure pieces. */
std::size_t freezeLoopFrames(double sr, double loopSec);
double seamCorrelation(const float *c, std::size_t start, std::size_t loopLen, std::size_t n);
/** In place on each channel; the loop is [start, start + loopLen). */
void makeSeamlessLoop(float *c, std::size_t start, std::size_t loopLen, std::size_t xf);
struct SeamCheck {
  double seamDelta = 0, bodyDelta = 0;
  bool ok = true;
};
SeamCheck seamCheck(const float *const *chans, unsigned nch, std::size_t n);

}  // namespace rig::drone
