#include "api/engine.h"

#include <algorithm>
#include <chrono>
#include <cstring>

#include "api/registry.h"
#include "bridge/bridge.h"
#include "graph/test_points.h"
#include "bridge/json_out.h"
#include "meter/meter.h"
#include "num/hash_seed.h"
#include "rec/rec.h"
#include "yyjson.h"

namespace rig {
namespace {

constexpr unsigned Q = RIG_QUANTUM_FRAMES;

bool looksLikeJson(const char *s, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) {
    const char c = s[i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
    return c == '{' || c == '[';
  }
  return false;
}

std::uint32_t computeSeed(const rig_config &cfg) {
  std::uint32_t seed = cfg.seed_string ? hashSeed(cfg.seed_string) : cfg.seed;
  if (seed == 0 && cfg.mode == RIG_MODE_REALTIME)
    seed = static_cast<std::uint32_t>(std::chrono::steady_clock::now().time_since_epoch().count()) | 1u;
  return seed;
}

}  // namespace

UnitEnv Engine::makeEnv(const rig_config &cfg, std::uint32_t seed) {
  UnitEnv env;
  env.sampleRate = cfg.sample_rate > 0 ? cfg.sample_rate : 48000.0;
  env.seed = seed;
  return env;  // env.config is pointed at cfg_ in the constructor body (cfg_ is final there)
}

Engine::Engine(const rig_config &cfg)
    : cfg_(cfg),
      seed_(computeSeed(cfg)),
      outCh_(cfg.output_channels >= 4 ? 4u : 2u),
      graph_(cfg.sample_rate > 0 ? cfg.sample_rate : 48000.0, cmdQ_, evQ_, meters_),
      model_(*this, [&] {
        UnitEnv env = makeEnv(cfg, seed_);
        env.config = &cfg_;
        return env;
      }()) {
  if (cfg.host) host_ = *cfg.host;
  cfg_.host = cfg.host ? &host_ : nullptr;
  auto keep = [](const char *s, std::string &store, const char *&ptr) {
    if (s) store = s;
    ptr = s ? store.c_str() : nullptr;
  };
  keep(cfg.app_dir, appDir_, cfg_.app_dir);
  keep(cfg.user_manifest, userManifest_, cfg_.user_manifest);
  keep(cfg.pads_dir, padsDir_, cfg_.pads_dir);
  keep(cfg.recordings_dir, recDir_, cfg_.recordings_dir);
  keep(cfg.seed_string, seedString_, cfg_.seed_string);
  EnginePaths paths;
  paths.appDir = appDir_;
  paths.userManifest = userManifest_;
  paths.padsDir = padsDir_;
  paths.recordingsDir = recDir_;
  model_.setPaths(paths);
  bridge_ = std::make_unique<Bridge>(*this);
  meterSvc_ = MeterServiceImpl::of(model_);
  recSvc_ = RecServiceImpl::of(model_);
}

Engine *Engine::create(const rig_config &cfg, rig_status *err) {
  auto fail = [&](rig_status s) -> Engine * {
    if (err) *err = s;
    return nullptr;
  };
  if (cfg.mode != RIG_MODE_REALTIME && cfg.mode != RIG_MODE_OFFLINE) return fail(RIG_E_INVALID);
  if (cfg.sample_rate < 8000.0 || cfg.sample_rate > 384000.0) return fail(RIG_E_INVALID);
  ensureModulesRegistered();
  Engine *e = new (std::nothrow) Engine(cfg);
  if (!e) return fail(RIG_E_NOMEM);
  if (cfg.mode == RIG_MODE_REALTIME) {
    e->rtRunning_ = true;
    e->control_ = std::thread([e] { e->controlLoop(); });
  }
  if (err) *err = RIG_OK;
  return e;
}

Engine::~Engine() {
  if (control_.joinable()) {
    stop_ = true;
    wake_.release();
    control_.join();
  }
  {
    std::lock_guard<std::mutex> lk(hostMu_);
    hostStop_ = true;
  }
  hostCv_.notify_all();
  if (hostThread_.joinable()) hostThread_.join();
  // Free whatever the graph handed back or never consumed (the Graph destructor frees what it still holds).
  AudioEvent ev;
  while (evQ_.pop(ev)) freeGarbage(ev);
  while (graph_.popGarbage(ev)) freeGarbage(ev);
  Command c;
  while (cmdQ_.pop(c)) freeCommandPayload(c);
}

void Engine::at(double t, std::function<void(double)> fn) {
  timers_.at(t, sampleRate(), std::move(fn));
}

void Engine::onControl(std::function<void()> fn) {
  if (!realtime()) {
    fn();
    flush();
    return;
  }
  {
    std::lock_guard<std::mutex> lk(inMu_);
    hostCalls_.push_back(std::move(fn));
  }
  wake_.release();
}

void Engine::memoryPressure(int level) {
  onControl([this, level] { model_.memoryPressure(level); });
}

void Engine::setPaths(const char *userManifest, const char *padsDir) {
  EnginePaths p;
  if (userManifest) p.userManifest = userManifest;
  if (padsDir) p.padsDir = padsDir;
  onControl([this, p] { model_.setPaths(p); });
}

void Engine::drainGarbage() {
  AudioEvent ev;
  while (graph_.popGarbage(ev)) {
    model_.onAudioEvent(ev);  // Garbage only frees (and counts): safe from inside a Model call
    garbageFreed_.fetch_add(1, std::memory_order_relaxed);
  }
}

bool Engine::send(Command c) {
  c.seq = ++seq_;
  // Bound the garbage in flight (V13): every pointer the graph hands back comes from a command, so draining the
  // garbage ring every 1024 sends keeps it below ring + stash whatever the audio thread consumes meanwhile
  // (<= 1024 + command ring 16384 + heap 8192 + units < 32768 + 1024).
  if ((seq_ & 1023u) == 0) drainGarbage();
  if (cmdQ_.push(c)) return true;
  if (!realtime()) {  // offline: producer and consumer are the same thread, so make room by draining
    drainGarbage();
    graph_.drainCommands();
    return cmdQ_.push(c);
  }
  return false;
}

void Engine::log(int level, const std::string &msg) {
  if (cfg_.on_log) cfg_.on_log(cfg_.log_user, level, msg.c_str());
}

void Engine::emit(std::string &&json) {
  outBatch_.push_back(std::move(json));
}

void Engine::flush() {
  if (outBatch_.empty()) return;
  std::string payload;
  if (outBatch_.size() == 1) {
    payload = std::move(outBatch_[0]);
  } else {
    payload = "[";
    for (std::size_t i = 0; i < outBatch_.size(); ++i) {
      if (i) payload += ',';
      payload += outBatch_[i];
    }
    payload += ']';
  }
  outBatch_.clear();
  if (cfg_.on_event) cfg_.on_event(cfg_.event_user, payload.data(), payload.size());
}

void Engine::processMessage(const std::string &json) {
  if (!bridge_->handle(json.data(), json.size())) {
    JsonOut j;
    j.begin().kv("v", 1).kv("ev", "warn").kv("message", "malformed JSON message dropped").kv("code", "bad-request");
    j.end();
    emit(j.take());
  }
}

rig_status Engine::post(const char *json, std::size_t len) {
  if (!json || !looksLikeJson(json, len)) return RIG_E_INVALID;
  if (!realtime()) {
    const bool ok = bridge_->handle(json, len);
    flush();
    return ok ? RIG_OK : RIG_E_INVALID;
  }
  {
    std::lock_guard<std::mutex> lk(inMu_);
    if (inQ_.size() >= 16384) return RIG_E_FULL;
    inQ_.emplace_back(json, len);
  }
  wake_.release();
  return RIG_OK;
}

void Engine::postHostEvent(std::string &&json) {
  if (!realtime()) {
    emit(std::move(json));
    flush();
    return;
  }
  {
    std::lock_guard<std::mutex> lk(inMu_);
    hostEvents_.push_back(std::move(json));
  }
  wake_.release();
}

void Engine::drainAudioEvents() {
  // Garbage first and from its own ring (never dropped; SETUP_REVIEW 18 / V13): frees run on this thread only.
  drainGarbage();
  AudioEvent ev;
  bool dropped = false;
  while (evQ_.pop(ev)) {
    dropped = dropped || ev.kind == EventKind::Dropped;
    model_.onAudioEvent(ev);
  }
  // Ended bits: VoiceEnded events lost to a full ring come back as one VoiceEnded per affected slot with voice id
  // -1 ("rescan this slot": the owner polls the unit's live voices instead of trusting its own bookkeeping).
  if (const std::uint64_t bits = dropped ? graph_.takeEndedSlots() : 0) {
    for (unsigned s = 0; s < 64; ++s) {
      if (!(bits >> s & 1u)) continue;
      AudioEvent e{};
      e.kind = EventKind::VoiceEnded;
      e.sub = 1;  // synthesized
      e.frame = graph_.timeBase().frame;
      e.f.a = static_cast<double>(s);
      e.f.b = -1.0;
      model_.onAudioEvent(e);
      endedRescans_.fetch_add(1, std::memory_order_relaxed);
    }
  }
}

void Engine::controlLoop() {
  while (!stop_.load()) {
    wake_.try_acquire_for(std::chrono::milliseconds(4));
    wakePending_ = false;
    std::deque<std::string> batch;
    std::vector<std::string> hostEv;
    std::vector<std::function<void()>> calls;
    {
      std::lock_guard<std::mutex> lk(inMu_);
      batch.swap(inQ_);
      hostEv.swap(hostEvents_);
      calls.swap(hostCalls_);
    }
    for (auto &h : hostEv) emit(std::move(h));
    for (auto &fn : calls) fn();
    for (const auto &m : batch) processMessage(m);
    drainAudioEvents();
    timers_.runDue(graph_.timeBase().frame / Q);
    MidiIn mi;
    while (midiQ_.pop(mi)) {
      midiRecv_.fetch_add(1, std::memory_order_relaxed);
      model_.midiBytes(mi.port, mi.bytes, mi.len, mi.hostTimeNs);  // "midi" service (T07) parses and routes
    }
    checkWatchdog();
    pumpRec(false);
    emitTick();
    flush();
  }
}

std::string Engine::buildTick(bool withStats) {
  const TimeBase tb = graph_.timeBase();
  const rig_meters m = meters_.read();
  MeterServiceImpl *ms = meterSvc_;
  const bool unit = ms && ms->shared().attached.load(std::memory_order_relaxed);
  // out: peak since the previous tick from the meter unit (Q14: never misses a peak); else the graph's 64-quantum
  // window. t = engine time of the last rendered frame.
  const float pl = unit ? ms->shared().takePeak(0) : m.out_peak[0];
  const float pr = unit ? ms->shared().takePeak(1) : m.out_peak[1];
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "tick").kv("t", tb.time()).kv("frames", static_cast<double>(tb.rendered));
  j.key("out").beginArray().elem(pl).elem(pr).endArray();
  if (ms && ms->anySlot()) {  // contract 3.11 slotLevel: zeros for unsubscribed slots and in low-resource mode
    j.key("slots").beginArray();
    for (int i = 0; i < 4; ++i) {
      const bool on = ms->slotSubscribed(i) && !model_.lowResource();
      j.beginArray().elem(on ? m.slot_peak[i] : 0.0).elem(on ? m.slot_rms[i] : 0.0).endArray();
    }
    j.endArray();
  }
  if (ms && ms->rtaOn()) j.kv("rta", ms->rtaBase64());
  j.kvRaw("blockers", model_.sleepBlockersJson());
  j.kvBool("pedal", m.pedal != 0).kv("held", m.held);  // T14 fills the snapshot's pedal/held
  j.kvRaw("runtime", model_.runtimeStateJson());
  j.kv("cpu", m.cpu_load);
  if (latencySec_ > 0) j.kv("hostLatency", latencySec_);  // G7
  if (withStats) j.kvRaw("stats", statsJson());
  j.end();
  return j.take();
}

