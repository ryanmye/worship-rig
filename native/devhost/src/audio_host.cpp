// rig_host over miniaudio (see audio_host.h).
#include "audio_host.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>

#include "miniaudio_config.h"
#include "miniaudio.h"
#include "runtime/rt_guard.h"

namespace devhost {

std::uint64_t hostNowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

struct AudioHost::Impl {
  ma_context ctx{};
  bool ctxOk = false;
  ma_device dev{};
  bool devOk = false;
  std::string devId, devName;
};

namespace {

void jsonEscape(std::string &o, const char *s) {
  o += '"';
  for (; *s; ++s) {
    const unsigned char c = static_cast<unsigned char>(*s);
    if (c == '"' || c == '\\') {
      o += '\\';
      o += static_cast<char>(c);
    } else if (c < 0x20) {
      char b[8];
      std::snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else {
      o += static_cast<char>(c);
    }
  }
  o += '"';
}

/** Stable string id of a device: the backend's own name/UID where it has one, else "<backend>:<index>". */
std::string idOf(ma_backend b, const ma_device_id &id, std::size_t index) {
  switch (b) {
    case ma_backend_alsa:
      return id.alsa;
    case ma_backend_pulseaudio:
      return id.pulse;
    case ma_backend_coreaudio:
      return id.coreaudio;
    default:
      return std::string(ma_get_backend_name(b)) + ":" + std::to_string(index);
  }
}

bool backendFor(const std::string &name, ma_backend *out) {
  struct B {
    const char *n;
    ma_backend b;
  };
  static const B kB[] = {{"null", ma_backend_null},       {"alsa", ma_backend_alsa},
                         {"pulse", ma_backend_pulseaudio}, {"pulseaudio", ma_backend_pulseaudio},
                         {"jack", ma_backend_jack},       {"coreaudio", ma_backend_coreaudio}};
  for (const auto &x : kB) {
    if (name == x.n) {
      *out = x.b;
      return true;
    }
  }
  return false;
}

void onData(ma_device *d, void *out, const void *, ma_uint32 frames) {
  static_cast<AudioHost *>(d->pUserData)->renderInterleaved(static_cast<float *>(out), frames);
}

void onNotify(const ma_device_notification *n) {
  static_cast<AudioHost *>(n->pDevice->pUserData)->notify(static_cast<int>(n->type));
}

}  // namespace

AudioHost::AudioHost(AudioOptions o) : o_(std::move(o)), impl_(std::make_unique<Impl>()) {
  vt_.struct_size = sizeof(rig_host);
  vt_.user = this;
  vt_.audio_start = [](void *u, const char *id, double lat, std::uint32_t ch) {
    static_cast<AudioHost *>(u)->start(id, lat, ch);
  };
  vt_.audio_start_frames = [](void *u, const char *id, double lat, std::uint32_t ch, std::uint32_t frames) {
    static_cast<AudioHost *>(u)->start(id, lat, ch, frames);  // T00c D2: the bridge's bufferFrames
  };
  vt_.audio_stop = [](void *u) { static_cast<AudioHost *>(u)->stop(); };
  vt_.audio_list_devices = [](void *u, char *buf, std::size_t cap) -> std::size_t {
    const std::string j = static_cast<AudioHost *>(u)->devicesJson();
    if (cap) {
      const std::size_t n = std::min(cap - 1, j.size());
      std::memcpy(buf, j.data(), n);
      buf[n] = '\0';
    }
    return j.size();
  };
  vt_.host_time_ns = [](void *) { return hostNowNs(); };
  // midi_listen / midi_send / decode_file stay NULL: the dev host has no MIDI ports and no AAC decoder, so those
  // ops answer `unsupported` and M4A files fail with a `decode` warning (rig_engine.h).
}

AudioHost::~AudioHost() {
  shutdown();
  if (impl_->ctxOk) ma_context_uninit(&impl_->ctx);
}

bool AudioHost::init(std::string *err) {
  ma_context_config cc = ma_context_config_init();
  cc.threadPriority = ma_thread_priority_realtime;
  ma_result r;
  if (o_.backend == "auto") {
    r = ma_context_init(nullptr, 0, &cc, &impl_->ctx);
  } else {
    ma_backend b;
    if (!backendFor(o_.backend, &b)) {
      if (err) *err = "unknown audio backend '" + o_.backend + "' (auto|null|alsa|pulse|jack|coreaudio)";
      return false;
    }
    r = ma_context_init(&b, 1, &cc, &impl_->ctx);
  }
  if (r != MA_SUCCESS) {
    if (err) *err = std::string("miniaudio context: ") + ma_result_description(r);
    return false;
  }
  impl_->ctxOk = true;
  return true;
}

std::string AudioHost::backendName() const {
  return impl_->ctxOk ? ma_get_backend_name(impl_->ctx.backend) : "none";
}

std::string AudioHost::devicesJson() {
  std::string o = "[";
  if (!impl_->ctxOk) return "[]";
  ma_device_info *play = nullptr;
  ma_uint32 nPlay = 0;
  if (ma_context_get_devices(&impl_->ctx, &play, &nPlay, nullptr, nullptr) != MA_SUCCESS) return "[]";
  for (ma_uint32 i = 0; i < nPlay; ++i) {
    ma_device_info info = play[i];
    ma_context_get_device_info(&impl_->ctx, ma_device_type_playback, &play[i].id, &info);
    std::uint32_t ch = 0;
    std::vector<std::uint32_t> rates;
    for (ma_uint32 k = 0; k < info.nativeDataFormatCount; ++k) {
      ch = std::max(ch, info.nativeDataFormats[k].channels);
      const std::uint32_t sr = info.nativeDataFormats[k].sampleRate;
      if (sr && std::find(rates.begin(), rates.end(), sr) == rates.end()) rates.push_back(sr);
    }
    std::sort(rates.begin(), rates.end());
    if (i) o += ',';
    o += "{\"id\":";
    jsonEscape(o, idOf(impl_->ctx.backend, play[i].id, i).c_str());
    o += ",\"name\":";
    jsonEscape(o, play[i].name);
    o += ",\"channels\":" + std::to_string(ch ? ch : 2);
    o += std::string(",\"default\":") + (play[i].isDefault ? "true" : "false") + ",\"sampleRates\":[";
    for (std::size_t k = 0; k < rates.size(); ++k) o += (k ? "," : "") + std::to_string(rates[k]);
    o += "]}";
  }
  return o + "]";
}

void AudioHost::prepareBuffers(std::uint32_t channels) {
  channels_ = std::clamp<std::uint32_t>(channels, 1, RIG_MAX_OUTPUT_CHANNELS);
  planar_.assign(static_cast<std::size_t>(o_.maxBlockFrames) * channels_, 0.0f);
  for (std::uint32_t c = 0; c < RIG_MAX_OUTPUT_CHANNELS; ++c) {
    planes_[c] = c < channels_ ? planar_.data() + static_cast<std::size_t>(c) * o_.maxBlockFrames : nullptr;
  }
}

void AudioHost::renderInterleaved(float *out, std::uint32_t frames) {
  rig::rt::RenderScope scope;  // marks this thread as the audio thread for the allocation trap (and FTZ/DAZ)
  const std::uint64_t t0 = hostNowNs();
  std::uint64_t inRender = 0;
  rig_engine *e = engine_.load(std::memory_order_acquire);
  const std::uint32_t ch = channels_;
  // host time at which this callback's first frame is heard; piece k starts `done` frames later (rig_render's
  // host_time_ns is per call, and a callback longer than maxBlockFrames is rendered in several calls)
  const std::uint64_t ht0 = t0 + latencyNs_.load(std::memory_order_relaxed);
  const double nsPerFrame = sr_ > 0 ? 1e9 / sr_ : 0.0;  // sr_ is written by start() before the device runs
  std::uint32_t done = 0;
  while (done < frames) {
    const std::uint32_t n = std::min(frames - done, o_.maxBlockFrames);
    float *dst = out + static_cast<std::size_t>(done) * ch;
    if (!e || stopping_.load(std::memory_order_relaxed)) {
      std::memset(dst, 0, sizeof(float) * n * ch);
    } else {
      const std::uint64_t ht = ht0 + static_cast<std::uint64_t>(static_cast<double>(done) * nsPerFrame);
      const std::uint64_t r0 = hostNowNs();
      rig_render(e, planes_, ch, n, ht);
      inRender += hostNowNs() - r0;
      for (std::uint32_t f = 0; f < n; ++f) {
        for (std::uint32_t c = 0; c < ch; ++c) dst[static_cast<std::size_t>(f) * ch + c] = planes_[c][f];
      }
    }
    done += n;
  }
  const std::uint64_t dt = hostNowNs() - t0;
  callbacks_.fetch_add(1, std::memory_order_relaxed);
  frames_.fetch_add(frames, std::memory_order_relaxed);
  totalNs_.fetch_add(dt, std::memory_order_relaxed);
  renderNs_.fetch_add(inRender, std::memory_order_relaxed);
  if (dt > maxNs_.load(std::memory_order_relaxed)) maxNs_.store(dt, std::memory_order_relaxed);
}

void AudioHost::start(const char *deviceId, double latencySec, std::uint32_t channels, std::uint32_t bufferFrames) {
  std::lock_guard<std::mutex> lk(devMu_);
  rig_engine *e = engine_.load(std::memory_order_acquire);
  auto failed = [&](const std::string &msg) {
    std::fprintf(stderr, "devhost: audio start failed: %s\n", msg.c_str());
    if (e) rig_host_audio_state(e, RIG_DEVICE_CLOSED, msg.c_str());
  };
  if (!impl_->ctxOk) return failed("no audio context");
  if (impl_->devOk) {  // a start without a stop (restart path): close the old stream first
    stopping_ = true;
    ma_device_uninit(&impl_->dev);
    impl_->devOk = false;
    running_ = false;
  }
  // find the requested device ("" / NULL = system default)
  ma_device_info *play = nullptr;
  ma_uint32 nPlay = 0;
  ma_device_id chosen{};
  bool haveId = false;
  std::string id = deviceId ? deviceId : "";
  if (!id.empty() && ma_context_get_devices(&impl_->ctx, &play, &nPlay, nullptr, nullptr) == MA_SUCCESS) {
    for (ma_uint32 i = 0; i < nPlay; ++i) {
      if (idOf(impl_->ctx.backend, play[i].id, i) == id) {
        chosen = play[i].id;
        haveId = true;
      }
    }
    if (!haveId) return failed("no output device '" + id + "'");
  }
  // 4 channels (aux click, contract 3.10) only when the device has them; else 2 and the host reports 2
  std::uint32_t ch = channels >= 4 ? 4u : 2u;
  if (ch == 4) {
    ma_device_info info{};
    if (ma_context_get_device_info(&impl_->ctx, ma_device_type_playback, haveId ? &chosen : nullptr, &info) ==
        MA_SUCCESS) {
      std::uint32_t maxCh = 0;
      bool any = false;
      for (ma_uint32 k = 0; k < info.nativeDataFormatCount; ++k) {
        maxCh = std::max(maxCh, info.nativeDataFormats[k].channels);
        any = any || info.nativeDataFormats[k].channels == 0;  // 0 = "any count" (null backend)
      }
      if (!any && maxCh < 4) ch = 2;
    }
  }
  ma_device_config dc = ma_device_config_init(ma_device_type_playback);
  dc.playback.format = ma_format_f32;
  dc.playback.channels = ch;
  dc.playback.pDeviceID = haveId ? &chosen : nullptr;
  dc.sampleRate = o_.sampleRate;
  const double guessSr = o_.sampleRate ? o_.sampleRate : 48000.0;
  // T00c D2: --buffer N wins, then the `audio {bufferFrames}` request, then a numeric latency, then --period
  const auto period = o_.bufferFrames ? o_.bufferFrames
                      : bufferFrames  ? bufferFrames
                      : latencySec > 0 ? static_cast<std::uint32_t>(std::lround(latencySec * guessSr / o_.periods))
                                       : o_.periodFrames;
  dc.periodSizeInFrames = std::clamp<std::uint32_t>(period, 32, o_.maxBlockFrames);
  dc.periods = o_.periods;
  dc.performanceProfile = ma_performance_profile_low_latency;
  dc.noPreSilencedOutputBuffer = MA_TRUE;  // every frame is written by renderInterleaved
  dc.dataCallback = onData;
  dc.notificationCallback = onNotify;
  dc.pUserData = this;
  prepareBuffers(ch);  // before the device exists: the callback never allocates
  stopping_ = false;
  const ma_result r = ma_device_init(&impl_->ctx, &dc, &impl_->dev);
  if (r != MA_SUCCESS) return failed(std::string("device open: ") + ma_result_description(r));
  impl_->devOk = true;
  sr_ = impl_->dev.sampleRate;
  period_ = impl_->dev.playback.internalPeriodSizeInFrames;
  const double internalSr = impl_->dev.playback.internalSampleRate ? impl_->dev.playback.internalSampleRate : sr_;
  const double latency = static_cast<double>(period_) * impl_->dev.playback.internalPeriods / internalSr;
  latencyNs_ = static_cast<std::uint64_t>(latency * 1e9);
  impl_->devId = haveId ? id : std::string("default");
  impl_->devName = impl_->dev.playback.name;
  rig_device_info info{};
  info.struct_size = sizeof info;
  info.device_id = impl_->devId.c_str();
  info.device_name = impl_->devName.c_str();
  info.sample_rate = sr_;
  info.channels = impl_->dev.playback.channels;
  info.buffer_frames = period_;
  info.output_latency_sec = latency;
  if (e) rig_host_audio_started(e, &info);  // before the first callback: the core adopts the rate (contract 6.3)
  const ma_result s = ma_device_start(&impl_->dev);
  if (s != MA_SUCCESS) {
    ma_device_uninit(&impl_->dev);
    impl_->devOk = false;
    return failed(std::string("device start: ") + ma_result_description(s));
  }
  running_ = true;
  std::fprintf(stderr, "devhost: audio running: %s '%s' %.0f Hz, %u ch, period %u x %u (%.1f ms)\n",
               backendName().c_str(), impl_->devName.c_str(), sr_, info.channels, period_,
               impl_->dev.playback.internalPeriods, latency * 1000.0);
}

void AudioHost::stop() {
  std::lock_guard<std::mutex> lk(devMu_);
  if (!impl_->devOk) return;
  stopping_ = true;
  ma_device_uninit(&impl_->dev);  // stops first; returns after the last callback
  impl_->devOk = false;
  running_ = false;
  if (rig_engine *e = engine_.load(std::memory_order_acquire)) rig_host_audio_state(e, RIG_DEVICE_SUSPENDED, nullptr);
}

void AudioHost::shutdown() {
  std::lock_guard<std::mutex> lk(devMu_);
  if (!impl_->devOk) return;
  stopping_ = true;
  ma_device_uninit(&impl_->dev);
  impl_->devOk = false;
  running_ = false;
}

AudioStats AudioHost::stats() const {
  AudioStats s;
  s.callbacks = callbacks_.load();
  s.frames = frames_.load();
  s.totalNs = totalNs_.load();
  s.renderNs = renderNs_.load();
  s.maxNs = maxNs_.load();
  std::lock_guard<std::mutex> lk(devMu_);  // written by start() on the host thread
  s.sampleRate = sr_;
  s.channels = channels_;
  s.periodFrames = period_;
  s.running = running_.load();
  return s;
}

void AudioHost::notify(int type) {
  // miniaudio's thread; only [any] rig calls here, never ma_device_* (miniaudio forbids it inside callbacks)
  rig_engine *e = engine_.load(std::memory_order_acquire);
  if (!e) return;
  if (type == ma_device_notification_type_stopped && !stopping_.load()) {
    running_ = false;  // a stop nobody asked for: the device vanished (unplugged, server gone)
    rig_host_audio_state(e, RIG_DEVICE_INTERRUPTED, "audio device stopped");
  } else if (type == ma_device_notification_type_rerouted) {
    rig_host_devices_changed(e);
  }
}

}  // namespace devhost
