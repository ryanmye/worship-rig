// Slot EQ: resolveSlotEq / slotEqMembers / eqSpec and the SlotEq class of app/js/engine/fx.js:1614-1990, ported
// line by line (comments name the JS members). See slot_eq.h.
#include "mix/slot_eq.h"

#include <cmath>
#include <cstdio>
#include <cstring>

#include "model/patch.h"
#include "num/js_math.h"
#include "params/params.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig {
namespace {

constexpr double kCutOffHz = 20.5;      // EQ_CUT_OFF_HZ
constexpr double kHiCutOffHz = 19999;   // EQ_HICUT_OFF_HZ
const char *const kFieldNames[5] = {"on", "type", "hz", "db", "q"};
const char *const kLegacyNames[kEqLegacyRows] = {"low", "lowHz", "mid1", "mid1Hz", "mid1Q",
                                                 "mid2", "mid2Hz", "mid2Q", "high", "highHz"};

double butter2Q() {  // BUTTER2_Q = 20 * Math.log10(Math.SQRT1_2)
  static const double q = 20 * js::log10(js::kSqrt1_2);
  return q;
}

const ParamRow *eqRow(const char *key) {
  char p[48];
  std::snprintf(p, sizeof p, "slots.0.eq.%s", key);
  return findParam(p);
}
const ParamRow *bandRow(int k, int field) {
  char p[16];
  std::snprintf(p, sizeof p, "b%d.%s", k + 1, kFieldNames[field]);
  return eqRow(p);
}
double rowDef(const ParamRow *r, double fallback) {
  return r && !std::isnan(r->def) ? r->def : fallback;
}
double clampRow(const ParamRow *r, double v) {
  return r && r->kind == 0 ? clampNumber(*r, v) : v;
}

/** EQ_LEGACY: band index -> legacy rows (db, hz, q; -1 = none). */
struct Legacy {
  int band, type, db, hz, q;
};
constexpr Legacy kLegacy[4] = {{0, EqLowshelf, EqLLow, EqLLowHz, -1},
                               {1, EqPeak, EqLMid1, EqLMid1Hz, EqLMid1Q},
                               {2, EqPeak, EqLMid2, EqLMid2Hz, EqLMid2Q},
                               {kEqBands - 1, EqHighshelf, EqLHigh, EqLHighHz, -1}};

struct Defaults {
  EqBand band[kEqBands];
  double cut, hiCut, legacy[kEqLegacyRows];
  Defaults() {
    for (int k = 0; k < kEqBands; ++k) {
      EqBand &b = band[k];
      b.on = rowDef(bandRow(k, EqFOn), 0) != 0.0;
      b.type = static_cast<int>(rowDef(bandRow(k, EqFType), EqPeak));
      b.hz = rowDef(bandRow(k, EqFHz), 1000);
      b.db = rowDef(bandRow(k, EqFDb), 0);
      b.q = rowDef(bandRow(k, EqFQ), 1);
    }
    cut = rowDef(eqRow("cutHz"), 20);
    hiCut = rowDef(eqRow("hiCutHz"), 20000);
    for (int i = 0; i < kEqLegacyRows; ++i) legacy[i] = rowDef(eqRow(kLegacyNames[i]), 0);
  }
};
const Defaults &defs() {
  static const Defaults d;
  return d;
}

wa::BiquadType webOf(int type, bool *has) {
  *has = true;
  switch (type) {
    case EqLowshelf:
      return wa::BiquadType::Lowshelf;
    case EqPeak:
      return wa::BiquadType::Peaking;
    case EqHighshelf:
      return wa::BiquadType::Highshelf;
    case EqNotch:
      return wa::BiquadType::Notch;
    case EqLowcut:
      return wa::BiquadType::Highpass;
    case EqHighcut:
      return wa::BiquadType::Lowpass;
    default:
      *has = false;
      return wa::BiquadType::Peaking;
  }
}
bool isIdentity(wa::BiquadType w) {  // EQ_IDENTITY
  return w == wa::BiquadType::Lowshelf || w == wa::BiquadType::Peaking || w == wa::BiquadType::Highshelf;
}
bool usesQ(wa::BiquadType w) {  // eqUsesQ
  return w == wa::BiquadType::Peaking || w == wa::BiquadType::Notch || w == wa::BiquadType::Highpass ||
         w == wa::BiquadType::Lowpass;
}

}  // namespace

// ---- resolved spec ------------------------------------------------------------------------------------------------

