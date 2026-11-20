// M16 meters (T08). See meter.h.
#include "meter/meter.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <map>
#include <mutex>

#include "bridge/json_out.h"
#include "model/model.h"
#include "pffft.h"
#include "yyjson.h"

namespace rig {
namespace {

// Engine -> shared meter state, so the registered `meter` factory (a plain function of UnitEnv) finds the state of
// the engine it builds for. Keyed by UnitEnv::config (one rig_config per engine). Control threads only.
std::mutex g_mu;
std::map<const void *, MeterShared *> g_shared;

constexpr double kTwoPi = 6.283185307179586;
constexpr double kSmoothing = 0.8;  // AnalyserNode smoothingTimeConstant (contract 3.11)

void casMax(std::atomic<std::uint32_t> &bits, float v) {
  std::uint32_t cur = bits.load(std::memory_order_relaxed);
  while (v > std::bit_cast<float>(cur) &&
         !bits.compare_exchange_weak(cur, std::bit_cast<std::uint32_t>(v), std::memory_order_relaxed)) {
  }
}

}  // namespace

MeterShared *MeterServiceImpl::sharedFor(const void *key) {
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_shared.find(key);
  return it == g_shared.end() ? nullptr : it->second;
}

float MeterShared::takePeak(int ch) {
  return std::bit_cast<float>(peakBits[ch].exchange(0, std::memory_order_relaxed));
}

void MeterUnit::process(const RenderContext &, UnitIO &io) {
  if (!io.in) return;
  const Bus &in = *io.in;
  const float *ch[2] = {in.ch[0], in.ch[in.channels == 2 ? 1 : 0]};
  for (int c = 0; c < 2; ++c) {
    float pk = 0.0f;
    for (std::size_t i = 0; i < kQ; ++i) pk = std::max(pk, std::fabs(ch[c][i]));
    if (pk > 0.0f) casMax(s_->peakBits[c], pk);
  }
  if (s_->rtaOn.load(std::memory_order_relaxed)) {
    const std::uint64_t w = s_->written.load(std::memory_order_relaxed);
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < kQ; ++i)
        s_->ring[c][(w + i) & (MeterShared::kRing - 1)].store(ch[c][i], std::memory_order_relaxed);
    s_->written.store(w + kQ, std::memory_order_release);
  }
  s_->quanta.fetch_add(1, std::memory_order_relaxed);
}

// ---- service ------------------------------------------------------------------------------------------------------

MeterServiceImpl::MeterServiceImpl(Model &m) : m_(m), shared_(new MeterShared()) {
  std::lock_guard<std::mutex> lk(g_mu);
  g_shared[m_.env().config] = shared_;
}

MeterServiceImpl::~MeterServiceImpl() {
  {
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_shared.find(m_.env().config);
    if (it != g_shared.end() && it->second == shared_) g_shared.erase(it);
  }
  if (fft_) pffft_destroy_setup(fft_);
  pffft_aligned_free(in_);
  pffft_aligned_free(out_);
  pffft_aligned_free(work_);
  // Engine destruction order: the Model (and this service) goes before the Graph, which still holds the unit but
  // renders no more. The unit never dereferences the shared state outside process(), so freeing it here is safe.
  delete shared_;
}

MeterServiceImpl *MeterServiceImpl::of(Model &m) {
  return dynamic_cast<MeterServiceImpl *>(m.service<MeterService>());
}

void MeterServiceImpl::subscribe(const yyjson_val *meters) {
  auto *o = const_cast<yyjson_val *>(meters);
  if (!o || !yyjson_is_obj(o)) return;
  if (yyjson_val *r = yyjson_obj_get(o, "rate"); r && yyjson_is_num(r)) rate_ = yyjson_get_num(r);
  if (yyjson_val *s = yyjson_obj_get(o, "slots"); s && yyjson_is_arr(s)) {
    slots_.fill(false);
    std::size_t i, n;
    yyjson_val *it;
    yyjson_arr_foreach(s, i, n, it) {
      if (!yyjson_is_num(it)) continue;
      const double k = yyjson_get_num(it);
      if (k >= 0 && k < 4 && k == std::floor(k)) slots_[static_cast<std::size_t>(k)] = true;
    }
  }
  if (yyjson_val *r = yyjson_obj_get(o, "rta"); r && yyjson_is_bool(r)) {
    const bool on = yyjson_get_bool(r);
    if (on && !rta_) {  // fresh subscription: smoothing restarts from silence, like a new AnalyserNode
      for (auto &s : smooth_) s.assign(MeterShared::kRtaSize / 2, 0.0f);
    }
    rta_ = on;
    shared_->rtaOn.store(on, std::memory_order_relaxed);
  }
}