void Engine::emitTick() {
  // Realtime only (offline renders have no wall clock); none while asleep or before the device runs (contract 6.5).
  if (!rtRunning_ || !awake_ || !started_.load(std::memory_order_acquire)) return;
  const auto now = std::chrono::steady_clock::now();
  MeterServiceImpl *ms = meterSvc_;
  const double hz = ms ? ms->tickHz() : kActiveTickHz;
  if (now - lastTick_ < std::chrono::duration<double>(1.0 / hz)) return;
  const TimeBase tb = graph_.timeBase();
  if (static_cast<std::int64_t>(tb.rendered) == lastTickFrame_) return;  // nothing rendered since: no new t
  lastTickFrame_ = static_cast<std::int64_t>(tb.rendered);
  // keep the cadence even: the next deadline is one period after the previous one unless we fell behind
  lastTick_ = now - lastTick_ < std::chrono::duration<double>(2.0 / hz)
                  ? lastTick_ + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                    std::chrono::duration<double>(1.0 / hz))
                  : now;
  const bool stats = now - lastStats_ >= std::chrono::seconds(1);  // `stats` every 1 s (contract 6.5)
  if (stats) lastStats_ = now;
  emit(buildTick(stats));
}

void Engine::pumpRec(bool offline) {
  if (RecServiceImpl *r = recSvc_) r->pump(offline, graph_.timeBase().time());
}

