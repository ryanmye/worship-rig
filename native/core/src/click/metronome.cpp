// Port of app/js/engine/metronome.js Metronome (T07). See metronome.h.
#include "click/metronome.h"

#include <chrono>
#include <cmath>
#include <cstring>

#include "num/js_number.h"

namespace rig::click {
namespace {

constexpr double kClickLenSec = 0.04;

double finiteOr0(double v) {
  return std::isfinite(v) ? v : 0;
}
double jsMax(double a, double b) {
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

void num(std::string &s, double v) {
  s += js::numberToString(v);
}

}  // namespace

std::string Metronome::configure(double level, const bool *record, const char *output, bool hasOutput, double when) {
  const double t = jsMax(finiteOr0(when), h_.now());
  if (std::isfinite(level) && level != level_) {
    level_ = std::fmin(1, jsMax(0, level));
    h_.rampLevel(level_, t);
  }
  if (record && *record != record_) {  // engine: fx.recordTap always exists
    record_ = *record;
    h_.route(auxRouted_, record_);
  }
  if (hasOutput) setOutput(output);
  std::string r = "{\"output\":\"";
  r += output_;
  r += "\",\"auxAvailable\":";
  r += auxAvailable() ? "true}" : "false}";
  return r;
}

const char *Metronome::setOutput(const char *output) {
  const bool wantAux = output && std::strcmp(output, "aux") == 0;
  want_ = wantAux ? "aux" : "main";
  if (wantAux && !auxAvailable()) {
    h_.warn("This output has no outputs 3–4, so the click plays with the music.");
    if (std::strcmp(output_, "main") != 0) routeMain();
    return output_;
  }
  if (std::strcmp(want_, output_) == 0 && (!wantAux || auxRouted_)) return want_;
  if (wantAux)
    routeAux();
  else
    routeMain();
  return output_;
}

void Metronome::reapplyOutput() {
  const bool wantAux = want_ && std::strcmp(want_, "aux") == 0;
  auxRouted_ = false;
  if (wantAux && auxAvailable())
    routeAux();
  else
    routeMain();
}

void Metronome::routeMain() {
  auxRouted_ = false;
  h_.route(false, record_);
  output_ = "main";
}

void Metronome::routeAux() {
  auxRouted_ = true;
  h_.route(true, record_);
  output_ = "aux";
}

std::string Metronome::start(double bpm, std::string_view sig, int countIn, bool quietAfter, double when) {
  bpm_ = bpm > 0 ? bpm : 0;
  sig_ = meterOf(sig).sig;
  if (!(bpm_ > 0)) return "null";
  if (grid_) stop(-1, true);
  const double now = h_.now();
  const double t0 = jsMax(finiteOr0(when), now + kStartLeadSec);
  grid_ = std::make_unique<ClickGrid>(t0, bpm_, sig_, countIn);
  quietAfter_ = quietAfter && countIn > 0;
  counting_ = grid_->downbeat() > 0;
  startSent_ = false;
  horizon_ = now;
  stats_.startedAt = now;
  emitState();
  pump(now);
  std::string r = "{\"t0\":";
  num(r, t0);
  r += ",\"downbeat\":";
  num(r, grid_ ? grid_->downbeatTime() : 0);
  r += '}';
  return r;
}

bool Metronome::stop(double when, bool silent) {
  if (!grid_) return false;
  const double t = jsMax(finiteOr0(when), h_.now());
  h_.clearAfter(t);
  for (auto it = live_.begin(); it != live_.end();) it = *it < t - 1e-6 ? std::next(it) : live_.erase(it);
  ++pumpGen_;  // _cancelPump()
  grid_.reset();
  counting_ = false;
  if (!silent) {
    if (h_.hasClockSink()) {
      const ClockMsg m{t, kMidiStop};
      h_.sendClock(&m, 1);
    }
    emitState();
  }
  return true;
}

std::string Metronome::retime(double bpm, bool bpmNull, std::string_view sig, bool newBar) {
  if (bpmNull) {
    bpm_ = 0;
    if (grid_) stop(-1);
    return "null";
  }
  const bool hasBpm = bpm > 0;
  const char *ns = sig.empty() ? nullptr : meterOf(sig).sig;
  const bool changed = (hasBpm && bpm != bpm_) || (ns && std::strcmp(ns, sig_) != 0) || newBar;
  if (hasBpm) bpm_ = bpm;
  if (ns) sig_ = ns;
  if (!grid_ || !changed) return "null";
  const double tMin = jsMax(horizon_, h_.now() + 0.005);
  const ClickGrid::Retimed r = grid_->retime(tMin, hasBpm ? bpm : 0, ns ? std::string_view(ns) : std::string_view(),
                                             newBar);
  if (grid_->downbeat() > r.beat) counting_ = true;  // a new song during the count-in counts in afresh
  emitState();
  std::string s = "{\"beat\":";
  num(s, r.beat);
  s += ",\"t\":";
  num(s, r.t);
  s += '}';
  return s;
}

void Metronome::pump(double now) {
  if (!grid_) return;
  const auto p0 = std::chrono::steady_clock::now();
  while (!live_.empty() && live_.front() + kClickLenSec <= now) live_.pop_front();  // finished sources
  const ClickGrid &g = *grid_;
  const double from = horizon_;
  const double to = now + kLookaheadSec;
  if (to > from) {
    const double downT = g.downbeatTime();
    g.ticks(from, to, [&](const Tick &k) {
      if (k.t < now - 0.002) {
        ++stats_.late;  // a stalled pump: never play a click late
        return;
      }
      if (quietAfter_ && !k.countIn) return;
      h_.scheduleTick(k.t, k.kind);
      live_.push_back(k.t);
      ++stats_.ticks;
    });
    if (h_.hasClockSink()) {
      // MIDI Start right before the clock pulse of the song's first downbeat (metronome.js)
      msgs_.clear();
      g.pulses(from, to, [&](double t) {
        if (!startSent_ && t >= downT - 1e-6) {
          msgs_.push_back({t, kMidiStart});
          startSent_ = true;
        }
        msgs_.push_back({t, kMidiClock});
      });
      stats_.pulses += msgs_.size();
      if (!msgs_.empty()) h_.sendClock(msgs_.data(), msgs_.size());
    } else if (downT < to) {
      startSent_ = true;
    }
    horizon_ = to;
  }
  if (counting_ && now >= g.downbeatTime() - 1e-6) {
    counting_ = false;
    emitState();
  }
  ++stats_.pumps;
  stats_.pumpMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - p0).count();
  const std::uint64_t gen = pumpGen_;
  h_.at(now + kPumpSec, [this, gen](double t) {
    if (gen == pumpGen_) pump(t);
  });
}

void Metronome::rescheduleTicks(double now) {
  live_.clear();
  if (!grid_ || !(horizon_ > now)) return;
  grid_->ticks(now, horizon_, [&](const Tick &k) {
    if (quietAfter_ && !k.countIn) return;
    h_.scheduleTick(k.t, k.kind);
    live_.push_back(k.t);
  });
}

std::size_t Metronome::liveCount() {
  const double now = h_.now();
  while (!live_.empty() && live_.front() + kClickLenSec <= now) live_.pop_front();
  return live_.size();
}

std::string Metronome::stateJson() const {
  std::string s = "{\"running\":";
  s += running() ? "true" : "false";
  s += ",\"counting\":";
  s += counting() ? "true" : "false";
  s += ",\"bpm\":";
  if (bpm_ > 0)
    num(s, bpm_);
  else
    s += "null";
  s += ",\"sig\":\"";
  s += sig_;
  s += "\",\"output\":\"";
  s += output_;
  s += "\",\"level\":";
  num(s, level_);
  s += ",\"record\":";
  s += record_ ? "true" : "false";
  s += ",\"downbeat\":";
  if (grid_)
    num(s, grid_->downbeatTime());
  else
    s += "null";
  s += '}';
  return s;
}

std::string Metronome::statsJson() {
  std::string s = stateJson();
  s.pop_back();
  s += ",\"live\":";
  num(s, static_cast<double>(liveCount()));
  s += ",\"pumps\":";
  num(s, static_cast<double>(stats_.pumps));
  s += ",\"pumpMs\":";
  num(s, stats_.pumpMs);
  s += ",\"ticks\":";
  num(s, static_cast<double>(stats_.ticks));
  s += ",\"late\":";
  num(s, static_cast<double>(stats_.late));
  s += ",\"pulses\":";
  num(s, static_cast<double>(stats_.pulses));
  s += ",\"startedAt\":";
  if (stats_.startedAt >= 0)
    num(s, stats_.startedAt);
  else
    s += "null";
  s += '}';
  return s;
}

}  // namespace rig::click
