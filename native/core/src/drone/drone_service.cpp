// The "drone" service (drone/drone_service.h), T16.
#include "drone/drone_service.h"

#include <algorithm>
#include <cmath>
#include <map>

#include "api/registry.h"
#include "fx/ir_gen.h"
#include "fx/reverb.h"
#include "model/model.h"
#include "model/song.h"
#include "samples/decode.h"
#include "samples/manifest.h"
#include "samples/resampler.h"
#include "yyjson.h"

namespace rig::drone {
namespace {

std::mutex g_mapMu;
std::map<const PatchSpec *, DroneServiceImpl *> &serviceMap() {
  static std::map<const PatchSpec *, DroneServiceImpl *> m;
  return m;
}

samples::HostDecodeFn hostDecoder(const rig_config *c) {
  if (!c || !c->host || !c->host->decode_file) return nullptr;
  const rig_host *h = c->host;
  return [h](const std::string &path, samples::Pcm &out, std::string *err) {
    rig_decoded_audio a{};
    a.struct_size = sizeof a;
    if (h->decode_file(h->user, path.c_str(), &a) != 0 || !a.data || !a.channels || !a.frames) {
      if (err) *err = "host decode failed";
      return false;
    }
    out.sampleRate = a.sample_rate;
    out.channels = a.channels >= 2 ? 2 : 1;
    for (int ch = 0; ch < out.channels; ++ch) out.ch[ch].assign(a.data[ch], a.data[ch] + a.frames);
    if (h->free_decoded) h->free_decoded(h->user, &a);
    return true;
  };
}

/** Decode a pad to the engine rate (decodeAudioData's SincResampler when the file rate differs). Worker. */
std::shared_ptr<const AudioBuf> decodePadFile(const std::string &path, double sr, const samples::HostDecodeFn &host) {
  samples::DecodeResult r = samples::decodeFile(path, host);
  if (!r.ok() || r.pcm.frames() == 0) return nullptr;
  auto buf = std::make_shared<AudioBuf>();
  for (int c = 0; c < std::min(2, r.pcm.channels); ++c)
    samples::resampleChannel(r.pcm.ch[c], r.pcm.sampleRate, sr, buf->data[c]);
  buf->seal(sr);
  return buf;
}

double numOr(yyjson_val *o, const char *k, double d) {
  yyjson_val *v = o ? yyjson_obj_get(o, k) : nullptr;
  return v && yyjson_is_num(v) ? yyjson_get_num(v) : d;
}

}  // namespace

// ---- worker ---------------------------------------------------------------------------------------------------------

DroneWorker::~DroneWorker() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    stop_ = true;
  }
  cv_.notify_all();
  if (th_.joinable()) th_.join();
}

void DroneWorker::post(std::function<std::function<void()>()> job) {
  {
    std::lock_guard<std::mutex> lk(mu_);
    jobs_.push_back(std::move(job));
    ++outstanding_;
    if (!th_.joinable()) th_ = std::thread([this] { loop(); });
  }
  cv_.notify_one();
}

void DroneWorker::loop() {
  for (;;) {
    std::function<std::function<void()>()> job;
    {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait(lk, [&] { return stop_ || !jobs_.empty(); });
      if (stop_) return;
      job = std::move(jobs_.front());
      jobs_.pop_front();
    }
    std::function<void()> cont = job();
    std::lock_guard<std::mutex> lk(mu_);
    done_.push_back(std::move(cont));
  }
}

std::size_t DroneWorker::drain() {
  std::deque<std::function<void()>> ready;
  {
    std::lock_guard<std::mutex> lk(mu_);
    ready.swap(done_);
    outstanding_ -= ready.size();
  }
  for (auto &f : ready)
    if (f) f();
  return ready.size();
}

std::size_t DroneWorker::outstanding() const {
  std::lock_guard<std::mutex> lk(mu_);
  return outstanding_;
}

// ---- service --------------------------------------------------------------------------------------------------------

DroneServiceImpl::DroneServiceImpl(Model &m) : m_(m) {
  {
    std::lock_guard<std::mutex> lk(g_mapMu);
    serviceMap()[&m.patch()] = this;
  }
  // gain-trims.json droneTrim on the synth bus (audio.js _afterRegistry); 0 when the file is not there (as JS)
  const rig_config *c = m.env().config;
  if (c && c->app_dir && *c->app_dir) {
    samples::GainTrims trims;
    if (samples::loadGainTrims(std::string(c->app_dir) + "/js/engine/gain-trims.json", trims, nullptr))
      trimDb_ = trims.droneTrim;
  }
  if (c && c->pads_dir) padsDir_ = c->pads_dir;
}