void Engine::renderOne() {
  float *ptrs[RIG_MAX_OUTPUT_CHANNELS];
  for (unsigned c = 0; c < RIG_MAX_OUTPUT_CHANNELS; ++c) ptrs[c] = fifo_[c];
  if (!realtime()) {
    drainAudioEvents();
    timers_.runDue(graph_.frame() / Q);
    graph_.renderQuantum(ptrs, outCh_);
    pumpRec(true);  // the offline recorder writes inline, per quantum (no threads offline)
  } else {
    const auto t0 = std::chrono::steady_clock::now();
    graph_.renderQuantum(ptrs, outCh_);
    const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const double load = dt / (Q / graph_.sampleRate());
    if (load > 1.0) xruns_.fetch_add(1, std::memory_order_relaxed);
    graph_.setHostStats(static_cast<float>(load), xruns_.load(std::memory_order_relaxed));
    if (!evQ_.empty() && !wakePending_.exchange(true)) wake_.release();
  }
}

void Engine::fifoRead(float *const *out, uint32_t channels, uint32_t frames, bool) {
  uint32_t done = 0;
  while (done < frames) {
    if (fifoPos_ >= Q) {
      renderOne();
      fifoPos_ = 0;
    }
    const uint32_t n = std::min<uint32_t>(frames - done, Q - fifoPos_);
    for (uint32_t c = 0; c < channels; ++c) {
      if (c < outCh_)
        std::memcpy(out[c] + done, fifo_[c] + fifoPos_, n * sizeof(float));
      else
        std::memset(out[c] + done, 0, n * sizeof(float));
    }
    done += n;
    fifoPos_ += n;
  }
}