void resolveSlotEq(SlotEqSpec &s) {
  const Defaults &d = defs();
  for (int k = 0; k < kEqBands; ++k) {
    EqBand b = d.band[k];
    if (s.stored[k]) {
      const EqBand &r = s.raw[k];
      if (s.stored[k] & (1u << EqFOn)) b.on = r.on;
      if (s.stored[k] & (1u << EqFType)) b.type = r.type;
      if (s.stored[k] & (1u << EqFHz)) b.hz = r.hz;
      if (s.stored[k] & (1u << EqFDb)) b.db = r.db;
      if (s.stored[k] & (1u << EqFQ)) b.q = r.q;
    } else {
      for (const Legacy &L : kLegacy) {
        if (L.band != k) continue;
        auto has = [&](int row) { return row >= 0 && (s.legacyHas & (1u << row)); };
        if (has(L.db) || has(L.hz) || has(L.q)) {
          b.on = true;
          b.type = L.type;
          b.hz = d.legacy[L.hz];  // the legacy row's own default (DECISION's bell 1 is 400 Hz, not b2's 210)
          if (L.q >= 0) b.q = d.legacy[L.q];
        }
        if (has(L.db)) b.db = clampRow(bandRow(k, EqFDb), s.legacy[L.db]);
        if (has(L.hz)) b.hz = clampRow(bandRow(k, EqFHz), s.legacy[L.hz]);
        if (has(L.q)) b.q = clampRow(bandRow(k, EqFQ), s.legacy[L.q]);
      }
    }
    s.bands[k] = b;
  }
  s.cutHz = s.cutStored ? s.cutHz : d.cut;
  s.hiCutHz = s.hiCutStored ? s.hiCutHz : d.hiCut;
}

const SlotEqSpec &defaultSlotEqSpec() {
  static const SlotEqSpec d = [] {
    SlotEqSpec s;
    resolveSlotEq(s);
    return s;
  }();
  return d;
}

bool storeSlotEqRow(SlotEqSpec &s, const char *key, double v) {
  if (!std::strcmp(key, "cutHz")) {
    s.cutHz = clampRow(eqRow("cutHz"), v);
    s.cutStored = true;
  } else if (!std::strcmp(key, "hiCutHz")) {
    s.hiCutHz = clampRow(eqRow("hiCutHz"), v);
    s.hiCutStored = true;
  } else if (key[0] == 'b' && key[1] >= '1' && key[1] <= '8' && key[2] == '.') {
    const int k = key[1] - '1';
    int f = -1;
    for (int i = 0; i < 5; ++i)
      if (!std::strcmp(key + 3, kFieldNames[i])) f = i;
    if (f < 0) return false;
    v = clampRow(bandRow(k, f), v);
    EqBand &r = s.raw[k];
    if (f == EqFOn) r.on = v != 0.0;
    else if (f == EqFType) r.type = static_cast<int>(v);
    else if (f == EqFHz) r.hz = v;
    else if (f == EqFDb) r.db = v;
    else r.q = v;
    s.stored[k] = static_cast<std::uint8_t>(s.stored[k] | (1u << f));
  } else {
    int l = -1;
    for (int i = 0; i < kEqLegacyRows; ++i)
      if (!std::strcmp(key, kLegacyNames[i])) l = i;
    if (l < 0) return false;
    s.legacy[l] = clampRow(eqRow(key), v);
    s.legacyHas = static_cast<std::uint16_t>(s.legacyHas | (1u << l));
  }
  resolveSlotEq(s);
  return true;
}

void parseSlotEqJson(const yyjson_val *eqv, SlotEqSpec &out) {
  out = SlotEqSpec{};
  yyjson_val *eq = const_cast<yyjson_val *>(eqv);
  if (eq && yyjson_is_obj(eq)) {
    for (int k = 0; k < kEqBands; ++k) {
      char key[4];
      std::snprintf(key, sizeof key, "b%d", k + 1);
      yyjson_val *bo = yyjson_obj_get(eq, key);
      if (!bo || !yyjson_is_obj(bo)) continue;
      for (int f = 0; f < 5; ++f) {
        yyjson_val *fv = yyjson_obj_get(bo, kFieldNames[f]);
        const ParamRow *row = bandRow(k, f);
        double d;
        if (!fv || !row || !jsonToParamValue(*row, fv, d)) continue;
        char rk[16];
        std::snprintf(rk, sizeof rk, "b%d.%s", k + 1, kFieldNames[f]);
        storeSlotEqRow(out, rk, d);
      }
    }
    const char *plain[2] = {"cutHz", "hiCutHz"};
    for (const char *k : plain) {
      yyjson_val *v = yyjson_obj_get(eq, k);
      const ParamRow *row = eqRow(k);
      double d;
      if (v && row && jsonToParamValue(*row, v, d)) storeSlotEqRow(out, k, d);
    }
    for (const char *k : kLegacyNames) {
      yyjson_val *v = yyjson_obj_get(eq, k);
      const ParamRow *row = eqRow(k);
      double d;
      if (v && row && jsonToParamValue(*row, v, d)) storeSlotEqRow(out, k, d);
    }
  }
  resolveSlotEq(out);
}