DroneServiceImpl::~DroneServiceImpl() {
  *alive_ = false;
  core_.reset();
  worker_.reset();  // joins: no render outlives the service
  std::lock_guard<std::mutex> lk(g_mapMu);
  auto &map = serviceMap();
  for (auto it = map.begin(); it != map.end();) it = it->second == this ? map.erase(it) : std::next(it);
}

DroneServiceImpl *DroneServiceImpl::forPatch(const PatchSpec *patch) {
  std::lock_guard<std::mutex> lk(g_mapMu);
  auto it = serviceMap().find(patch);
  return it == serviceMap().end() ? nullptr : it->second;
}

Unit *DroneServiceImpl::buildUnit(const UnitEnv &env, const UnitSpec &) {
  // AudioEngine._build: new Drone({rng: rngFor(seed, 'drone'), ...}), then setTrim(droneTrim). A second unit (a
  // rebuilt graph) gets a fresh Drone with the old one's song state re-applied (audio.js applyState), after it is
  // attached.
  std::string prevCfg;
  bool hadKey = false, prevMinor = false;
  int prevPc = 0;
  std::string prevMode;
  if (core_) {
    prevCfg = core_->stateJson();
    hadKey = core_->hasKey();
    prevPc = core_->keyPc();
    prevMinor = core_->keyMinor();
    prevMode = core_->mode();
  }
  core_ = std::make_unique<DroneCore>(*this, rngFor(env.seed, "drone"));
  auto *u = new DroneUnit(env.sampleRate, core_->unitInit(trimDb_));
  unit_ = u;
  if (!prevCfg.empty()) {
    std::weak_ptr<bool> alive = alive_;
    at(now(), [this, alive, prevCfg, hadKey, prevPc, prevMinor, prevMode](double t) {
      if (alive.expired() || !core_) return;
      yyjson_doc *d = yyjson_read(prevCfg.data(), prevCfg.size(), 0);
      if (!d) return;
      yyjson_val *root = yyjson_doc_get_root(d);
      DroneCore::Config c;
      if (yyjson_val *p = yyjson_obj_get(root, "params")) {
        c.gain = numOr(p, "gain", 0.5011872336272722);
        c.brightness = numOr(p, "brightness", 0.5);
        c.movement = numOr(p, "movement", 0.3);
        c.width = numOr(p, "width", 0.7);
        c.fade = numOr(p, "fade", 4);
      }
      c.chordFollow = yyjson_is_true(yyjson_obj_get(root, "chordFollow"));
      c.continueAcrossSongs = yyjson_is_true(yyjson_obj_get(root, "continueAcrossSongs"));
      c.minorUsesRelativeMajorFile = yyjson_is_true(yyjson_obj_get(root, "minorUsesRelativeMajorFile"));
      yyjson_doc_free(d);
      core_->configure(c, t);
      if (hadKey) core_->setKey(prevPc, prevMinor, NAN, t);
      core_->setMode(prevMode, t);
      applyFreeze();
    });
  }
  return u;
}

bool DroneServiceImpl::setKey(int pc, bool minor, double fade, double when) {
  if (!core_) return false;
  return core_->setKey(pc, minor, fade, when);
}