rig_status Engine::render(float *const *out, uint32_t channels, uint32_t frames, uint64_t hostTimeNs) {
  if (!out || channels == 0) return RIG_E_INVALID;
  auto zero = [&] {
    for (uint32_t c = 0; c < channels; ++c) std::memset(out[c], 0, frames * sizeof(float));
  };
  if (!realtime()) {
    zero();
    return RIG_E_STATE;
  }
  if (!rtRunning_ || !awake_ || !started_.load(std::memory_order_acquire)) {
    zero();
    return RIG_OK;
  }
  if (hostTimeNs) {  // the first frame of this block plays at hostTimeNs (runtime/clock_map.h)
    const std::int64_t first = graph_.frame() - static_cast<std::int64_t>(fifoPos_ < Q ? Q - fifoPos_ : 0);
    clock_.publish(hostTimeNs, first, graph_.sampleRate(), frames);
  }
  fifoRead(out, channels, frames, false);
  return RIG_OK;
}

rig_status Engine::offlineRender(float *const *out, uint32_t channels, uint32_t frames) {
  if (realtime()) return RIG_E_STATE;
  if (!out || channels == 0) return RIG_E_INVALID;
  fifoRead(out, channels, frames, true);
  flush();
  return RIG_OK;
}

rig_status Engine::midiIn(const char *port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs) {
  if (!bytes && len) return RIG_E_INVALID;
  // port table (SETUP_REVIEW 21c): stable index per id; a port the host never listed is interned on first use
  // (lock-free CAS; the table only grows, MidiPortTable::kMax ids)
  const std::uint16_t pid = midiPorts_.intern(port ? port : "");
  rig_status st = RIG_OK;
  for (std::size_t off = 0; off < len; off += 13) {
    MidiIn m{};
    m.hostTimeNs = hostTimeNs;
    m.port = pid;
    m.len = static_cast<std::uint8_t>(std::min<std::size_t>(13, len - off));
    std::memcpy(m.bytes, bytes + off, m.len);
    if (!midiQ_.push(m)) {
      midiDropped_.fetch_add(1, std::memory_order_relaxed);
      st = RIG_E_FULL;
    }
  }
  return st;
}