// ---- T00 skeleton chain (builtin strip) ---------------------------------------------------------------------------

std::size_t buildEqChain(const SlotEqSpec &s, EqFilter out[kMaxEqFilters]) {
  std::size_t n = 0;
  if (s.cutHz > kCutOffHz) out[n++] = {wa::BiquadType::Highpass, s.cutHz, butter2Q(), 0.0};
  for (const EqBand &b : s.bands) {
    if (!b.on || b.type == EqOff) continue;
    switch (b.type) {
      case EqLowshelf:
        out[n++] = {wa::BiquadType::Lowshelf, b.hz, 0.0, b.db};
        break;
      case EqHighshelf:
        out[n++] = {wa::BiquadType::Highshelf, b.hz, 0.0, b.db};
        break;
      case EqPeak:
        out[n++] = {wa::BiquadType::Peaking, b.hz, b.q, b.db};
        break;
      case EqNotch:
        out[n++] = {wa::BiquadType::Notch, b.hz, b.q, 0.0};
        break;
      case EqLowcut:
        out[n++] = {wa::BiquadType::Highpass, b.hz, 20.0 * js::log10(b.q), 0.0};
        break;
      case EqHighcut:
        out[n++] = {wa::BiquadType::Lowpass, b.hz, 20.0 * js::log10(b.q), 0.0};
        break;
      default:
        break;
    }
  }
  if (s.hiCutHz < kHiCutOffHz) out[n++] = {wa::BiquadType::Lowpass, s.hiCutHz, butter2Q(), 0.0};
  return n;
}

void SlotEq::configure(const SlotEqSpec &spec, double sr) {
  EqFilter nf[kMaxEqFilters];
  const std::size_t n = buildEqChain(spec, nf);
  bool same = n == count_;
  for (std::size_t i = 0; same && i < n; ++i) same = nf[i].type == f_[i].type;
  for (std::size_t i = 0; i < n; ++i) {
    f_[i] = nf[i];
    for (auto &ch : bq_) {
      if (!same) ch[i].reset();
      ch[i].set(f_[i].type, f_[i].hz, f_[i].q, f_[i].db, sr);
    }
  }
  count_ = n;
}

void SlotEq::process(float *const *ch, int nch, std::size_t n) {
  for (int c = 0; c < nch; ++c) {
    for (std::size_t i = 0; i < count_; ++i) bq_[c][i].process(ch[c], ch[c], n);
  }
}

// ---- SlotEqChains: the JS SlotEq ----------------------------------------------------------------------------------

namespace {
/** Every param a call touches is told the context time first (wa::Param inserts relative to its currentTime). */
void ctxTime(wa::Param &p, std::int64_t frame, double sr) {
  p.setContextTime(frame, sr);
}
}  // namespace

SlotEqChains::SlotEqChains(const SlotEqSpec &want) : want_(want) {
  int ids[kIds];
  const int n = members(ids);
  active_ = makeSide(ids, n, 1.0, 0, 0);
}

SlotEqChains::Spec SlotEqChains::eqSpec(int id) const {
  Spec s;
  if (id == 0) {  // lc
    s.hasWeb = true;
    s.web = wa::BiquadType::Highpass;
    s.hz = want_.cutHz;
    s.hasQ = true;
    s.q = butter2Q();
    s.engaged = want_.cutHz > kCutOffHz;
    return s;
  }
  if (id == kIds - 1) {  // hc
    s.hasWeb = true;
    s.web = wa::BiquadType::Lowpass;
    s.hz = want_.hiCutHz;
    s.hasQ = true;
    s.q = butter2Q();
    s.engaged = want_.hiCutHz < kHiCutOffHz;
    return s;
  }
  const EqBand &b = want_.bands[id - 1];
  s.web = webOf(b.type, &s.hasWeb);
  s.engaged = b.on && s.hasWeb;
  s.hz = b.hz;
  if (s.hasWeb && (s.web == wa::BiquadType::Peaking || s.web == wa::BiquadType::Notch)) {
    s.hasQ = true;
    s.q = b.q;
  } else if (s.hasWeb && (s.web == wa::BiquadType::Highpass || s.web == wa::BiquadType::Lowpass)) {
    s.hasQ = true;
    s.q = 20 * js::log10(b.q);
  }
  if (s.hasWeb && isIdentity(s.web)) {
    s.hasDb = true;
    s.db = s.engaged ? b.db : 0;
  }
  return s;
}