bool MeterServiceImpl::anySlot() const {
  return std::any_of(slots_.begin(), slots_.end(), [](bool b) { return b; });
}

double MeterServiceImpl::tickHz() const {
  if (rate_ > 0) return std::clamp(rate_, kIdleTickHz, kMaxTickHz);
  return anySlot() || rta_ ? kActiveTickHz : kIdleTickHz;
}

void MeterServiceImpl::onRateChanged(double) {
  for (auto &s : smooth_) s.assign(MeterShared::kRtaSize / 2, 0.0f);  // a new context: fresh analysers
}

std::string MeterServiceImpl::statsFields() {
  int taps = 0;
  for (bool b : slots_) taps += b ? 1 : 0;
  return "\"slotLevelTaps\":" + std::to_string(m_.lowResource() ? 0 : taps);
}

std::string MeterServiceImpl::rtaBase64() {
  constexpr std::size_t N = MeterShared::kRtaSize, K = N / 2;
  if (!fft_) {
    fft_ = pffft_new_setup(static_cast<int>(N), PFFFT_REAL);
    in_ = static_cast<float *>(pffft_aligned_malloc(N * sizeof(float)));
    out_ = static_cast<float *>(pffft_aligned_malloc(N * sizeof(float)));
    work_ = static_cast<float *>(pffft_aligned_malloc(N * sizeof(float)));
    window_.resize(N);
    for (std::size_t i = 0; i < N; ++i) {  // Blackman, alpha 0.16 (Chromium RealtimeAnalyser::ApplyWindow)
      const double x = static_cast<double>(i) / static_cast<double>(N);
      window_[i] = static_cast<float>(0.42 - 0.5 * std::cos(kTwoPi * x) + 0.08 * std::cos(2 * kTwoPi * x));
    }
  }
  for (int c = 0; c < 2; ++c) {
    if (smooth_[c].size() != K) smooth_[c].assign(K, 0.0f);
    db_[c].resize(K);
  }
  std::uint8_t bytes[2 * K];
  float frames[2][N];
  for (int attempt = 0; attempt < 4; ++attempt) {  // a torn copy (writer lapped us) is retried
    const std::uint64_t w0 = shared_->written.load(std::memory_order_acquire);
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < N; ++i) {
        const std::uint64_t f = w0 - N + i;  // wraps below 0 for a young ring: those frames are silence
        frames[c][i] = w0 + i >= N ? shared_->ring[c][f & (MeterShared::kRing - 1)].load(std::memory_order_relaxed)
                                   : 0.0f;
      }
    if (shared_->written.load(std::memory_order_acquire) - w0 <= MeterShared::kRing - N) break;
  }
  const double scale = 1.0 / static_cast<double>(N);
  for (int c = 0; c < 2; ++c) {
    for (std::size_t i = 0; i < N; ++i) in_[i] = frames[c][i] * window_[i];
    pffft_transform_ordered(fft_, in_, out_, work_, PFFFT_FORWARD);
    for (std::size_t k = 0; k < K; ++k) {
      const double re = k == 0 ? out_[0] : out_[2 * k];
      const double im = k == 0 ? 0.0 : out_[2 * k + 1];  // out_[1] is Nyquist: dropped, as in Chromium
      const double mag = std::sqrt(re * re + im * im) * scale;
      const double s = kSmoothing * smooth_[c][k] + (1.0 - kSmoothing) * mag;
      smooth_[c][k] = std::isfinite(s) ? static_cast<float>(s) : 0.0f;
      const double db = smooth_[c][k] > 0 ? 20.0 * std::log10(static_cast<double>(smooth_[c][k])) : -1000.0;
      db_[c][k] = static_cast<float>(db);
      const double q = std::round(-db * 2.0);
      bytes[static_cast<std::size_t>(c) * K + k] = static_cast<std::uint8_t>(std::clamp(q, 0.0, 255.0));
    }
  }
  return base64(bytes, sizeof bytes);
}

std::string base64(const std::uint8_t *d, std::size_t n) {
  static constexpr char kA[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((n + 2) / 3 * 4);
  for (std::size_t i = 0; i < n; i += 3) {
    const std::uint32_t b0 = d[i], b1 = i + 1 < n ? d[i + 1] : 0u, b2 = i + 2 < n ? d[i + 2] : 0u;
    const std::uint32_t v = b0 << 16 | b1 << 8 | b2;
    out += kA[v >> 18 & 63];
    out += kA[v >> 12 & 63];
    out += i + 1 < n ? kA[v >> 6 & 63] : '=';
    out += i + 2 < n ? kA[v & 63] : '=';
  }
  return out;
}

}  // namespace rig