// ---- device lifecycle (T08: SETUP_REVIEW 25, G9, R15) --------------------------------------------------------------

void Engine::hostCallLoop() {
  std::unique_lock<std::mutex> lk(hostMu_);
  for (;;) {
    hostCv_.wait(lk, [&] { return hostStop_ || !hostJobs_.empty(); });
    if (hostJobs_.empty()) return;  // stop requested and nothing left
    auto fn = std::move(hostJobs_.front());
    hostJobs_.pop_front();
    lk.unlock();
    fn();  // may block (an AUHAL open): only this thread waits, the control loop keeps ticking
    lk.lock();
  }
}

void Engine::hostCall(std::function<void()> fn) {
  {
    std::lock_guard<std::mutex> lk(hostMu_);
    if (!hostThread_.joinable()) hostThread_ = std::thread([this] { hostCallLoop(); });
    hostJobs_.push_back(std::move(fn));
  }
  hostCv_.notify_one();
}

std::string Engine::stateFieldsJson(const char *state, double sr) const {
  JsonOut j;
  j.begin().kv("state", state).kv("sleep", sleepState_).kv("latencyMs", latencySec_ * 1000.0);
  j.kv("sampleRate", sr > 0 ? sr : sampleRate()).kv("deviceId", deviceId_).kv("channels", outCh_.load()).end();
  return j.take();
}

void Engine::emitState(const char *state, bool restarted) {
  devState_ = state;
  std::string f = stateFieldsJson(state);
  f.pop_back();
  std::string m = "{\"v\":1,\"ev\":\"state\"," + f.substr(1);
  if (restarted) m += ",\"restarted\":true";
  m += "}";
  emit(std::move(m));
}