int SlotEqChains::members(int out[kIds]) const {  // slotEqMembers
  int n = 0;
  if (want_.cutHz > kCutOffHz) out[n++] = 0;
  for (int k = 0; k < kEqBands; ++k)
    if (want_.bands[k].on && want_.bands[k].type != EqOff) out[n++] = k + 1;
  if (want_.hiCutHz < kHiCutOffHz) out[n++] = kIds - 1;
  return n;
}

int SlotEqChains::makeSide(const int *ids, int n, double g, std::int64_t nowFrame, double sr) {  // _side
  const int si = !sides_[0].used ? 0 : !sides_[1].used ? 1 : -1;
  if (si < 0) return -1;  // never: at most two chains are alive
  Side &sd = sides_[si];
  sd.used = true;
  sd.gain.gain() = wa::Param(g);
  ctxTime(sd.gain.gain(), nowFrame, sr);
  sd.count = n;
  for (int i = 0; i < n; ++i) {  // _node(id)
    const Spec s = eqSpec(ids[i]);
    Node &nd = sd.nodes[i];
    const wa::BiquadType web = s.hasWeb ? s.web : wa::BiquadType::Peaking;  // never wired while 'off'
    nd.bq.reinit(web, s.hz, s.hasQ ? s.q : 1.0, s.hasDb ? s.db : 0.0);
    nd.bq.setKRate(true);  // DECISION §3 CPU table: every biquad param k-rate
    ctxTime(nd.bq.frequency(), nowFrame, sr);
    ctxTime(nd.bq.q(), nowFrame, sr);
    ctxTime(nd.bq.gain(), nowFrame, sr);
    nd.id = ids[i];
    nd.web = nd.webTarget = web;
    nd.hz = s.hz;
    nd.hasQ = s.hasQ;
    nd.q = s.q;
    nd.db = s.hasDb ? s.db : 0;
    nd.fading = false;
    nd.fadeSeq = 0;
    nd.dead = false;
  }
  return si;
}

void SlotEqChains::dropSide(int s) {  // _drop
  if (s < 0) return;
  Side &sd = sides_[s];
  for (int i = 0; i < sd.count; ++i) sd.nodes[i].dead = true;
  sd.used = false;
  sd.count = 0;
}

bool SlotEqChains::needsSwitch(const int *ids, int n) {  // _needsSwitch
  Side &a = sides_[active_];
  for (int i = 0; i < n; ++i)
    if (!a.find(ids[i])) return true;
  for (int i = 0; i < a.count; ++i) {
    const Node &nd = a.nodes[i];
    const Spec s = eqSpec(nd.id);
    if (!s.engaged) {
      if (!isIdentity(nd.webTarget)) return true;  // a notch / cut cannot idle as identity
    } else if (s.web != nd.webTarget && !(isIdentity(s.web) && isIdentity(nd.webTarget))) {
      return true;
    }
  }
  return false;
}

void SlotEqChains::set(const SlotEqSpec &want, double when, bool step, std::int64_t nowFrame, double sr) {
  want_ = want;
  reconcile(when, step, nowFrame, sr);
}

void SlotEqChains::reconcile(double when, bool step, std::int64_t nowFrame, double sr) {  // _reconcile
  int ids[kIds];
  const int n = members(ids);
  if (step) {
    const Side &a = sides_[active_];
    bool same = incoming_ < 0 && n == a.count;
    for (int i = 0; same && i < n; ++i) same = ids[i] == a.nodes[i].id;
    bool typeDiff = false;
    for (int i = 0; i < a.count; ++i) {
      const Spec s = eqSpec(a.nodes[i].id);
      // n._web !== eqSpec(...).web (web null for a band set to 'off')
      if (!s.hasWeb || s.web != a.nodes[i].web) typeDiff = true;
    }
    if (!same || typeDiff) {
      ++seq_;  // cancels a pending switch / fade
      dropSide(incoming_);
      dropSide(active_);
      incoming_ = -1;
      dirty_ = false;
      active_ = makeSide(ids, n, 1.0, nowFrame, sr);
    } else {
      applyParams(when, true, nowFrame, sr);
    }
    return;
  }
  if (incoming_ >= 0) {
    dirty_ = true;  // re-checked when the switch has finished
    applyParams(when, false, nowFrame, sr);
    return;
  }
  applyParams(when, false, nowFrame, sr);  // also on a switch: the outgoing chain stays audible for EQ_WARM
  if (needsSwitch(ids, n)) doSwitch(ids, n, when, nowFrame, sr);
}

