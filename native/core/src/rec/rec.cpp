// M17 recorder (T08). See rec.h.
#include "rec/rec.h"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <cctype>
#include <ctime>
#include <filesystem>
#include <map>
#include <mutex>

#include "bridge/json_out.h"
#include "model/model.h"
#include "yyjson.h"

namespace rig {
namespace {

std::mutex g_mu;
std::map<const void *, RecShared *> g_shared;

void casMax(std::atomic<std::uint32_t> &bits, float v) {
  std::uint32_t cur = bits.load(std::memory_order_relaxed);
  while (v > std::bit_cast<float>(cur) &&
         !bits.compare_exchange_weak(cur, std::bit_cast<std::uint32_t>(v), std::memory_order_relaxed)) {
  }
}

void le(std::string &s, std::uint32_t v, int bytes) {
  for (int i = 0; i < bytes; ++i) s += static_cast<char>((v >> (8 * i)) & 0xffu);
}

std::string errorJson(const char *code, const std::string &msg) {
  JsonOut j;
  j.begin().key("error").begin().kv("code", code).kv("message", msg).end().end();
  return j.take();
}

/** `Rig YYYY-MM-DD HHmm.wav`, local time. */
std::string defaultName() {
  const std::time_t t = std::time(nullptr);
  std::tm tm{};
#if defined(_WIN32)
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  char b[64];
  std::strftime(b, sizeof b, "Rig %Y-%m-%d %H%M.wav", &tm);
  return b;
}

/** A user-typed name: no directories, no control characters, `.wav` appended when missing. */
std::string cleanName(std::string n) {
  std::string out;
  for (char c : n)
    if (c != '/' && c != '\\' && c != ':' && static_cast<unsigned char>(c) >= 0x20) out += c;
  while (!out.empty() && (out.front() == '.' || out.front() == ' ')) out.erase(out.begin());
  if (out.empty()) return defaultName();
  std::string low = out;
  std::transform(low.begin(), low.end(), low.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (low.size() < 4 || low.compare(low.size() - 4, 4, ".wav") != 0) out += ".wav";
  return out;
}

std::string uniquePath(const std::filesystem::path &dir, const std::string &name) {
  namespace fs = std::filesystem;
  fs::path p = dir / name;
  std::error_code ec;
  if (!fs::exists(p, ec)) return p.string();
  const std::string stem = p.stem().string(), ext = p.extension().string();
  for (int k = 2; k < 1000; ++k) {
    fs::path q = dir / (stem + " (" + std::to_string(k) + ")" + ext);
    if (!fs::exists(q, ec)) return q.string();
  }
  return p.string();
}

}  // namespace

// ---- unit ---------------------------------------------------------------------------------------------------------

void RecUnit::process(const RenderContext &, UnitIO &io) {
  s_->quanta.fetch_add(1, std::memory_order_relaxed);
  if (!io.in || !s_->armed.load(std::memory_order_acquire)) return;
  const Bus &in = *io.in;
  const float *l = in.ch[0], *r = in.ch[in.channels == 2 ? 1 : 0];
  const std::uint64_t h = s_->head.load(std::memory_order_relaxed);
  const std::uint64_t t = s_->tail.load(std::memory_order_acquire);
  if (h - t + kQ > RecShared::kFrames) {  // the writer fell behind: drop this quantum, count it
    s_->dropped.fetch_add(kQ, std::memory_order_relaxed);
    return;
  }
  float pl = 0.0f, pr = 0.0f;
  for (std::size_t i = 0; i < kQ; ++i) {
    const std::size_t k = ((h + i) & (RecShared::kFrames - 1)) * 2;
    s_->buf[k] = l[i];
    s_->buf[k + 1] = r[i];
    pl = std::max(pl, std::min(std::fabs(l[i]), 1.0f));  // clamped like recorder-processor.js; NaN ignored
    pr = std::max(pr, std::min(std::fabs(r[i]), 1.0f));
  }
  casMax(s_->peakBits[0], pl);
  casMax(s_->peakBits[1], pr);
  s_->head.store(h + kQ, std::memory_order_release);
}

// ---- WAV stream ---------------------------------------------------------------------------------------------------

std::int16_t WavStreamWriter::to16(float x) {
  double v = x;
  if (!(v == v)) v = 0;
  v = std::clamp(v, -1.0, 1.0);
  return static_cast<std::int16_t>(std::floor((v < 0 ? v * 32768.0 : v * 32767.0) + 0.5));  // Math.round
}

std::int32_t WavStreamWriter::to24(float x) {
  double v = x;
  if (!(v == v)) v = 0;
  v = std::clamp(v, -1.0, 1.0);
  return static_cast<std::int32_t>(std::floor((v < 0 ? v * 8388608.0 : v * 8388607.0) + 0.5));
}

bool WavStreamWriter::open(const std::string &path, double sampleRate, int bits, std::string *err) {
  close();
  f_ = std::fopen(path.c_str(), "wb");
  if (!f_) {
    if (err) *err = "cannot create " + path;
    return false;
  }
  sr_ = sampleRate;
  bits_ = bits;
  frames_ = dataBytes_ = 0;
  if (!header()) {
    if (err) *err = "cannot write " + path;
    close();
    return false;
  }
  return true;
}

bool WavStreamWriter::header() {
  const std::uint32_t bps = static_cast<std::uint32_t>(bits_ / 8), ch = 2;
  const std::uint32_t rate = static_cast<std::uint32_t>(std::lround(sr_));
  const std::uint32_t data = static_cast<std::uint32_t>(std::min<std::uint64_t>(dataBytes_, 0xffffffffu - 36));
  std::string h = "RIFF";
  le(h, 36 + data, 4);
  h += "WAVEfmt ";
  le(h, 16, 4);
  le(h, 1, 2);  // PCM
  le(h, ch, 2);
  le(h, rate, 4);
  le(h, rate * ch * bps, 4);
  le(h, ch * bps, 2);
  le(h, static_cast<std::uint32_t>(bits_), 2);
  h += "data";
  le(h, data, 4);
  return std::fseek(f_, 0, SEEK_SET) == 0 && std::fwrite(h.data(), 1, h.size(), f_) == h.size();
}

bool WavStreamWriter::write(const float *x, std::size_t frames) {
  if (!f_) return false;
  const std::size_t bps = static_cast<std::size_t>(bits_ / 8);
  conv_.resize(frames * 2 * bps);
  char *o = conv_.data();
  for (std::size_t i = 0; i < frames * 2; ++i) {
    if (bits_ == 16) {
      const std::uint16_t v = static_cast<std::uint16_t>(to16(x[i]));
      *o++ = static_cast<char>(v & 0xff);
      *o++ = static_cast<char>(v >> 8);
    } else {
      const std::uint32_t v = static_cast<std::uint32_t>(to24(x[i]));
      *o++ = static_cast<char>(v & 0xff);
      *o++ = static_cast<char>((v >> 8) & 0xff);
      *o++ = static_cast<char>((v >> 16) & 0xff);
    }
  }
  if (std::fwrite(conv_.data(), 1, conv_.size(), f_) != conv_.size()) return false;
  frames_ += frames;
  dataBytes_ += conv_.size();
  return true;
}

bool WavStreamWriter::refreshHeader() {
  if (!f_) return false;
  const bool ok = header() && std::fseek(f_, 0, SEEK_END) == 0 && std::fflush(f_) == 0;
  return ok;
}

void WavStreamWriter::close() {
  if (!f_) return;
  refreshHeader();
  std::fclose(f_);
  f_ = nullptr;
}

// ---- service ------------------------------------------------------------------------------------------------------

RecServiceImpl::RecServiceImpl(Model &m) : m_(m), shared_(new RecShared()) {
  offlineMode_ = m_.env().config && m_.env().config->mode == RIG_MODE_OFFLINE;
  std::lock_guard<std::mutex> lk(g_mu);
  g_shared[m_.env().config] = shared_;
}

RecServiceImpl::~RecServiceImpl() {
  finish(nullptr);  // rig_destroy finalises an open recording (valid WAV)
  {
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_shared.find(m_.env().config);
    if (it != g_shared.end() && it->second == shared_) g_shared.erase(it);
  }
  delete shared_;  // the graph (destroyed later) holds the unit but renders no more; the unit has no destructor work
}

RecServiceImpl *RecServiceImpl::of(Model &m) {
  return dynamic_cast<RecServiceImpl *>(m.service<RecService>());
}

RecShared *RecServiceImpl::sharedFor(const void *key) {
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_shared.find(key);
  return it == g_shared.end() ? nullptr : it->second;
}

void RecServiceImpl::emitState(const char *state, const char *message) {
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "rec").kv("state", state);
  if (!path_.empty()) j.kv("path", path_);
  if (message) j.kv("message", message);
  j.end();
  m_.emit(j.take());
}

std::string RecServiceImpl::start(const yyjson_val *argsC) {
  auto *args = const_cast<yyjson_val *>(argsC);
  if (writer_.isOpen()) return errorJson("busy", "rec: already recording to " + path_);
  if (m_.attachedKind(UnitSlot::Recorder) != kKindRec)  // the global units exist from `audio start` on
    return errorJson("not-started", "rec: audio is not started");
  int bits = 16;
  if (yyjson_val *b = yyjson_obj_get(args, "bits")) {
    if (!yyjson_is_num(b) || (yyjson_get_num(b) != 16 && yyjson_get_num(b) != 24))
      return errorJson("bad-request", "rec: bits must be 16 or 24");
    bits = static_cast<int>(yyjson_get_num(b));
  }
  std::string dir = m_.paths().recordingsDir;
  if (yyjson_val *d = yyjson_obj_get(args, "dir"); d && yyjson_is_str(d)) dir = yyjson_get_str(d);
  if (dir.empty()) return errorJson("bad-request", "rec: no recordings folder (dir or rig_config.recordings_dir)");
  std::error_code ec;
  if (!std::filesystem::is_directory(dir, ec)) return errorJson("bad-request", "rec: not a folder: " + dir);
  yyjson_val *fn = yyjson_obj_get(args, "filename");
  const std::string name = fn && yyjson_is_str(fn) ? cleanName(yyjson_get_str(fn)) : defaultName();
  const std::string path = uniquePath(dir, name);
  sr_ = m_.env().sampleRate;
  std::string err;
  if (!writer_.open(path, sr_, bits, &err)) return errorJson("internal", "rec: " + err);
  path_ = path;
  ioError_ = false;
  // The writer side owns `tail` from here: drop whatever an earlier take left in the ring, then arm.
  shared_->tail.store(shared_->head.load(std::memory_order_acquire), std::memory_order_release);
  shared_->dropped.store(0, std::memory_order_relaxed);
  shared_->peakBits[0].store(0, std::memory_order_relaxed);
  shared_->peakBits[1].store(0, std::memory_order_relaxed);
  shared_->armed.store(true, std::memory_order_release);
  ++recordings_;
  lastLevel_ = -1;
  emitState("recording", nullptr);
  if (!offlineMode_) {
    run_ = true;
    thread_ = std::thread([this] { writerLoop(); });
  }
  JsonOut j;
  j.begin().kv("path", path_).end();
  return j.take();
}

std::size_t RecServiceImpl::drain() {
  std::size_t total = 0;
  for (;;) {
    const std::uint64_t t = shared_->tail.load(std::memory_order_relaxed);
    const std::uint64_t h = shared_->head.load(std::memory_order_acquire);
    if (h == t) break;
    const std::size_t at = static_cast<std::size_t>(t & (RecShared::kFrames - 1));
    const std::size_t n = static_cast<std::size_t>(std::min<std::uint64_t>(h - t, RecShared::kFrames - at));
    if (!ioError_ && !writer_.write(shared_->buf + at * 2, n)) ioError_ = true;
    shared_->tail.store(t + n, std::memory_order_release);
    total += n;
  }
  return total;
}

void RecServiceImpl::writerLoop() {
  auto lastHeader = std::chrono::steady_clock::now();
  while (run_.load(std::memory_order_acquire)) {
    const std::size_t n = drain();
    const auto now = std::chrono::steady_clock::now();
    if (now - lastHeader >= std::chrono::seconds(1)) {  // a crash or jetsam leaves a playable file
      if (!writer_.refreshHeader()) ioError_ = true;
      lastHeader = now;
    }
    if (n == 0) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}

std::string RecServiceImpl::finish(const char *message) {
  if (!writer_.isOpen()) return {};
  shared_->armed.store(false, std::memory_order_release);
  if (!offlineMode_) {
    // let a quantum that saw `armed` before the store publish its frames (or give up after 50 ms: audio stopped)
    const std::uint64_t q0 = shared_->quanta.load(std::memory_order_relaxed);
    for (int i = 0; i < 50 && shared_->quanta.load(std::memory_order_relaxed) < q0 + 2; ++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    run_ = false;
    if (thread_.joinable()) thread_.join();
  }
  drain();
  const double seconds = static_cast<double>(writer_.frames()) / sr_;
  const std::uint64_t bytes = writer_.bytes();
  writer_.close();
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "rec").kv("state", ioError_ ? "error" : "stopped").kv("path", path_);
  j.kv("seconds", seconds).kv("bytes", static_cast<double>(bytes));
  if (const std::uint64_t d = shared_->dropped.load(std::memory_order_relaxed)) j.kv("droppedFrames", double(d));
  if (message) j.kv("message", message);
  else if (ioError_) j.kv("message", "rec: write failed (disk full?)");
  j.end();
  m_.emit(j.take());
  JsonOut r;
  r.begin().kv("path", path_).kv("seconds", seconds).kv("bytes", static_cast<double>(bytes)).end();
  return r.take();
}

std::string RecServiceImpl::stop() {
  if (!writer_.isOpen()) return R"({"path":null,"seconds":0,"bytes":0})";
  return finish(nullptr);
}

void RecServiceImpl::onRateChanged(double) {
  // A WAV has one rate: the take ends at the switch (the shell can start a new one).
  if (writer_.isOpen()) finish("sample rate changed: recording stopped");
}

void RecServiceImpl::pump(bool offline, double t) {
  if (!writer_.isOpen()) return;
  if (offline) drain();
  if (ioError_) {
    finish(nullptr);
    return;
  }
  if (lastLevel_ >= 0 && t - lastLevel_ < 0.1) return;  // ~10 Hz, like recorder.js chunk levels
  lastLevel_ = t;
  const float pl = std::bit_cast<float>(shared_->peakBits[0].exchange(0, std::memory_order_relaxed));
  const float pr = std::bit_cast<float>(shared_->peakBits[1].exchange(0, std::memory_order_relaxed));
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "rec").kv("state", "recording").key("level").begin();
  j.kv("peakL", pl).kv("peakR", pr).end().end();
  m_.emit(j.take());
}

std::string RecServiceImpl::statsFields() {
  JsonOut j;
  j.kvBool("recording", writer_.isOpen());
  j.kv("recDroppedFrames", static_cast<double>(shared_->dropped.load(std::memory_order_relaxed)));
  return j.take();
}

}  // namespace rig