const char *Engine::requestAudio(const std::string &action, const std::string &deviceId, double latency) {
  const bool restart = action == "restart" || action == "output";
  if (pending_ && restart) return "busy";  // contract 6.2 `busy`: a restart while the device is still opening
  if (pending_ || (action == "start" && started_.load(std::memory_order_acquire))) {
    emitState(devState_, false);  // start is idempotent (the JS start() promise is memoised): report, no new open
    return "";
  }
  if (realtime() && cfg_.host && !host_.audio_start) return "unsupported";
  model_.audioStarted(-1.0);  // global units (FX, master, click, drone, sinks) exist before the first sound
  if (!deviceId.empty() || action == "output") deviceId_ = deviceId.empty() ? "default" : deviceId;
  if (!realtime() || !cfg_.host) {  // offline, or no host: the caller drives rig_render() itself (tests)
    started_ = true;
    emitState("running", restart);
    return "";
  }
  // audio_start runs on the device thread and must return at once anyway (rig_host contract; the Apple layer opens
  // AUHAL on its own queue, SETUP_REVIEW 25). If it blocks, only the device thread waits; the watchdog reports a
  // `closed` state + `device` warning after kWatchdogSec while ticks, timers and MIDI keep running here.
  pending_ = true;
  restartPending_ = restart;
  deadline_ = std::chrono::steady_clock::now() +
              std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::duration<double>(
                  kWatchdogSec));
  emitState("suspended", false);  // G9: a state event before the reply
  const std::string dev = deviceId == "default" ? std::string() : deviceId;
  const unsigned ch = outCh_;
  hostCall([this, restart, dev, latency, ch] {
    if (restart && host_.audio_stop) host_.audio_stop(host_.user);
    host_.audio_start(host_.user, dev.empty() ? nullptr : dev.c_str(), latency, ch);
  });
  return "";
}

void Engine::checkWatchdog() {
  if (!pending_ || std::chrono::steady_clock::now() < deadline_) return;
  pending_ = false;
  emitState("closed", false);
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "warn").kv("message", "audio device did not start within 5 s").kv("code", "device");
  j.kv("op", "audio").end();
  emit(j.take());
}

bool Engine::sleepAudio(double ramp) {
  // contract 1.1 sleep: realtime only, only from awake and running. The Model ramps `out` (T14, sleep*); the
  // engine suspends rendering once the ramp has played (time pauses, like ctx.suspend()).
  if (!realtime() || !started_.load(std::memory_order_acquire) || std::strcmp(sleepState_, "awake") != 0)
    return false;
  const double r = std::isfinite(ramp) && ramp >= 0 ? ramp : 0.15;
  model_.sleep(r);
  sleepState_ = "sleeping";
  emitState(devState_, false);
  const double lead = std::clamp(2.0 * latencySec_, 0.01, 0.04);
  at(graph_.timeBase().time() + lead + r, [this](double) {
    if (std::strcmp(sleepState_, "sleeping") != 0) return;
    awake_ = false;
    sleepState_ = "asleep";
    emitState(devState_, false);
  });
  return true;
}

bool Engine::wakeAudio(double ramp) {
  if (std::strcmp(sleepState_, "awake") == 0) return true;  // idempotent
  const auto t0 = std::chrono::steady_clock::now();
  awake_ = true;
  model_.wake(std::isfinite(ramp) && ramp >= 0 ? ramp : 0.06);
  sleepState_ = "awake";
  std::string f = stateFieldsJson(devState_);
  f.pop_back();
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  JsonOut tail;
  tail.raw(",").kv("wakeMs", ms).kv("queued", 0);
  emit("{\"v\":1,\"ev\":\"state\"," + f.substr(1) + tail.take() + "}");
  return true;
}

void Engine::hostAudioStarted(const rig_device_info &info) {
  // Any thread, lock-free hand-off (SETUP_REVIEW 15/16): the audio thread adopts the rate before its next quantum
  // (Graph::renderQuantum -> adoptRate: time grid rebased, engine time continues, never backwards).
  const double sr = info.sample_rate >= 8000.0 && info.sample_rate <= 384000.0 ? info.sample_rate : sampleRate();
  graph_.requestSampleRate(sr);
  outCh_ = info.channels >= 4 ? 4u : 2u;
  started_ = true;
  const std::string id = info.device_id ? info.device_id : "";
  const double lat = info.output_latency_sec > 0 ? info.output_latency_sec : 0.0;
  onControl([this, id, lat, sr] {
    const bool restarted = restartPending_ || std::strcmp(devState_, "running") == 0;
    pending_ = false;
    restartPending_ = false;
    if (!id.empty()) deviceId_ = id;
    latencySec_ = lat;
    // the state event announces the rate the audio thread is about to adopt (RateChanged follows from the graph)
    devState_ = "running";
    std::string f = stateFieldsJson("running", sr);
    f.pop_back();
    std::string m = "{\"v\":1,\"ev\":\"state\"," + f.substr(1);
    if (restarted) m += ",\"restarted\":true";
    m += "}";
    emit(std::move(m));
  });
}