void SlotEqChains::doSwitch(const int *ids, int n, double when, std::int64_t nowFrame, double sr) {  // _switch
  const std::uint32_t seq = ++seq_;
  const int old = active_;
  const int side = makeSide(ids, n, 0.0, nowFrame, sr);
  if (side < 0) return;
  incoming_ = side;
  ++switches_;
  const double t1 = when + kWarm;
  wa::Param &gi = sides_[side].gain.gain();
  wa::Param &go = sides_[old].gain.gain();
  ctxTime(go, nowFrame, sr);
  wa::linFrom(gi, 0, 1, t1, kXfade);
  wa::linFrom(go, 1, 0, t1, kXfade);
  Timer tm;
  tm.kind = TimerKind::SwitchDone;
  tm.seq = seq;
  tm.side = side;
  tm.oldSide = old;
  at(t1 + kXfade + 0.005, sr, tm);
}

void SlotEqChains::applyParams(double when, bool step, std::int64_t nowFrame, double sr) {  // _applyParams
  const int order[2] = {active_, incoming_};
  for (int si : order) {
    if (si < 0) continue;
    Side &sd = sides_[si];
    for (int i = 0; i < sd.count; ++i) {
      Node &nd = sd.nodes[i];
      const Spec s = eqSpec(nd.id);
      wa::Param &fq = nd.bq.frequency(), &qq = nd.bq.q(), &gg = nd.bq.gain();
      ctxTime(fq, nowFrame, sr);
      ctxTime(qq, nowFrame, sr);
      ctxTime(gg, nowFrame, sr);
      if (s.hasWeb && s.web != nd.webTarget && isIdentity(s.web) && isIdentity(nd.webTarget)) {
        if (step) {
          nd.bq.setType(s.web);
          nd.web = nd.webTarget = s.web;
        } else {
          fadeType(si, i, s.web, when, nowFrame, sr);
        }
      }
      if (s.hz != nd.hz) {
        if (step) wa::setNow(fq, s.hz, when);
        else wa::glideTo(fq, s.hz, when, wa::kTau, nd.hz);
        nd.hz = s.hz;
      }
      // s.Q !== undefined && s.Q !== n._Q && eqUsesQ(n._web) && s.web === n._web
      if (s.hasQ && (!nd.hasQ || s.q != nd.q) && usesQ(nd.web) && s.hasWeb && s.web == nd.web) {
        if (step) wa::setNow(qq, s.q, when);
        else wa::rampTo(qq, s.q, when, wa::kTau);
        nd.q = s.q;
        nd.hasQ = true;
      }
      if (isIdentity(nd.web) && !nd.fading) {
        const double g = s.hasWeb && s.web == nd.web ? (s.hasDb ? s.db : 0) : 0;  // engaged in another type: 0 dB
        if (g != nd.db) {
          if (step) wa::setNow(gg, g, when);
          else wa::rampTo(gg, g, when, wa::kTau);
          nd.db = g;
        }
      }
    }
  }
}

void SlotEqChains::fadeType(int si, int ni, wa::BiquadType web, double when, std::int64_t nowFrame,
                            double sr) {  // _fadeType
  Node &nd = sides_[si].nodes[ni];
  nd.webTarget = web;
  if (nd.fading) return;  // the pending swap reads _webTarget
  nd.fading = true;
  const std::uint32_t seq = nd.fadeSeq = ++fadeSeqs_;  // unique: a dropped chain's slot is reused
  ctxTime(nd.bq.gain(), nowFrame, sr);
  wa::linFrom(nd.bq.gain(), nd.db, 0, when, kTypeFade);
  nd.db = 0;
  Timer tm;
  tm.kind = TimerKind::FadeDone;
  tm.seq = seq;
  tm.side = si;
  tm.node = ni;
  at(when + kTypeFade, sr, tm);
}

