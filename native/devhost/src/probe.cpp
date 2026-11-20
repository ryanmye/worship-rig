// rig-probe (see probe.h).
#include "probe.h"

#include <algorithm>
#include <cstdarg>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>

#include "audio_host.h"
#include "inst/voice_alloc.h"  // the provisional kAutoVoiceLimit* the suggestion is compared with
#include "rig/rig_engine.h"

namespace devhost {

namespace {

using Clock = std::chrono::steady_clock;

void sleepSec(double s) {
  if (s > 0) std::this_thread::sleep_for(std::chrono::duration<double>(s));
}

#if defined(__GNUC__)
__attribute__((format(printf, 2, 3)))
#endif
void say(bool verbose, const char *fmt, ...) {
  if (!verbose) return;
  std::fputs("rig-probe: ", stderr);
  va_list ap;
  va_start(ap, fmt);
  std::vfprintf(stderr, fmt, ap);
  va_end(ap);
  std::fputc('\n', stderr);
}

// ---- a tiny JSON writer: numbers that are not finite become null ---------------------------------------------------

std::string num(double v, int digits = 2) {
  if (!std::isfinite(v)) return "null";
  char b[64];
  std::snprintf(b, sizeof b, "%.*f", digits, v);
  return b;
}

std::string str(const std::string &s) {
  std::string o = "\"";
  for (const char ch : s) {
    const auto c = static_cast<unsigned char>(ch);
    if (c == '"' || c == '\\') {
      o += '\\';
      o += ch;
    } else if (c < 0x20) {
      char b[8];
      std::snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else {
      o += ch;
    }
  }
  return o + "\"";
}

/** Order statistic on a copy (nearest rank). */
double percentile(std::vector<double> v, double p) {
  if (v.empty()) return std::nan("");
  std::sort(v.begin(), v.end());
  const auto rank = static_cast<std::size_t>(std::ceil(p * static_cast<double>(v.size())));
  return v[std::min(v.size() - 1, rank ? rank - 1 : 0)];
}

// ---- the engine, driven like the shell drives it (BRIDGE v1 JSON), replies matched by id --------------------------

class ProbeEngine {
 public:
  ProbeEngine(const ProbeOptions &o, AudioHost &host) : o_(o), host_(host) {
    appDir_ = o.repoDir + "/app";
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.max_block_frames = 4096;
    cfg.seed = 1;
    cfg.app_dir = appDir_.c_str();
    cfg.on_event = &ProbeEngine::onEvent;
    cfg.event_user = this;
    cfg.on_log = &ProbeEngine::onLog;
    cfg.log_user = this;
    cfg.host = host.vtable();
    rig_status st = RIG_OK;
    e_ = rig_create(&cfg, &st);
    if (e_) host.attach(e_);
    else createError_ = rig_status_string(st);
  }
  ~ProbeEngine() {
    host_.shutdown();  // rig_destroy needs rig_render to have stopped
    host_.attach(nullptr);
    if (e_) rig_destroy(e_);
  }
  ProbeEngine(const ProbeEngine &) = delete;
  ProbeEngine &operator=(const ProbeEngine &) = delete;

  bool ok() const { return e_ != nullptr; }
  const std::string &createError() const { return createError_; }
  rig_engine *engine() const { return e_; }

  /** Posts {"v":1,"id":N,<fields>} and waits for the reply ("re":N). Empty string on timeout. */
  std::string call(const std::string &fields, double timeoutSec = 10.0) {
    const long id = ++nextId_;
    const std::string m = "{\"v\":1,\"id\":" + std::to_string(id) + "," + fields + "}";
    if (rig_post(e_, m.data(), m.size()) != RIG_OK) return {};
    const std::string needle = "\"re\":" + std::to_string(id);
    const auto end = Clock::now() + std::chrono::duration<double>(timeoutSec);
    std::size_t from = 0;  // events before this index were already searched for this id
    while (Clock::now() < end) {
      {
        std::lock_guard<std::mutex> lk(mu_);
        if (from > events_.size()) from = 0;  // trimmed meanwhile
        for (; from < events_.size(); ++from) {
          const std::string &ev = events_[from];
          for (std::size_t at = ev.find(needle); at != std::string::npos; at = ev.find(needle, at + 1)) {
            const std::size_t after = at + needle.size();
            if (after >= ev.size() || ev[after] < '0' || ev[after] > '9') return ev;  // "re":12 is not "re":1
          }
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return {};
  }
  /** Index of the next event (for waitEvent). */
  std::size_t mark() {
    std::lock_guard<std::mutex> lk(mu_);
    return events_.size();
  }
  /** Waits for an event at or after `from` that contains `needle`. */
  bool waitEvent(const char *needle, std::size_t from, double timeoutSec) {
    const auto end = Clock::now() + std::chrono::duration<double>(timeoutSec);
    while (Clock::now() < end) {
      {
        std::lock_guard<std::mutex> lk(mu_);
        if (from > events_.size()) from = 0;
        for (; from < events_.size(); ++from) {
          if (events_[from].find(needle) != std::string::npos) return true;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return false;
  }
  /** Fire and forget (notes). */
  void post(const std::string &m) { rig_post(e_, m.data(), m.size()); }

  rig_meters meters() const {
    rig_meters m{};
    m.struct_size = sizeof m;
    rig_get_meters(e_, &m);
    return m;
  }
  std::vector<std::string> warnings() {
    std::lock_guard<std::mutex> lk(mu_);
    return warnings_;
  }

 private:
  static void onEvent(void *u, const char *json, std::size_t n) {
    auto *self = static_cast<ProbeEngine *>(u);
    std::lock_guard<std::mutex> lk(self->mu_);
    self->events_.emplace_back(json, n);
    if (self->events_.size() > 20000) {  // ticks at 4 Hz without meters: a bound, never reached in 3 minutes
      self->events_.erase(self->events_.begin(), self->events_.begin() + 10000);
    }
    const std::string &ev = self->events_.back();
    if (ev.find("\"ev\":\"warn\"") != std::string::npos && self->warnings_.size() < 32) {
      self->warnings_.push_back(ev.substr(0, 400));
    }
  }
  static void onLog(void *u, int level, const char *msg) {
    auto *self = static_cast<ProbeEngine *>(u);
    if (level >= 2 && self->o_.verbose) std::fprintf(stderr, "rig-probe: core[%d]: %s\n", level, msg);
  }

  const ProbeOptions &o_;
  AudioHost &host_;
  rig_engine *e_ = nullptr;
  std::string appDir_, createError_;
  std::mutex mu_;
  std::vector<std::string> events_, warnings_;
  long nextId_ = 100;
};

bool contains(const std::string &s, const char *needle) { return s.find(needle) != std::string::npos; }

/** The `"token":N` of a prepare reply, -1 if absent. */
long tokenOf(const std::string &reply) {
  const std::size_t at = reply.find("\"token\":");
  return at == std::string::npos ? -1 : std::strtol(reply.c_str() + at + 8, nullptr, 10);
}

std::string instrumentJson(const std::string &kind, const std::string &id) {
  return "{\"type\":" + str(kind) + ",\"id\":" + str(id) + "}";
}

/**
 * cache preload + prepare + commit; "" on success, else what went wrong. The preload comes first because a
 * realtime engine integrates decodes started by `prepare` only on a cache pump() that its control loop does not run
 * yet (found by this probe, 2026-11-20: api/engine.cpp controlLoop never pumps the cache service, so a sampler
 * prepared cold stays silent in realtime). `cache preload` pumps until its decodes are done, and the prepare after it
 * finds every buffer decoded. The app's controller preloads songs the same way, so this is also the real path.
 */
std::string loadSong(ProbeEngine &pe, const std::string &slots, double timeoutSec) {
  const std::string pr = pe.call("\"op\":\"cache\",\"action\":\"preload\",\"pin\":\"add\",\"patches\":[{\"slots\":[" +
                                 slots + "]}]", timeoutSec);
  if (pr.empty() || !contains(pr, "\"ok\":true")) {
    return "cache preload: " + (pr.empty() ? "no reply within " + num(timeoutSec, 0) + " s" : pr.substr(0, 300));
  }
  const std::string r = pe.call("\"op\":\"prepare\",\"patch\":{\"slots\":[" + slots + "]}", timeoutSec);
  if (r.empty()) return "prepare: no reply within " + num(timeoutSec, 0) + " s";
  const long token = tokenOf(r);
  if (token < 0) return "prepare: " + r.substr(0, 300);
  const std::string c = pe.call("\"op\":\"commit\",\"token\":" + std::to_string(token));
  if (!contains(c, "\"committed\":true")) return "commit: " + (c.empty() ? std::string("no reply") : c.substr(0, 300));
  return {};
}

/** One batch of note-ons (each sounds in every slot of the song). */
void notesOn(ProbeEngine &pe, const std::vector<int> &notes, int vel = 100) {
  if (notes.empty()) return;
  std::string b = "[";
  for (std::size_t i = 0; i < notes.size(); ++i) {
    b += (i ? "," : "") + std::string("{\"v\":1,\"op\":\"play\",\"e\":\"on\",\"vel\":") + std::to_string(vel) +
         ",\"n\":" + std::to_string(notes[i]) + "}";
  }
  pe.post(b + "]");
}

/** Held-note indexes [from, to) as MIDI notes: 36..127 first, then 0..35 (128 distinct notes per slot at most). */
std::vector<int> noteRange(int from, int to) {
  std::vector<int> v;
  for (int j = from; j < to && j < 128; ++j) v.push_back(j < 92 ? 36 + j : j - 92);
  return v;
}

void panic(ProbeEngine &pe) { pe.post(R"({"v":1,"op":"play","e":"panic"})"); }

/** One timing window over the live device. */
struct Window {
  std::size_t callbacks = 0;
  double seconds = 0;
  std::uint32_t minFrames = 0, maxFrames = 0;
  std::size_t late = 0;              // start-to-start gap > 1.5 x the callback's own duration
  double p50 = 0, p99 = 0, max = 0, mean = 0;  // us per callback
  double q50 = 0, q99 = 0, qmax = 0, qmean = 0;  // the same, scaled to one 128-frame quantum
  std::uint32_t xruns = 0;           // the core's own counter (rig_meters.xruns) over the window
  std::uint32_t voicesStart = 0, voicesEnd = 0;
  std::uint32_t halBufferFrames = 0;  // Core Audio's kAudioDevicePropertyBufferFrameSize during the window
};

Window measure(ProbeEngine &pe, AudioHost &host, double seconds, double sampleRate) {
  Window w;
  const std::size_t cap = static_cast<std::size_t>(seconds * (sampleRate > 0 ? sampleRate : 48000.0) / 16.0) + 4096;
  auto log = std::make_unique<CallbackLog>(cap);
  const rig_meters m0 = pe.meters();
  w.voicesStart = m0.voices;
  const auto t0 = Clock::now();
  host.setCallbackLog(log.get());
  sleepSec(seconds);
  host.setCallbackLog(nullptr);
  w.seconds = std::chrono::duration<double>(Clock::now() - t0).count();
  const rig_meters m1 = pe.meters();
  w.voicesEnd = m1.voices;
  w.xruns = m1.xruns - m0.xruns;
  if (const AppleOutputLatency a = appleDefaultOutputLatency(); a.ok) w.halBufferFrames = a.bufferFrameSize;
  sleepSec(0.05);  // a callback that loaded the log pointer before the detach has finished by now
  const std::size_t n = log->count.load(std::memory_order_acquire);
  w.callbacks = n;
  if (!n) return w;
  std::vector<double> us(n), perQ(n);
  w.minFrames = UINT32_MAX;
  double sum = 0, sumQ = 0;
  for (std::size_t i = 0; i < n; ++i) {
    const std::uint32_t f = log->frames[i];
    w.minFrames = std::min(w.minFrames, f);
    w.maxFrames = std::max(w.maxFrames, f);
    us[i] = static_cast<double>(log->busyNs[i]) / 1e3;
    perQ[i] = f ? us[i] * RIG_QUANTUM_FRAMES / f : us[i];
    sum += us[i];
    sumQ += perQ[i];
    const double durNs = sampleRate > 0 ? 1e9 * f / sampleRate : 0;
    if (i > 0 && durNs > 0 && static_cast<double>(log->gapNs[i]) > 1.5 * durNs) ++w.late;
  }
  w.p50 = percentile(us, 0.50);
  w.p99 = percentile(us, 0.99);
  w.max = *std::max_element(us.begin(), us.end());
  w.mean = sum / static_cast<double>(n);
  w.q50 = percentile(perQ, 0.50);
  w.q99 = percentile(perQ, 0.99);
  w.qmax = *std::max_element(perQ.begin(), perQ.end());
  w.qmean = sumQ / static_cast<double>(n);
  return w;
}

std::string timesJson(double p50, double p99, double mx, double mean) {
  return "{\"p50\":" + num(p50) + ",\"p99\":" + num(p99) + ",\"max\":" + num(mx) + ",\"mean\":" + num(mean) + "}";
}

/** Least squares y = a + b x. */
void fit(const std::vector<double> &x, const std::vector<double> &y, double *a, double *b) {
  const auto n = static_cast<double>(x.size());
  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (std::size_t i = 0; i < x.size(); ++i) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const double d = n * sxx - sx * sx;
  if (x.size() < 2 || d == 0) {
    *a = x.empty() ? std::nan("") : sy / n;
    *b = std::nan("");
    return;
  }
  *b = (n * sxy - sx * sy) / d;
  *a = (sy - *b * sx) / n;
}

struct SweepResult {
  double perVoice = std::nan(""), fixedP99 = std::nan(""), fixedMean = std::nan("");
};

/** ARCHITECTURE 7.1 rounding: down to a multiple of 16 (a whole note across 16 slots), at least 16. */
double floor16(double v) {
  if (!std::isfinite(v)) return v;
  return std::max(16.0, std::floor(v / 16.0) * 16.0);
}

}  // namespace

bool runProbe(const ProbeOptions &o, std::string *json, std::string *err) {
  const auto tStart = Clock::now();
  const bool v = o.verbose;
  std::vector<std::string> errors;

  AudioOptions ao;
  ao.backend = o.backend;
  ao.muted = true;  // nothing audible, ever
  ao.periodFrames = o.buffers.empty() ? 128 : o.buffers.front();
  AudioHost host(ao);
  if (!host.init(err)) return false;
  ProbeEngine pe(o, host);
  if (!pe.ok()) {
    if (err) *err = "rig_create: " + pe.createError();
    return false;
  }
  say(v, "backend %s, core %s, output muted", host.backendName().c_str(), rig_version_string());

  // ---- open the device --------------------------------------------------------------------------------------------
  if (pe.call(R"("op":"hello","protocol":1)").empty()) {
    if (err) *err = "hello: no reply";
    return false;
  }
  // `audio start|restart` replies at once; the device opens on the core's host thread and `state running` follows
  auto openDevice = [&](const char *action, std::uint32_t frames, std::string *why) -> bool {
    const std::size_t at = pe.mark();
    const std::string r = pe.call("\"op\":\"audio\",\"action\":\"" + std::string(action) +
                                  "\",\"bufferFrames\":" + std::to_string(frames), 20.0);
    if (r.empty() || !contains(r, "\"ok\":true")) {
      *why = std::string("audio ") + action + " " + std::to_string(frames) + ": " +
             (r.empty() ? std::string("no reply") : r.substr(0, 300));
      return false;
    }
    if (!pe.waitEvent("\"state\":\"running\"", at, 20.0) || !host.stats().running) {
      *why = std::string("audio ") + action + " " + std::to_string(frames) + ": the device did not start";
      return false;
    }
    return true;
  };
  const std::uint32_t first = o.buffers.empty() ? o.sweepBuffer : o.buffers.front();
  if (std::string why; !openDevice("start", first, &why)) {
    if (err) *err = why;
    return false;
  }
  sleepSec(o.settleSeconds);
  const AppleOutputLatency hal0 = appleDefaultOutputLatency();

  auto restart = [&](std::uint32_t frames) -> bool {
    std::string why;
    if (openDevice("restart", frames, &why)) {
      sleepSec(o.settleSeconds);
      return true;
    }
    errors.push_back(why);
    return false;
  };

  // ---- 1. buffer sizes, a typical 4-slot song holding a chord -----------------------------------------------------
  std::string buffersJson = "[";
  bool typicalLoaded = false;
  {
    std::string slots = "{\"instrument\":" + instrumentJson("sampler", o.samplerId) + ",\"gain\":0.5}," +
                        "{\"instrument\":" + instrumentJson("synth", o.synthId) + ",\"gain\":0.3}," +
                        "{\"instrument\":" + instrumentJson("synth", "strings") + ",\"gain\":0.3}," +
                        "{\"instrument\":" + instrumentJson("synth", "sub-bass") + ",\"gain\":0.3}";
    if (!o.buffers.empty()) {
      const std::string e = loadSong(pe, slots, o.prepareTimeoutSeconds);
      if (!e.empty()) errors.push_back("typical song: " + e);
      typicalLoaded = e.empty();
    }
  }
  bool d2Measured = false, d2Safe = false;
  std::string d2Reason = "64 frames not measured";
  for (std::size_t bi = 0; bi < o.buffers.size(); ++bi) {
    const std::uint32_t b = o.buffers[bi];
    if (bi > 0 && !restart(b)) continue;
    panic(pe);
    sleepSec(0.05);
    if (typicalLoaded) notesOn(pe, {48, 52, 55, 60});  // C major, 4 slots: about 16 voices
    sleepSec(o.settleSeconds);
    const AudioStats st = host.stats();
    const Window w = measure(pe, host, o.bufferSeconds, st.sampleRate);
    const double periodUs = st.sampleRate > 0 ? 1e6 * st.periodFrames / st.sampleRate : std::nan("");
    const double expected = st.periodFrames ? w.seconds * st.sampleRate / st.periodFrames : 0;
    const bool clean = w.callbacks > 0 && w.late == 0 && w.xruns == 0 && w.max < periodUs;
    say(v,
        "buffer %u: granted %u x %u @ %.0f Hz (%.2f ms latency), %zu callbacks (%.0f expected), p50 %.0f / p99 %.0f / "
        "max %.0f us of %.0f us, late %zu, core xruns %u",
        b, st.periodFrames, st.periods, st.sampleRate, st.latencySec * 1e3, w.callbacks, expected, w.p50, w.p99, w.max,
        periodUs, w.late, w.xruns);
    if (bi) buffersJson += ",";
    buffersJson += "{\"requested\":" + std::to_string(b) + ",\"granted\":" + std::to_string(st.periodFrames) +
                   ",\"periods\":" + std::to_string(st.periods) + ",\"sample_rate\":" + num(st.sampleRate, 0) +
                   ",\"device_rate\":" + std::to_string(st.internalSampleRate) +
                   ",\"hal_buffer_frames\":" + std::to_string(w.halBufferFrames) +
                   ",\"callback_frames\":{\"min\":" + std::to_string(w.callbacks ? w.minFrames : 0) +
                   ",\"max\":" + std::to_string(w.maxFrames) + "},\"seconds\":" + num(w.seconds, 3) +
                   ",\"callbacks\":" + std::to_string(w.callbacks) + ",\"callbacks_expected\":" + num(expected, 0) +
                   ",\"late_callbacks\":" + std::to_string(w.late) + ",\"core_xruns\":" + std::to_string(w.xruns) +
                   ",\"voices\":" + std::to_string(w.voicesEnd) + ",\"period_us\":" + num(periodUs) +
                   ",\"render_us\":" + timesJson(w.p50, w.p99, w.max, w.mean) +
                   ",\"p99_pct_of_period\":" + num(100.0 * w.p99 / periodUs, 1) +
                   ",\"max_pct_of_period\":" + num(100.0 * w.max / periodUs, 1) +
                   ",\"latency_ms\":" + num(st.latencySec * 1e3, 3) + ",\"clean\":" + (clean ? "true" : "false") + "}";
    if (b == 64) {
      d2Measured = true;
      d2Safe = clean && w.p99 < o.targetFraction * periodUs && st.periodFrames == 64;
      char why[256];
      std::snprintf(why, sizeof why,
                    "granted %u frames; late %zu, core xruns %u, p99 %.0f us and max %.0f us of a %.0f us period "
                    "(safe = granted 64, no late callback or xrun, max < period, p99 < %.0f %%)",
                    st.periodFrames, w.late, w.xruns, w.p99, w.max, periodUs, 100 * o.targetFraction);
      d2Reason = why;
    }
  }
  buffersJson += "]";

  // ---- 2. load sweep at 128 frames ---------------------------------------------------------------------------------
  std::string kindsJson = "{";
  double quantumUs = std::nan("");
  struct Costliest {
    std::string kind, id;
    double perVoice = -1, fixedP99 = 0, fixedMean = 0;
  } worst;
  if (!o.kinds.empty() && restart(o.sweepBuffer)) {
    for (std::size_t ki = 0; ki < o.kinds.size(); ++ki) {
      const std::string &kind = o.kinds[ki];
      const std::string id = kind == "sampler" ? o.samplerId : o.synthId;
      panic(pe);
      std::string slots;
      for (int i = 0; i < 16; ++i) {
        slots += (i ? "," : "") + ("{\"instrument\":" + instrumentJson(kind, id) + ",\"gain\":0.2}");
      }
      std::string e = loadSong(pe, slots, o.prepareTimeoutSeconds);
      if (e.empty() && !contains(pe.call(R"("op":"config","polyphony":128,"voiceLimit":0)"), "\"ok\":true")) {
        e = "config polyphony 128 / voiceLimit 0 refused";
      }
      std::string kj = str(kind) + ":{\"instrument\":" + str(id);
      if (!e.empty()) {
        errors.push_back(kind + " sweep: " + e);
        kindsJson += (ki ? "," : "") + kj + ",\"error\":" + str(e) + "}";
        continue;
      }
      panic(pe);
      sleepSec(o.stepSettleSeconds);
      const AudioStats st = host.stats();
      quantumUs = st.sampleRate > 0 ? 1e6 * RIG_QUANTUM_FRAMES / st.sampleRate : std::nan("");
      std::vector<double> vx, ymean, yp99;
      std::string steps = "[";
      std::string stopped = "end of steps";
      double cross60 = std::nan(""), cross80 = std::nan("");
      double prevV = std::nan(""), prevP = std::nan("");
      std::uint32_t held = 0;
      for (std::size_t si = 0; si < o.notesPerSlot.size(); ++si) {
        const std::uint32_t k = std::min<std::uint32_t>(o.notesPerSlot[si], 128);
        if (k < held) continue;
        notesOn(pe, noteRange(static_cast<int>(held), static_cast<int>(k)));  // 16 voices per note
        held = k;
        sleepSec(o.stepSettleSeconds);
        const Window w = measure(pe, host, o.stepSeconds, st.sampleRate);
        const double voices = 0.5 * (w.voicesStart + w.voicesEnd);
        const double pct = 100.0 * w.q99 / quantumUs;
        say(v, "%s %s: %u notes x 16 slots, %.0f voices: per quantum p50 %.0f / p99 %.0f / max %.0f us (p99 %.0f %%), "
            "late %zu",
            kind.c_str(), id.c_str(), k, voices, w.q50, w.q99, w.qmax, pct, w.late);
        steps += std::string(si ? "," : "") + "{\"notes_per_slot\":" + std::to_string(k) +
                 ",\"voices\":" + num(voices, 1) + ",\"voices_start\":" + std::to_string(w.voicesStart) +
                 ",\"voices_end\":" + std::to_string(w.voicesEnd) + ",\"callbacks\":" + std::to_string(w.callbacks) +
                 ",\"late_callbacks\":" + std::to_string(w.late) + ",\"core_xruns\":" + std::to_string(w.xruns) +
                 ",\"quantum_us\":" + timesJson(w.q50, w.q99, w.qmax, w.qmean) + ",\"p99_pct\":" + num(pct, 1) + "}";
        if (w.callbacks) {
          vx.push_back(voices);
          ymean.push_back(w.qmean);
          yp99.push_back(w.q99);
          // measured crossings, interpolated between the last step under and the first step over
          auto cross = [&](double frac, double *out) {
            const double lim = frac * quantumUs;
            if (!std::isnan(*out) || w.q99 <= lim) return;
            const bool noPrev = std::isnan(prevV) || w.q99 == prevP;
            *out = noPrev ? voices : prevV + (lim - prevP) * (voices - prevV) / (w.q99 - prevP);
          };
          cross(o.targetFraction, &cross60);
          cross(0.80, &cross80);
          prevV = voices;
          prevP = w.q99;
        }
        if (w.q99 > o.stopFraction * quantumUs) {
          stopped = "p99 above " + num(100 * o.stopFraction, 0) + " % of the quantum";
          break;
        }
      }
      steps += "]";
      panic(pe);
      if (held > 0 && (vx.empty() || *std::max_element(vx.begin(), vx.end()) <= 0)) {
        errors.push_back(kind + " sweep: no voices sounded with " + std::to_string(held) +
                         " notes held in 16 slots of " + id + " (a silent instrument: the per-voice cost is meaningless)");
        vx.clear();
      }
      SweepResult r;
      double a = 0, b = 0;
      fit(vx, ymean, &a, &b);
      r.perVoice = b;
      r.fixedMean = a;
      // p99 line: the same slope, offset = the median of (p99 - slope x voices): robust to one noisy window
      std::vector<double> off;
      for (std::size_t i = 0; i < vx.size(); ++i) off.push_back(yp99[i] - b * vx[i]);
      r.fixedP99 = percentile(off, 0.5);
      double ap = 0, bp = 0;
      fit(vx, yp99, &ap, &bp);
      const bool usable = std::isfinite(b) && b > 0;
      const double max60 = usable ? (o.targetFraction * quantumUs - r.fixedP99) / b : std::nan("");
      const double max80 = usable ? (0.80 * quantumUs - r.fixedP99) / b : std::nan("");
      say(v, "%s %s: %.2f us per voice per quantum, fixed (16 slots) %.0f us mean / %.0f us p99 -> max voices %.0f at "
          "60 %%, %.0f at 80 %%",
          kind.c_str(), id.c_str(), b, a, r.fixedP99, max60, max80);
      kj += ",\"slots\":16,\"buffer\":" + std::to_string(st.periodFrames) + ",\"steps\":" + steps +
            ",\"stopped\":" + str(stopped) + ",\"per_voice_us\":" + num(b, 3) +
            ",\"per_voice_us_p99_fit\":" + num(bp, 3) + ",\"fixed16_us\":{\"mean\":" + num(a) +
            ",\"p99\":" + num(r.fixedP99) + "},\"max_voices_60\":" + num(max60, 0) +
            ",\"max_voices_80\":" + num(max80, 0) + ",\"measured_crossing_60\":" + num(cross60, 0) +
            ",\"measured_crossing_80\":" + num(cross80, 0) + "}";
      kindsJson += (ki ? "," : "") + kj;
      if (usable && b > worst.perVoice) worst = {kind, id, b, r.fixedP99, a};
    }
  }
  kindsJson += "}";

  // ---- 3. the D4 'auto' suggestion ----------------------------------------------------------------------------------
  std::string autoJson;
  if (worst.perVoice > 0 && std::isfinite(quantumUs)) {
    const double raw = (o.targetFraction * quantumUs - worst.fixedP99) / worst.perVoice;
    const double rawMean = (o.targetFraction * quantumUs - worst.fixedMean) / worst.perVoice;
    autoJson = "{\"desktop\":" + num(floor16(raw), 0) + ",\"raw\":" + num(raw, 1) +
               ",\"mean_based\":" + num(floor16(rawMean), 0) + ",\"basis\":" + str(worst.kind + " " + worst.id) +
               ",\"per_voice_us\":" + num(worst.perVoice, 3) + ",\"fixed16_us_p99\":" + num(worst.fixedP99) +
               ",\"quantum_us\":" + num(quantumUs) + ",\"target_fraction\":" + num(o.targetFraction) +
               ",\"formula\":\"floor16((target x quantum - fixed16_p99) / per_voice), costliest kind\"" +
               ",\"current_provisional\":{\"desktop\":" + std::to_string(rig::inst::kAutoVoiceLimitDesktop) +
               ",\"ipad\":" + std::to_string(rig::inst::kAutoVoiceLimitIpad) + "}" +
               ",\"applies_to\":\"this machine (desktop profile); the iPad still needs its own measurement\"}";
  } else {
    autoJson = "null";
    errors.push_back("auto_voice_limit_suggestion: no usable per-voice cost (sweep missing or flat)");
  }

  // ---- report -------------------------------------------------------------------------------------------------------
  std::string halJson = "null";
  if (hal0.ok) {
    halJson = "{\"name\":" + str(hal0.name) + ",\"transport\":" + str(hal0.transport) +
              ",\"nominal_rate\":" + num(hal0.nominalRate, 0) + ",\"buffer_frames\":" +
              std::to_string(hal0.bufferFrameSize) + ",\"device_latency_frames\":" +
              std::to_string(hal0.deviceLatency) + ",\"safety_offset_frames\":" + std::to_string(hal0.safetyOffset) +
              ",\"stream_latency_frames\":" + std::to_string(hal0.streamLatency) + "}";
  }
  std::string warnJson = "[";
  {
    const auto ws = pe.warnings();
    for (std::size_t i = 0; i < ws.size(); ++i) warnJson += (i ? "," : "") + str(ws[i]);
  }
  warnJson += "]";
  std::string errJson = "[";
  for (std::size_t i = 0; i < errors.size(); ++i) errJson += (i ? "," : "") + str(errors[i]);
  errJson += "]";
  const AudioStats fin = host.stats();
  const double total = std::chrono::duration<double>(Clock::now() - tStart).count();
  *json = "{\"tool\":\"rig-probe\",\"schema\":1,\"core\":" + str(rig_version_string()) +
          ",\"backend\":" + str(host.backendName()) + ",\"muted\":true,\"device\":{\"name\":" + str(fin.deviceName) +
          ",\"sample_rate\":" + num(fin.sampleRate, 0) + ",\"core_audio\":" + halJson + "},\"buffers\":" +
          buffersJson + ",\"d2_64_frames\":{\"measured\":" + (d2Measured ? "true" : "false") +
          ",\"safe\":" + (d2Measured ? (d2Safe ? "true" : "false") : "null") + ",\"reason\":" + str(d2Reason) +
          "},\"load_sweep\":{\"buffer\":" + std::to_string(o.sweepBuffer) + ",\"quantum_us\":" + num(quantumUs) +
          ",\"kinds\":" + kindsJson + "},\"auto_voice_limit_suggestion\":" + autoJson + ",\"warnings\":" + warnJson +
          ",\"errors\":" + errJson + ",\"seconds_total\":" + num(total, 1) + "}";
  say(v, "done in %.1f s (%zu errors)", total, errors.size());
  return true;
}

}  // namespace devhost