void Engine::hostAudioState(rig_device_state s, const char *msg) {
  static const char *names[] = {"running", "suspended", "interrupted", "closed"};
  const int k = s >= RIG_DEVICE_RUNNING && s <= RIG_DEVICE_CLOSED ? static_cast<int>(s) : 3;
  if (s != RIG_DEVICE_RUNNING) started_ = false;
  const std::string m = msg ? msg : "";
  onControl([this, k, m] {
    pending_ = false;
    emitState(names[k], false);
    if (k == 3 || (k != 1 && !m.empty())) {  // a failed open / lost device: `device` warning (contract 6.2)
      JsonOut j;
      j.begin().kv("v", 1).kv("ev", "warn").kv("message", m.empty() ? std::string("audio device closed") : m);
      j.kv("code", "device").kv("op", "audio").end();
      emit(j.take());
    }
  });
}

void Engine::hostDevicesChanged() {
  onControl([this] {
    JsonOut j;
    j.begin().kv("v", 1).kv("ev", "state").kv("state", devState_).kv("sleep", sleepState_);
    j.kvBool("devicesChanged", true).end();
    emit(j.take());
  });
}

rig_status Engine::midiPorts(const char *json, std::size_t len) {
  yyjson_doc *doc = yyjson_read(json, len, 0);
  if (!doc) return RIG_E_INVALID;
  yyjson_val *root = yyjson_doc_get_root(doc);
  if (!yyjson_is_arr(root)) {
    yyjson_doc_free(doc);
    return RIG_E_INVALID;
  }
  std::size_t i, n;
  yyjson_val *it;
  yyjson_arr_foreach(root, i, n, it) {
    yyjson_val *id = yyjson_obj_get(it, "id");
    if (id && yyjson_is_str(id)) midiPorts_.intern(yyjson_get_str(id));
  }
  yyjson_doc_free(doc);
  std::string copy(json, len);
  onControl([this, copy] { model_.midiPorts(copy.data(), copy.size()); });  // T07 diffs + emits `midi ports`
  return RIG_OK;
}

std::string Engine::midiPortId(std::uint16_t index) const {
  char buf[MidiPortTable::kIdLen];
  return midiPorts_.id(index, buf, sizeof buf) ? std::string(buf) : std::string();
}

rig_status Engine::getMeters(rig_meters *out) const {
  if (!out || out->struct_size < 16) return RIG_E_INVALID;
  *out = meters_.read();
  out->struct_size = sizeof(rig_meters);
  return RIG_OK;
}

std::string Engine::deviceListJson() {
  if (host_.audio_list_devices) {
    std::vector<char> buf(8192);
    const std::size_t need = host_.audio_list_devices(host_.user, buf.data(), buf.size());
    if (need >= buf.size()) {
      buf.resize(need + 1);
      host_.audio_list_devices(host_.user, buf.data(), buf.size());
    }
    return buf.data();
  }
  return "[]";
}