void DroneServiceImpl::configure(const yyjson_val *cfgv, double when) {
  if (!core_) {
    warn("drone.configure before start(); ignored.");
    return;
  }
  auto *cfg = const_cast<yyjson_val *>(cfgv);
  const rig_config *rc = m_.env().config;
  const bool testApi = rc && (rc->flags & RIG_FLAG_TEST_API);
  if (testApi && cfg && yyjson_is_obj(cfg)) {
    // test hooks (keep out of the bridge contract): the drone-freeze fixtures and the freeze state machine offline
    if (yyjson_val *o = yyjson_obj_get(cfg, "__freezeOptions"); o && yyjson_is_obj(o)) {
      core_->setFreezeOptions(numOr(o, "loopSec", NAN), numOr(o, "debounceSec", NAN), numOr(o, "prerollSec", NAN));
      if (yyjson_val *r = yyjson_obj_get(o, "realtime")) pretendRealtime_ = yyjson_is_true(r);
    }
    if (yyjson_val *f = yyjson_obj_get(cfg, "__freezeTest"); f && yyjson_is_obj(f)) {
      LoopRequest req;
      req.seed = m_.env().seed;
      req.sampleRate = sampleRate();
      yyjson_val *key = yyjson_obj_get(f, "key");
      req.pc = static_cast<int>(numOr(key, "pc", 0));
      req.minor = key && yyjson_is_true(yyjson_obj_get(key, "minor"));
      yyjson_val *p = yyjson_obj_get(f, "params");
      req.brightness = numOr(p, "brightness", 0.5);
      req.movement = numOr(p, "movement", 0.3);
      req.width = numOr(p, "width", 0.7);
      req.trimDb = trimDb_;
      req.loopSec = numOr(f, "loopSec", kFreezeLoopSec);
      req.prerollSec = numOr(f, "prerollSec", kFreezePrerollSec);
      req.seamSec = numOr(f, "seamSec", kFreezeSeamSec);
      yyjson_val *rv = yyjson_obj_get(f, "reverb");
      if (rv && yyjson_is_obj(rv)) {
        req.reverb.hasIr = true;
        req.reverb.size = numOr(rv, "size", 0.5);
        req.reverb.damp = numOr(rv, "damp", 0.5);
        req.reverb.predelay = numOr(rv, "predelay", 0.02);
        req.reverb.wet = numOr(rv, "wet", 1);
        req.reverb.irKey = fx::irKey(req.reverb.size, req.reverb.damp, req.sampleRate);
      }
      core_->playLoopTest(req, when);
    }
  }
  core_->configure(cfg, when);
  applyFreeze();  // a mode / chord-follow change: freeze or thaw now (JS: the next freezeTick)
}

int DroneServiceImpl::attachFiles(const yyjson_val *filesv) {
  if (!core_) return 0;
  auto *files = const_cast<yyjson_val *>(filesv);
  std::vector<PadFile> list;
  std::size_t i, n;
  yyjson_val *it;
  yyjson_arr_foreach(files, i, n, it) {
    if (!yyjson_is_obj(it)) continue;
    PadFile f;
    if (yyjson_val *v = yyjson_obj_get(it, "name"); v && yyjson_is_str(v)) f.name = yyjson_get_str(v);
    yyjson_val *p = yyjson_obj_get(it, "path");
    if (!p || !yyjson_is_str(p)) p = yyjson_obj_get(it, "url");  // the web shim's {name, url}
    if (p && yyjson_is_str(p)) f.path = yyjson_get_str(p);
    if (!f.path.empty() && f.path[0] != '/' && !padsDir_.empty() && f.path.find("://") == std::string::npos)
      f.path = padsDir_ + "/" + f.path;
    list.push_back(std::move(f));
  }
  return core_->attachFiles(list);
}

void DroneServiceImpl::onSongState(const SongState &s) {
  // INTERFACE-CHANGE(T16) O-W3-2: SongState.lowResource (set by Model::setLowResource)
  lowRes_ = s.lowResource;
  applyFreeze();
}

bool DroneServiceImpl::setFreezeConfig(bool on) {
  freezeCfg_ = on;
  applyFreeze();
  return freezeCfg_;
}

void DroneServiceImpl::applyFreeze() {
  // DECISIONS D5: droneFreeze true = audio.js drone.setFrozen(lowResource); false = never frozen
  if (core_) core_->setFrozen(lowRes_ && freezeCfg_, -1);
}

void DroneServiceImpl::onRateChanged(double sr) {
  if (core_) core_->rateChanged(sr);
}

void DroneServiceImpl::onPaths(const EnginePaths &paths) {
  if (!paths.padsDir.empty()) padsDir_ = paths.padsDir;
}

std::string DroneServiceImpl::statsFields() {
  if (!core_) return {};
  return core_->freezeStatsJson();
}

std::string DroneServiceImpl::stateJson() const {
  return core_ ? core_->stateJson() : std::string("null");
}

