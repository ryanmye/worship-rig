#include "api/engine.h"

#include <algorithm>
#include <chrono>
#include <cstring>

#include "bridge/bridge.h"
#include "bridge/json_out.h"
#include "num/hash_seed.h"
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

}  // namespace

Engine::Engine(const rig_config &cfg)
    : cfg_(cfg),
      sr_(cfg.sample_rate > 0 ? cfg.sample_rate : 48000.0),
      outCh_(cfg.output_channels >= 4 ? 4u : 2u),
      graph_(sr_, cmdQ_, evQ_, meters_),
      model_(*this) {
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
  seed_ = cfg.seed_string ? hashSeed(cfg.seed_string) : cfg.seed;
  if (seed_ == 0 && cfg.mode == RIG_MODE_REALTIME)
    seed_ = static_cast<std::uint32_t>(std::chrono::steady_clock::now().time_since_epoch().count()) | 1u;
  bridge_ = std::make_unique<Bridge>(*this);
}

Engine *Engine::create(const rig_config &cfg, rig_status *err) {
  auto fail = [&](rig_status s) -> Engine * {
    if (err) *err = s;
    return nullptr;
  };
  if (cfg.mode != RIG_MODE_REALTIME && cfg.mode != RIG_MODE_OFFLINE) return fail(RIG_E_INVALID);
  if (cfg.sample_rate < 8000.0 || cfg.sample_rate > 384000.0) return fail(RIG_E_INVALID);
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
  // Free whatever the graph handed back or never consumed.
  AudioEvent ev;
  while (evQ_.pop(ev)) model_.onAudioEvent(ev);
}

bool Engine::send(Command c) {
  c.seq = ++seq_;
  if (cmdQ_.push(c)) return true;
  if (!realtime()) {  // offline: producer and consumer are the same thread, so make room by draining
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
  AudioEvent ev;
  while (evQ_.pop(ev)) model_.onAudioEvent(ev);
}

void Engine::controlLoop() {
  while (!stop_.load()) {
    wake_.try_acquire_for(std::chrono::milliseconds(4));
    wakePending_ = false;
    std::deque<std::string> batch;
    std::vector<std::string> hostEv;
    {
      std::lock_guard<std::mutex> lk(inMu_);
      batch.swap(inQ_);
      hostEv.swap(hostEvents_);
    }
    for (auto &h : hostEv) emit(std::move(h));
    for (const auto &m : batch) processMessage(m);
    drainAudioEvents();
    timers_.runDue(frames_.load(std::memory_order_acquire) / Q);
    MidiIn mi;
    while (midiQ_.pop(mi)) midiRecv_.fetch_add(1, std::memory_order_relaxed);  // T07 parses and routes
    emitTick();
    flush();
  }
}

void Engine::emitTick() {
  if (!rtRunning_ || !awake_) return;
  const std::int64_t f = frames_.load(std::memory_order_acquire);
  if (f - lastTickFrame_ < static_cast<std::int64_t>(sr_ / 30.0)) return;
  lastTickFrame_ = f;
  const rig_meters m = meters_.read();
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "tick").kv("t", static_cast<double>(f) / sr_).kv("frames", static_cast<double>(f));
  j.key("out").beginArray().elem(m.out_peak[0]).elem(m.out_peak[1]).endArray();
  j.kv("pedal", 0).kv("held", 0).kv("cpu", m.cpu_load).end();
  emit(j.take());
}