void SlotEqChains::at(double t, double sr, Timer tm) {  // AudioTimer.at (offline semantics)
  if (!(t >= 0)) t = 0;
  tm.t = t;
  tm.quantum = static_cast<std::int64_t>(std::ceil(t * sr / 128.0 - 1e-6));
  tm.order = ++order_;
  for (Timer &slot : timers_) {
    if (slot.kind == TimerKind::None) {
      slot = tm;
      return;
    }
  }
  // Full (never in practice: one switch + one fade per node at most): fire at the next quantum.
  timers_[kTimers - 1] = tm;
}

int SlotEqChains::pendingTimers() const {
  int n = 0;
  for (const Timer &t : timers_) n += t.kind != TimerKind::None ? 1 : 0;
  return n;
}

void SlotEqChains::runTimers(std::int64_t frame0, double sr) {
  const std::int64_t q = frame0 / 128;
  const double now = static_cast<double>(frame0) / sr;
  // due timers by (quantum, submission); ones created by a callback that are already due run after them
  for (;;) {
    int best = -1;
    for (int i = 0; i < kTimers; ++i) {
      const Timer &t = timers_[i];
      if (t.kind == TimerKind::None || t.quantum > q) continue;
      if (best < 0 || t.quantum < timers_[best].quantum ||
          (t.quantum == timers_[best].quantum && t.order < timers_[best].order))
        best = i;
    }
    if (best < 0) break;
    const Timer tm = timers_[best];
    timers_[best].kind = TimerKind::None;
    fire(tm, tm.t > now ? tm.t : now, frame0, sr);
  }
}

void SlotEqChains::fire(const Timer &tm, double tt, std::int64_t nowFrame, double sr) {
  if (tm.kind == TimerKind::SwitchDone) {
    if (tm.seq != seq_) return;
    dropSide(tm.oldSide);
    active_ = tm.side;
    incoming_ = -1;
    if (dirty_) {
      dirty_ = false;
      reconcile(tt, false, nowFrame, sr);
    }
    return;
  }
  // FadeDone
  Side &sd = sides_[tm.side];
  if (!sd.used || tm.node >= sd.count) return;
  Node &nd = sd.nodes[tm.node];
  if (nd.dead || tm.seq != nd.fadeSeq) return;
  nd.fading = false;
  if (!isIdentity(nd.webTarget)) return;  // turned into a notch/cut meanwhile: a switch replaces this node
  nd.bq.setType(nd.webTarget);
  nd.web = nd.webTarget;
  const Spec s = eqSpec(nd.id);
  wa::Param &qq = nd.bq.q(), &gg = nd.bq.gain();
  ctxTime(qq, nowFrame, sr);
  ctxTime(gg, nowFrame, sr);
  if (s.hasQ && usesQ(nd.web)) {
    wa::setNow(qq, s.q, tt);
    nd.q = s.q;
    nd.hasQ = true;
  }
  const double g = s.hasWeb && s.web == nd.web ? (s.hasDb ? s.db : 0) : 0;
  if (g != 0) wa::linFrom(gg, 0, g, tt, kTypeFade);
  nd.db = g;
  int ids[kIds];
  const int n = members(ids);
  if (incoming_ < 0 && needsSwitch(ids, n)) reconcile(tt, false, nowFrame, sr);
}

std::size_t SlotEqChains::filters() const {
  return active_ >= 0 ? static_cast<std::size_t>(sides_[active_].count) : 0;
}

void SlotEqChains::process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr) {
  runTimers(frame0, sr);
  nch = nch >= 2 ? 2u : 1u;
  float out[2][wa::Param::kQuantum];
  bool first = true;
  const int order[2] = {active_, incoming_};
  for (int si : order) {
    if (si < 0) continue;
    Side &sd = sides_[si];
    float *x[2] = {scratch_[0], scratch_[1]};
    for (unsigned c = 0; c < nch; ++c) std::memcpy(x[c], ch[c], n * sizeof(float));
    for (int i = 0; i < sd.count; ++i) sd.nodes[i].bq.process(x, nch, n, frame0, sr);
    sd.gain.process(x, x, nch, n, frame0, sr);
    for (unsigned c = 0; c < nch; ++c) {
      if (first) std::memcpy(out[c], x[c], n * sizeof(float));
      else
        for (std::size_t i = 0; i < n; ++i) out[c][i] += x[c][i];
    }
    first = false;
  }
  for (unsigned c = 0; c < nch; ++c) {
    if (first) std::memset(ch[c], 0, n * sizeof(float));
    else std::memcpy(ch[c], out[c], n * sizeof(float));
  }
}

}  // namespace rig