void DroneServiceImpl::droneWheel(double gain, double t, double tc) {
  if (core_) core_->wheel(gain, t, tc);
}
void DroneServiceImpl::dronePedalSwell(bool on, double t) {
  if (core_) core_->pedalSwell(on, t);
}
void DroneServiceImpl::droneBendSwell(double x, double t) {
  if (core_) core_->bendSwell(x, t);
}
void DroneServiceImpl::droneNotesChanged(const std::vector<int> &held, double t) {
  if (core_) core_->notesChanged(held, t);
}
void DroneServiceImpl::droneSongChanged(double t) {
  if (core_) core_->songChanged(t);
}

// ---- host -----------------------------------------------------------------------------------------------------------

double DroneServiceImpl::now() const {
  return m_.now();
}
double DroneServiceImpl::sampleRate() const {
  const double sr = const_cast<Model &>(m_).sink().timeBase().sampleRate;
  return sr > 0 ? sr : m_.env().sampleRate;
}
std::uint32_t DroneServiceImpl::seed() const {
  return m_.env().seed;
}
bool DroneServiceImpl::offline() const {
  const rig_config *c = m_.env().config;
  return c && c->mode == RIG_MODE_OFFLINE && !pretendRealtime_;
}
bool DroneServiceImpl::realtimeJobs() const {
  const rig_config *c = m_.env().config;
  return !(c && c->mode == RIG_MODE_OFFLINE);
}
void DroneServiceImpl::send(Command c, double when) {
  m_.sendUnitOp(UnitSlot::Drone, c, when);
}
void DroneServiceImpl::at(double t, std::function<void(double)> fn) {
  m_.sink().at(t, std::move(fn));
}
void DroneServiceImpl::warn(const std::string &msg) {
  m_.warn(msg, "drone");
}

void DroneServiceImpl::wake() {
  m_.wake(NAN);  // INTERFACE-CHANGE(W3A): no-op while awake (model/sleep.h)
}

FreezeEnv DroneServiceImpl::freezeEnv() {
  // audio.js _droneFreezeEnv: {ir, irKey, predelay, wet: ret.gain.value * wheel.gain.value} of the live reverb
  FreezeEnv e;
  if (m_.attachedKind(UnitSlot::Reverb) != kKindReverb) return e;
  const ReverbPatch &r = m_.patch().reverb;
  e.hasIr = true;
  e.size = r.size;
  e.damp = r.damp;
  e.irKey = fx::irKey(r.size, r.damp, sampleRate());
  e.predelay = r.predelay;
  e.wet = r.returnGain * m_.songGraph().factorFor("fx.reverb.returnGain");
  return e;
}

void DroneServiceImpl::armPoll() {
  if (pollArmed_ || !worker_ || worker_->outstanding() == 0) return;
  pollArmed_ = true;
  std::weak_ptr<bool> alive = alive_;
  at(now() + 0.02, [this, alive](double) {
    if (alive.expired()) return;
    pollArmed_ = false;
    if (worker_) worker_->drain();
    armPoll();
  });
}

void DroneServiceImpl::decodePad(const std::string &path, std::function<void(std::shared_ptr<const AudioBuf>)> done) {
  const double sr = sampleRate();
  samples::HostDecodeFn host = hostDecoder(m_.env().config);
  if (!realtimeJobs()) {
    done(decodePadFile(path, sr, host));
    return;
  }
  if (!worker_) worker_ = std::make_unique<DroneWorker>();
  worker_->post([path, sr, host, done]() -> std::function<void()> {
    auto buf = decodePadFile(path, sr, host);
    return [done, buf] { done(buf); };
  });
  armPoll();
}

void DroneServiceImpl::renderLoop(const LoopRequest &req, std::function<void(LoopResult)> done) {
  if (!realtimeJobs()) {
    done(renderDroneLoop(req));
    return;
  }
  if (!worker_) worker_ = std::make_unique<DroneWorker>();
  worker_->post([req, done]() -> std::function<void()> {
    LoopResult r = renderDroneLoop(req);  // never on the audio thread (ARCHITECTURE 3.1: IR worker class)
    return [done, r] { done(r); };
  });
  armPoll();
}

bool setDroneFreeze(Model &m, bool on, bool *now) {
  auto *s = dynamic_cast<DroneServiceImpl *>(m.service(DroneService::kName));
  if (!s) return false;
  const bool v = s->setFreezeConfig(on);
  if (now) *now = v;
  return true;
}

}  // namespace rig::drone