void Engine::renderOne() {
  float *ptrs[RIG_MAX_OUTPUT_CHANNELS];
  for (unsigned c = 0; c < RIG_MAX_OUTPUT_CHANNELS; ++c) ptrs[c] = fifo_[c];
  if (!realtime()) {
    drainAudioEvents();
    timers_.runDue(graph_.frame() / Q);
    graph_.renderQuantum(ptrs, outCh_);
  } else {
    const auto t0 = std::chrono::steady_clock::now();
    graph_.renderQuantum(ptrs, outCh_);
    const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const double load = dt / (Q / sr_);
    if (load > 1.0) xruns_.fetch_add(1, std::memory_order_relaxed);
    graph_.setHostStats(static_cast<float>(load), xruns_.load(std::memory_order_relaxed));
    if (!evQ_.empty() && !wakePending_.exchange(true)) wake_.release();
  }
  frames_.store(graph_.frame(), std::memory_order_release);
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

rig_status Engine::render(float *const *out, uint32_t channels, uint32_t frames, uint64_t) {
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
  std::uint16_t pid = 0;
  for (const char *p = port ? port : ""; *p; ++p)
    pid = static_cast<std::uint16_t>(pid * 31u + static_cast<unsigned char>(*p));
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

void Engine::requestAudio(const std::string &action, const std::string &deviceId, double latency) {
  if (!realtime()) {
    started_ = true;
    return;
  }
  (void)action;
  if (host_.audio_start) {
    host_.audio_start(host_.user, deviceId.empty() ? nullptr : deviceId.c_str(), latency, outCh_);
  } else {
    started_ = true;  // no host: the caller drives rig_render() itself (tests)
  }
}

void Engine::hostAudioStarted(const rig_device_info &info) {
  if (!started_.load() && info.sample_rate >= 8000.0) {
    sr_ = info.sample_rate;
    graph_.setSampleRate(sr_);
  }
  if (info.channels >= 4) outCh_ = 4;
  started_ = true;
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "state").kv("state", "running").kv("sleep", "awake");
  j.kv("latencyMs", info.output_latency_sec * 1000.0).kv("sampleRate", sr_);
  j.kv("deviceId", info.device_id ? info.device_id : "").kv("channels", outCh_).end();
  postHostEvent(j.take());
}

void Engine::hostAudioState(rig_device_state s, const char *msg) {
  static const char *names[] = {"running", "suspended", "interrupted", "closed"};
  if (s != RIG_DEVICE_RUNNING) started_ = false;
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "state").kv("state", names[s]);
  if (msg) j.kv("message", msg);
  j.end();
  postHostEvent(j.take());
}

void Engine::hostDevicesChanged() {
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "state").kvBool("devicesChanged", true).end();
  postHostEvent(j.take());
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
  j.begin().kv("frames", static_cast<double>(frames_.load())).kv("quanta", static_cast<double>(g.quanta.load()));
  j.kv("heapDropped", g.heapDropped.load()).kv("paramDropped", g.paramDropped.load());
  j.kv("voicesStolen", g.voicesStolen.load()).kv("voices", m.voices).kv("xruns", m.xruns);
  j.kv("cmdDropped", model_.stats().droppedCommands).kv("midiDropped", midiDropped_.load());
  j.kv("midiReceived", midiRecv_.load()).kv("prepares", model_.stats().prepares);
  j.kv("commits", model_.stats().commits).kv("voicesEnded", model_.stats().voicesEnded).end();
  return j.take();
}

// ---- test hooks ---------------------------------------------------------------------------------------------------

rig_status Engine::testTap(const char *node) {
  if (!(cfg_.flags & RIG_FLAG_TEST_API) || realtime()) return RIG_E_UNSUPPORTED;
  std::uint32_t id;
  const std::string n = node ? node : "";
  if (n == "out")
    id = 0;
  else if (n.size() == 9 && n.compare(0, 4, "slot") == 0 && n[4] >= '0' && n[4] <= '3' && n.compare(5, 4, ".pan") == 0)
    id = static_cast<std::uint32_t>(n[4] - '0') + 1;
  else
    return RIG_E_UNSUPPORTED;
  Command c{};
  c.op = Op::TestTap;
  c.frame = kFrameNow;
  c.aux = id;
  return send(c) ? RIG_OK : RIG_E_FULL;
}

rig_status Engine::testInject(const char *node, const float *const *data, uint32_t channels, uint64_t frames,
                              double start, float gain) {
  if (!(cfg_.flags & RIG_FLAG_TEST_API) || realtime()) return RIG_E_UNSUPPORTED;
  if (!node || std::strcmp(node, "slot0.strip") != 0) return RIG_E_UNSUPPORTED;
  if (channels < 1 || channels > 2 || !data) return RIG_E_INVALID;
  auto *ib = new (std::nothrow) InjectBuffer();
  if (!ib) return RIG_E_NOMEM;
  ib->channels = channels;
  ib->frames = frames;
  ib->gain = gain;
  ib->startFrame = std::llround(start * sr_);
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