std::string Engine::statsJson() {
  const GraphStats &g = graph_.stats();
  const rig_meters m = meters_.read();
  JsonOut j;
  const TimeBase tb = graph_.timeBase();
  j.begin().kv("frames", static_cast<double>(tb.rendered)).kv("quanta", static_cast<double>(g.quanta.load()));
  j.kv("rateChanges", g.rateChanges.load()).kv("eventsDropped", g.eventsDropped.load());
  j.kv("heapDropped", g.heapDropped.load()).kv("paramDropped", g.paramDropped.load());
  j.kv("voicesStolen", g.voicesStolen.load()).kv("voices", m.voices).kv("xruns", m.xruns);
  j.kv("cmdDropped", model_.stats().droppedCommands).kv("midiDropped", midiDropped_.load());
  j.kv("midiReceived", midiRecv_.load()).kv("prepares", model_.stats().prepares);
  j.kv("commits", model_.stats().commits).kv("voicesEnded", model_.stats().voicesEnded).end();
  std::string out = j.take();
  const std::string extra = model_.statsJson();
  if (!extra.empty()) out.insert(out.size() - 1, "," + extra);
  return out;
}

// ---- test hooks ---------------------------------------------------------------------------------------------------

namespace {

/** A test point is served when it needs no unit, or a module unit is attached in its slot (with the local point
 *  listed in the kind's UnitInfo for unit-local points). graph/test_points.h. */
bool served(const Model &m, const TestPoint &p, bool tap) {
  if (!p.needsUnit) return true;
  if (!m.attachedIsModule(p.unit)) return false;
  if (p.local == kGraphBus) return true;
  const Registry::UnitEntry *e = Registry::global().unit(m.attachedKind(p.unit));
  const std::uint32_t mask = e ? (tap ? e->info.tapPoints : e->info.injectPoints) : 0u;
  return p.local < 32 && (mask >> p.local & 1u);
}

}  // namespace

rig_status Engine::testTap(const char *node) {
  if (!(cfg_.flags & RIG_FLAG_TEST_API) || realtime()) return RIG_E_UNSUPPORTED;
  const int i = tapIndex(node ? node : "");
  if (i < 0 || !served(model_, kTapPoints[i], true)) return RIG_E_UNSUPPORTED;
  Command c{};
  c.op = Op::TestTap;
  c.frame = kFrameNow;
  c.aux = static_cast<std::uint32_t>(i);
  return send(c) ? RIG_OK : RIG_E_FULL;
}

rig_status Engine::testInject(const char *node, const float *const *data, uint32_t channels, uint64_t frames,
                              double start, float gain) {
  if (!(cfg_.flags & RIG_FLAG_TEST_API) || realtime()) return RIG_E_UNSUPPORTED;
  const int i = injectIndex(node ? node : "");
  if (i < 0 || !served(model_, kInjectPoints[i], false)) return RIG_E_UNSUPPORTED;
  if (channels < 1 || channels > 2 || !data) return RIG_E_INVALID;
  auto *ib = new (std::nothrow) InjectBuffer();
  if (!ib) return RIG_E_NOMEM;
  ib->point = static_cast<unsigned>(i);
  ib->channels = channels;
  ib->frames = frames;
  ib->gain = gain;
  ib->startFrame = std::llround(start * sampleRate());
  ib->storage = new (std::nothrow) float[frames * channels];
  if (!ib->storage) {
    delete ib;
    return RIG_E_NOMEM;
  }
  for (uint32_t c = 0; c < channels; ++c) {
    ib->data[c] = ib->storage + c * frames;
    std::memcpy(ib->data[c], data[c], frames * sizeof(float));
  }
  Command c{};
  c.op = Op::TestInject;
  c.frame = kFrameNow;
  c.p.ptr = ib;
  if (!send(c)) {
    delete ib;
    return RIG_E_FULL;
  }
  return RIG_OK;
}

std::size_t Engine::testQuery(const char *what, char *buf, std::size_t cap) {
  const std::string w = what ? what : "";
  std::string out;
  if (w == "stats")
    out = statsJson();
  else if (w == "getState")
    out = model_.stateJson();
  else
    out = "null";
  if (buf && cap) {
    const std::size_t n = std::min(out.size(), cap - 1);
    std::memcpy(buf, out.data(), n);
    buf[n] = 0;
  }
  return out.size();
}

}  // namespace rig
