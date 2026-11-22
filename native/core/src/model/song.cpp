// SongGraph (T13): prepare / commit / reuse / routing / the Model's slot rows. See model/song.h; JS references are
// app/js/engine/audio.js line numbers.
#include "model/song.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "bridge/json_out.h"
#include "fx/reverb_service.h"
#include "inst/instrument_service.h"
#include "inst/organ.h"  // T15 review item 2: OrganOp
#include "inst/sampler.h"
#include "inst/synth.h"
#include "mix/slot_channel.h"
#include "mix/slot_channel_api.h"
#include "model/model.h"
#include "model/perform.h"  // T14
#include "num/js_math.h"
#include "params/params.h"
#include "samples/cache_service.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig {
namespace {

double lerp(double a, double b, double x) {
  return a + (b - a) * x;
}
double clamp01(double x) {
  return std::isfinite(x) ? std::min(1.0, std::max(0.0, x)) : 0.0;
}

/** audio.js isSongKey: pending coalesced song-state writes a commit drops (round3-eq M1). */
bool isSongKey(std::string_view k) {
  return k.rfind("slots.", 0) == 0 || k.rfind("fx.", 0) == 0 || k.rfind("master.", 0) == 0;
}

/** audio.js validTarget: a wheel target the engine knows (slots 0..15 natively, D3). */
bool validTarget(std::string_view t) {
  static const char *const kTargets[] = {"drone.gain", "fx.reverb.returnGain", "master.volume", "macro.intensity",
                                         "macro.wash", "none"};
  for (const char *k : kTargets)
    if (t == k) return true;
  if (t.rfind("slots.", 0) != 0 || !t.ends_with(".gain")) return false;
  const std::string_view n = t.substr(6, t.size() - 11);
  if (n.empty() || n.size() > 2 || !std::all_of(n.begin(), n.end(), [](char ch) { return ch >= '0' && ch <= '9'; }))
    return false;
  const int i = std::atoi(std::string(n).c_str());
  return (n.size() == 1 || n[0] != '0') && i < kMaxSlots;
}

/** audio.js PAD_LIKE: instruments whose morph follows macro.intensity. */
bool padLike(std::string_view type, std::string_view id) {
  static const char *const kPads[][2] = {{"synth", "warm-pad"},  {"synth", "glass-pad"},  {"synth", "strings"},
                                          {"synth", "supersaw-pad"}, {"synth", "juno-pad"}, {"synth", "shimmer-pad"},
                                          {"organ", "soft-pad"}};
  for (const auto &p : kPads)
    if (type == p[0] && id == p[1]) return true;
  return false;
}

/** shared/touch-curve.js pedalCurve. */
double pedalCurve(double x, bool log) {
  if (!log) return x;
  const double c = x > 1 ? 1 : x > 0 ? x : 0;
  return (js::pow(10.0, 2.0 * c) - 1) / (js::pow(10.0, 2.0) - 1);
}

/** audio.js sameVal for numeric params (booleans arrive as 0/1). */
bool sameVal(double a, double b) {
  if (a == b) return true;
  if (std::isfinite(a) && std::isfinite(b)) return std::fabs(a - b) <= 1e-9 * std::max(1.0, std::fabs(a));
  return false;
}

/** Value of `key` in a params JSON object text, else `def`. */
double paramOf(const std::string &json, std::string_view key, double def, bool *found = nullptr) {
  if (found) *found = false;
  yyjson_doc *doc = yyjson_read(json.data(), json.size(), 0);
  double v = def;
  if (yyjson_val *root = doc ? yyjson_doc_get_root(doc) : nullptr; root && yyjson_is_obj(root)) {
    const std::string k(key);
    if (yyjson_val *x = yyjson_obj_get(root, k.c_str())) {
      if (yyjson_is_num(x)) v = yyjson_get_num(x);
      else if (yyjson_is_bool(x)) v = yyjson_get_bool(x) ? 1.0 : 0.0;
      if (found) *found = yyjson_is_num(x) || yyjson_is_bool(x);
    }
  }
  yyjson_doc_free(doc);
  return v;
}

Command paramCmd(Op op, std::uint32_t target, double a, double b, double c) {
  Command cmd{};
  cmd.op = op;
  cmd.frame = kFrameNow;
  cmd.target = target;
  cmd.f.a = a;
  cmd.f.b = b;
  cmd.f.c = c;
  return cmd;
}

}  // namespace

double Move::at(double t) const {  // fx.js moveAt
  if (t <= t0) return from;
  if (tc > 0) return t >= t0 + 12 * tc ? to : to + (from - to) * js::exp(-(t - t0) / tc);
  if (!(dur > 0) || t >= t0 + dur) return to;
  return from + (to - from) * ((t - t0) / dur);
}

double SongGraph::tOf(double when) const {
  const double now = m_.now();
  return std::isfinite(when) && when > now ? when : now;
}

SongGraph::SongGraph(Model &m)
    : m_(m), co_([&m](double at, std::function<void(double)> fn) { m.sink().at(at, std::move(fn)); }, 0.01) {
  for (std::int64_t &f : slotFrame_) f = kFrameNow;
}

void SongGraph::gate(Command &c, std::int64_t now) {
  const std::int64_t f = c.frame == kFrameNow ? now : c.frame;
  switch (c.op) {
    case Op::AttachUnit:
    case Op::DetachUnit:
      if (c.target < kUnitSlots) slotFrame_[c.target] = std::max(slotFrame_[c.target], f);
      return;
    case Op::MoveUnit:
      if (c.target < kUnitSlots) slotFrame_[c.target] = std::max(slotFrame_[c.target], f);
      if (c.aux < kUnitSlots) slotFrame_[c.aux] = std::max(slotFrame_[c.aux], f);
      return;
    case Op::ParamSet:
    case Op::ParamLinear:
    case Op::ParamExp:
    case Op::ParamTarget:
    case Op::ParamCancelHold: {
      const auto u = static_cast<std::size_t>(paramUnit(c.target));
      if (u < kUnitSlots && slotFrame_[u] > now && f < slotFrame_[u]) c.frame = slotFrame_[u];
      return;
    }
    default:
      if (c.target < kUnitSlots && slotFrame_[c.target] > now && f < slotFrame_[c.target])
        c.frame = slotFrame_[c.target];
      return;
  }
}

SongGraph::~SongGraph() {
  if (plan_) discard(*plan_);
}

// ---- routing and wheels (audio.js _routingInto, _factorFor, _macro, _slotWheelFactor, _morphFor) ---------------

void SongGraph::mergeRouting(const yyjson_val *rv, Routing &r) {
  // audio.js _routingInto (sub-objects merged, an invalid target keeps the old one); normalizePatch is the same over
  // the defaults
  yyjson_val *root = const_cast<yyjson_val *>(rv);
  if (!root || !yyjson_is_obj(root)) return;
  auto wheel = [&](const char *k, Routing::Wheel &w) {
    yyjson_val *o = yyjson_obj_get(root, k);
    if (!o || !yyjson_is_obj(o)) return;
    yyjson_val *t = yyjson_obj_get(o, "target");
    if (t && yyjson_is_str(t) && validTarget(yyjson_get_str(t))) w.target = yyjson_get_str(t);
    yyjson_val *mn = yyjson_obj_get(o, "min"), *mx = yyjson_obj_get(o, "max"), *cv = yyjson_obj_get(o, "curve");
    if (mn) w.min = yyjson_is_num(mn) ? clamp01(yyjson_get_num(mn)) : 0.0;  // clamp01(Number(x) || 0)
    if (mx) w.max = yyjson_is_num(mx) ? clamp01(yyjson_get_num(mx)) : 0.0;
    w.logCurve = cv && yyjson_is_str(cv) && std::strcmp(yyjson_get_str(cv), "log") == 0;  // absent = linear
  };
  wheel("modWheel", r.mod);
  wheel("expression", r.expr);
  if (yyjson_val *o = yyjson_obj_get(root, "volume"); o && yyjson_is_obj(o)) {
    yyjson_val *t = yyjson_obj_get(o, "target");
    if (t && yyjson_is_str(t) && validTarget(yyjson_get_str(t))) r.volTarget = yyjson_get_str(t);
  }
  if (yyjson_val *o = yyjson_obj_get(root, "bend"); o && yyjson_is_obj(o)) {
    yyjson_val *md = yyjson_obj_get(o, "mode"), *rg = yyjson_obj_get(o, "range");
    if (md && yyjson_is_str(md)) {
      const std::string_view s = yyjson_get_str(md);
      r.bendMode = s == "pitch" || s == "morph" || s == "drone-swell" || s == "tape" || s == "none" ? s : "pitch";
    }
    if (rg) {
      const double x = yyjson_is_num(rg) && yyjson_get_num(rg) != 0 ? yyjson_get_num(rg) : 2.0;
      r.bendRange = std::min(24.0, std::max(0.0, x));
    }
  }
  if (yyjson_val *o = yyjson_obj_get(root, "swell"); o && yyjson_is_obj(o)) {  // swellOf: replaced
    yyjson_val *sv = yyjson_obj_get(o, "seconds"), *pv = yyjson_obj_get(o, "pedal");
    const double sec = sv && yyjson_is_num(sv) && yyjson_get_num(sv) != 0 ? yyjson_get_num(sv) : 8.0;
    r.swellSeconds = std::min(60.0, std::max(0.5, sec));
    r.swellPedal = pv && yyjson_is_true(pv);
  }
}

void SongGraph::parseRouting(const std::string &json, Routing &r) {
  r = Routing{};
  yyjson_doc *doc = yyjson_read(json.data(), json.size(), 0);
  if (doc) mergeRouting(yyjson_doc_get_root(doc), r);
  yyjson_doc_free(doc);
}

void SongGraph::setRouting(const yyjson_val *r, double when) {
  // audio.js setRouting: merge, neutral bend on a mode change (T14), wheels tau 30 ms, pedal swell sync (T14)
  mergeRouting(r, routing_);
  applyWheels(tOf(when), 0.03);
}

std::optional<double> SongGraph::macro(std::string_view name) const {
  const Routing &R = routing_;
  std::optional<double> x;
  if (R.mod.target == name) x = lerp(R.mod.min, R.mod.max, wheel_.mod);
  if (R.expr.target == name) x = x.value_or(1) * lerp(R.expr.min, R.expr.max, pedalCurve(wheel_.expr, R.expr.logCurve));
  if (R.volTarget == name) x = x.value_or(1) * wheel_.vol;
  return x;
}

double SongGraph::factorFor(std::string_view target) const {
  const Routing &R = routing_;
  double f = 1;
  if (R.mod.target == target) f *= lerp(R.mod.min, R.mod.max, wheel_.mod);
  if (R.expr.target == target) f *= lerp(R.expr.min, R.expr.max, pedalCurve(wheel_.expr, R.expr.logCurve));
  if (R.volTarget == target) f *= wheel_.vol;
  return f;
}

double SongGraph::slotWheelFactor(int slot) const {
  double f = factorFor("slots." + std::to_string(slot) + ".gain");
  const std::optional<double> I = macro("macro.intensity");
  if (I && slot == 1) f *= lerp(0.35, 1, *I);  // audio.js: the Pad slot (1); D3 keeps slot 1 as the web engine's
  return f;
}

double SongGraph::morphFor(const Channel &c) const {
  const std::optional<double> I = macro("macro.intensity");
  const double bendMorph = performBendMorph(m_);  // T14: routing bend 'morph' x |bend| (the bend lives in perform)
  const bool pad = padLike(c.cfg.instType, c.cfg.instId);
  return std::max(bendMorph, pad && I ? *I : 0.0);
}

// ---- prepare ------------------------------------------------------------------------------------------------------

bool SongGraph::paramsMatch(const SlotPatch &have, const SlotPatch &want) const {
  const inst::CatalogueEntry *e = inst::findCatalogue(want.instType, want.instId);
  if (!e) return have.paramsJson == want.paramsJson;  // no metas (test voice, user samplers): the params text decides
  for (const inst::CatalogueParam &p : e->params) {
    const double w = std::min(p.max, std::max(p.min, paramOf(want.paramsJson, p.key, p.def)));
    const double h = std::min(p.max, std::max(p.min, paramOf(have.paramsJson, p.key, p.def)));
    if (!sameVal(h, w)) return false;
  }
  return true;
}

std::uint32_t SongGraph::prepare(PatchSpec &&patch, std::uint32_t token) {
  latestToken_ = token;  // a new token supersedes every older one (only the latest can commit)
  if (plan_) {
    discard(*plan_);
    plan_.reset();
  }
  auto plan = std::make_unique<Plan>();
  plan->token = token;
  plan->patch = std::move(patch);
  parseRouting(plan->patch.routingJson, plan->routing);
  // v11-memory switch headroom: while the new song decodes next to the playing one, these two songs' buffers stay
  if (auto *cs = dynamic_cast<samples::CacheServiceImpl *>(m_.service<CacheService>()))
    cs->protectSwitch(&m_.active_, &plan->patch);
  // the reverb space for the new song, staged now (realtime: built on the IR worker while the old song plays). The
  // size is the EFFECTIVE one (T14: lerp(size, .9, wash) under the new routing at the current wheel values); while
  // keys are held or pedalled (realtime) a space not built yet is built at the next pause (audio.js prepare)
  if (!m_.attachedKind(UnitSlot::Reverb).empty())
    if (auto *rp = dynamic_cast<fx::ReverbPool *>(m_.service<ReverbService>())) {
      const rig_config *cfg = m_.env().config;
      const bool offline = !cfg || cfg->mode == RIG_MODE_OFFLINE;
      rp->stage(m_.perform().stageReverbSize(plan->routing, plan->patch.reverb.size), plan->patch.reverb.damp,
                m_.perform().playing() && !offline);
    }
  for (int i = 0; i < kMaxSlots; ++i) {
    const SlotPatch &s = plan->patch.slots[i];
    PlanSlot &ps = plan->slots[i];
    const Channel &cur = slots_[i];
    if (!slotUsed(s)) continue;
    // same instrument with the same effective params -> keep the instance (audio.js:617)
    if (cur.live && cur.cfg.instType == s.instType && cur.cfg.instId == s.instId &&
        paramsMatch(m_.active_.slots[i], s)) {
      ps.kind = PlanSlot::Reuse;
      ps.reuseId = cur.id;
      continue;
    }
    ps.built = build(plan->patch, i);
    ps.kind = ps.built.inst ? PlanSlot::Fresh : PlanSlot::None;
  }
  plan_ = std::move(plan);
  return token;
}

// ---- commit -------------------------------------------------------------------------------------------------------

void SongGraph::sendParamOps(UnitSlot u, std::uint32_t index, std::initializer_list<Command> cmds) {
  const std::uint32_t target = paramTarget(u, index);
  for (Command c : cmds) {
    c.target = target;
    m_.send(c);
  }
}

void SongGraph::faderMove(Channel &c, double to, double when, double glide, double fallback) {
  // fx.js trackedMove: glide > 0 = linFrom (setNow(from) + linearTo with {from}), else rampTo(tau 15 ms)
  const double t = tOf(when);
  (void)fallback;  // fx.js moveAt(m, t, fallback): every live channel has a recorded move (its commit set / ramp)
  const double from = c.fader.at(t);
  const UnitSlot u = stripSlot(static_cast<std::size_t>(c.slot));
  if (glide > 0) {
    sendParamOps(u, kStripFader,
                 {paramCmd(Op::ParamCancelHold, 0, 0, t, 0), paramCmd(Op::ParamSet, 0, from, t, 0),
                  paramCmd(Op::ParamCancelHold, 0, 0, t, 0), paramCmd(Op::ParamSet, 0, from, t, 0),
                  paramCmd(Op::ParamLinear, 0, to, t + glide, 0)});
    c.fader = Move{from, to, t, glide, 0};
  } else {
    sendParamOps(u, kStripFader,
                 {paramCmd(Op::ParamCancelHold, 0, 0, t, 0), paramCmd(Op::ParamTarget, 0, to, t, wa::kTau),
                  paramCmd(Op::ParamSet, 0, to, t + wa::kRampSettleTc * wa::kTau, 0)});
    c.fader = Move{from, to, t, 0, wa::kTau};
  }
  m_.tracked_[paramTarget(u, kStripFader)] = to;
}

void SongGraph::sendInstParam(const Channel &c, std::uint32_t index, double v, double t) {
  Command cmd{};
  cmd.op = Op::InstParam;
  cmd.aux = index;
  cmd.f.a = v;
  cmd.f.b = t;
  cmd.f.c = 0;
  m_.sendUnitOp(instSlot(static_cast<std::size_t>(c.slot)), cmd, -1.0);
}

void SongGraph::sendRelease(const Channel &c, double release, double when) {
  Command cmd{};
  if (c.kind == inst::kKindSynth) cmd.op = opOf(inst::SynthOp::ReleaseOverride);
  else if (c.kind == kKindSampler) cmd.op = opOf(SamplerOp::ReleaseOverride);
  else if (c.kind == inst::kKindOrgan) cmd.op = opOf(inst::OrganOp::ReleaseOverride);  // T15 review item 2 (W3B)
  else return;
  cmd.f.a = std::isfinite(release) && release > 0 ? release : 0;
  const UnitSlot u = c.retire >= 0 ? retireInstSlot(static_cast<std::size_t>(c.retire))
                                   : instSlot(static_cast<std::size_t>(c.slot));
  m_.sendUnitOp(u, cmd, when);
}

void SongGraph::applyFresh(Channel &c, double when) {
  // audio.js _applySlotCfg(fresh): nothing sounds on a fresh channel yet, so steps are inaudible. Pan, sends, width
  // and EQ come with the strip (built from this cfg); the fader is SET at the commit instant (contract 3.1).
  const UnitSlot s = stripSlot(static_cast<std::size_t>(c.slot));
  const double t = tOf(when);
  m_.setParamAt(s, kStripFader, c.cfg.gain, when);
  m_.setParamAt(s, kStripPan, c.cfg.pan, when);
  c.fader = Move{c.cfg.gain, c.cfg.gain, t, 0, 0};
  // REVIEW #11: a fresh strip starts at the current wheel factor (wheel 0 -> a silent first note, no blip)
  c.wheel = slotWheelFactor(c.slot);
  if (c.wheel != 1.0) m_.setParamAt(s, kStripWheel, c.wheel, when);
  // instruments contract #12: the current morph reaches a fresh instrument (it starts at 0)
  const double mo = morphFor(c);
  if (mo != c.morph) {
    Command cmd{};
    if (c.kind == inst::kKindSynth) cmd.op = opOf(inst::SynthOp::Morph);
    else if (c.kind == kKindSampler) cmd.op = opOf(SamplerOp::Morph);
    else if (c.kind == inst::kKindOrgan) cmd.op = opOf(inst::OrganOp::Morph);  // T15 review item 2 (W3B)
    if (cmd.op != Op::None) {
      cmd.f.a = mo;
      cmd.f.b = t;
      m_.sendUnitOp(instSlot(static_cast<std::size_t>(c.slot)), cmd, when);
    }
    c.morph = mo;
  }
}

void SongGraph::applyReused(Channel &c, const SlotPatch &cfg, const SlotPatch &prev, double when) {
  // audio.js _applySlotCfg(reused): every row ramps to the new song's value, every instrument param to the song's
  // value or its default (no leak from the previous song, REVIEW #1)
  const auto i = static_cast<std::size_t>(c.slot);
  const UnitSlot s = stripSlot(i);
  const double t = tOf(when);
  c.cfg = cfg;
  faderMove(c, cfg.gain, when, 0, prev.gain);
  m_.moveParam(s, kStripPan, cfg.pan, when, 0);
  if (auditioned(c.slot)) {
    // T02 #2: a commit ends the EQ audition. One SlotEq.set with the new EQ (as JS: _eqBypass.clear(); setEq): the
    // stored EQ first (silent), then 'on', which sets the stored EQ
    sendSlotEqStored(m_, c.slot, cfg.spec.eq);
    Command a{};
    a.op = opOf(StripOp::EqAudition);
    a.aux = 0;
    a.f.b = t;
    m_.sendUnitOp(s, a, -1.0);
  } else {
    sendSlotEq(m_, c.slot, cfg.spec.eq, t);
  }
  for (unsigned k = 0; k < kSendBuses; ++k) m_.moveParam(s, kStripSendReverb + k, cfg.sends[k], when, 0);
  if (c.hasInst) {
    if (const inst::CatalogueEntry *e = inst::findCatalogue(cfg.instType, cfg.instId)) {
      for (std::size_t k = 0; k < e->params.size(); ++k) {
        const inst::CatalogueParam &p = e->params[k];
        const double w = std::min(p.max, std::max(p.min, paramOf(cfg.paramsJson, p.key, p.def)));
        const double h = std::min(p.max, std::max(p.min, paramOf(prev.paramsJson, p.key, p.def)));
        if (!sameVal(h, w)) sendInstParam(c, static_cast<std::uint32_t>(k), w, t);
      }
    }
    // W3A T13 review O3: _applySlotCfg's second loop, cfg.params keys with no meta (instruments outside the
    // catalogue: `user:` samplers) sent when they differ from the previous song's (`prev.params[k] !== v`)
    const inst::CatalogueEntry *e = inst::findCatalogue(cfg.instType, cfg.instId);
    if (yyjson_doc *doc = yyjson_read(cfg.paramsJson.data(), cfg.paramsJson.size(), 0)) {
      yyjson_val *root = yyjson_doc_get_root(doc), *k = nullptr, *v = nullptr;
      yyjson_obj_iter it;
      if (root && yyjson_obj_iter_init(root, &it))
        while ((k = yyjson_obj_iter_next(&it))) {
          v = yyjson_obj_iter_get_val(k);
          const std::string_view key(yyjson_get_str(k), yyjson_get_len(k));
          if (e && std::any_of(e->params.begin(), e->params.end(), [&](const auto &p) { return p.key == key; }))
            continue;  // a meta: the first loop
          if (!yyjson_is_num(v) && !yyjson_is_bool(v)) continue;
          const double raw = yyjson_is_num(v) ? yyjson_get_num(v) : (yyjson_get_bool(v) ? 1.0 : 0.0);
          bool had = false;
          const double was = paramOf(prev.paramsJson, key, NAN, &had);
          if (had && was == raw) continue;
          double w = raw;
          const int idx = inst::resolveInstrumentParam(cfg, key, w);
          if (idx >= 0) sendInstParam(c, static_cast<std::uint32_t>(idx), w, t);
        }
      yyjson_doc_free(doc);
    }
    if (prev.bendEnabled && !cfg.bendEnabled) {
      Command b{};
      b.op = Op::Bend;
      b.f.a = 0;
      m_.sendUnitOp(instSlot(i), b, when);
    }
    const bool relPrev = std::isfinite(prev.release), relNow = std::isfinite(cfg.release);
    if (relPrev != relNow || (relNow && prev.release != cfg.release)) sendRelease(c, cfg.release, when);
  }
}

void SongGraph::applyWheels(double t, double tc) {
  // audio.js _applyWheels: the strips' wheel gains (rampTo tc) and the morph; FX / drone / master wheels: T14
  for (int i = 0; i < kMaxSlots; ++i) {
    Channel &c = slots_[i];
    if (!c.live) continue;
    const double f = slotWheelFactor(i);
    if (f != c.wheel) {
      sendParamOps(stripSlot(static_cast<std::size_t>(i)), kStripWheel,
                   {paramCmd(Op::ParamCancelHold, 0, 0, t, 0), paramCmd(Op::ParamTarget, 0, f, t, tc),
                    paramCmd(Op::ParamSet, 0, f, t + wa::kRampSettleTc * tc, 0)});
      c.wheel = f;
    }
    const double mo = c.hasInst ? morphFor(c) : 0.0;
    if (mo != c.morph) {
      Command cmd{};
      if (c.kind == inst::kKindSynth) cmd.op = opOf(inst::SynthOp::Morph);
      else if (c.kind == kKindSampler) cmd.op = opOf(SamplerOp::Morph);
      else if (c.kind == inst::kKindOrgan) cmd.op = opOf(inst::OrganOp::Morph);  // T15 review item 2 (W3B)
      if (cmd.op != Op::None) {
        cmd.f.a = mo;
        cmd.f.b = t;
        m_.sendUnitOp(instSlot(static_cast<std::size_t>(i)), cmd, -1.0);
      }
      c.morph = mo;
    }
  }
}

bool SongGraph::commit(std::uint32_t token, double when) {
  if (!plan_ || plan_->token != token || token != latestToken_) return false;  // stale / superseded / committed
  std::unique_ptr<Plan> plan = std::move(plan_);
  const double t = tOf(when);
  // round3-eq M1: pending coalesced song writes captured the old song's values and channels
  co_.cancelAll(isSongKey);
  routing_ = plan->routing;  // the new routing first (state only): fresh strips start at their real wheel factor
  int reused[kMaxSlots];
  int nReused = 0;
  for (int i = 0; i < kMaxSlots; ++i) {
    Channel &cur = slots_[i];
    PlanSlot &ps = plan->slots[i];
    if (ps.kind == PlanSlot::None) {
      if (cur.live) retire(i, when);
      continue;
    }
    if (ps.kind == PlanSlot::Reuse) {
      if (cur.live && cur.id == ps.reuseId) {
        applyReused(cur, plan->patch.slots[i], m_.active_.slots[i], when);
        reused[nReused++] = i;
        ++n_.reused;
      } else if (cur.live) {
        retire(i, when);  // the channel we planned to reuse is gone (restart in between): the slot stays empty
      }
      continue;
    }
    if (cur.live) retire(i, when);
    BuiltChannel b = ps.built;
    ps.built = BuiltChannel{};
    const auto ui = static_cast<std::size_t>(i);
    Channel c;
    c.id = nextChannelId_++;
    c.slot = i;
    c.cfg = plan->patch.slots[i];
    c.kind = b.kind;
    c.shell = b.inst;
    c.hasInst = attachBuilt(instSlot(ui), b.kind, b.inst, when, i);
    if (!c.hasInst) c.shell = nullptr;
    if (b.strip && !attachBuilt(stripSlot(ui), kKindStrip, b.strip, when, i)) b.strip = nullptr;
    c.live = c.hasInst || b.strip;
    if (!c.live) continue;
    slots_[i] = std::move(c);
    if (b.strip) applyFresh(slots_[i], when);
  }
  m_.active_ = std::move(plan->patch);
  bypass_ = 0;  // an EQ A/B compare never outlives its song
  ++m_.stats_.commits;
  m_.committedAny_ = true;
  m_.ensureGlobalUnits(when);
  m_.forEachService([&](Service &s) { s.onCommit(m_.active_, when); });
  // After the services (the sampler steps its widthDefault at `when`): a reused strip RAMPS to the new song's width
  // (audio.js s.setWidth(eff, t); T12 O2). Strips are reused only with their own instrument, so widthDefault is
  // unchanged and the sampler's step is to the value the strip already has.
  for (int k = 0; k < nReused; ++k) {
    const int i = reused[k];
    Command w{};
    w.op = opOf(StripOp::SetSlotWidth);
    w.f.a = m_.active_.slots[i].width;
    w.f.b = t;
    m_.sendUnitOp(stripSlot(static_cast<std::size_t>(i)), w, when);
  }
  applyWheels(t, 0.03);
  return true;
}

// ---- the Model's slot rows (audio.js _setSlotParam) ---------------------------------------------------------------

bool SongGraph::setSlotRow(const ParamRow &row, int slot, double v, double glide, double when, double prevGain) {
  const std::string_view rp(row.path);
  const std::string_view key = rp.substr(std::string_view("slots.<i>.").size());
  Channel &c = slots_[slot];
  if (key == "gain") {
    if (!c.live) return true;  // stored; applied by the next commit
    const std::uint32_t id = c.id;
    const std::string path = "slots." + std::to_string(slot) + ".gain";
    co_.push(path, tOf(when), [this, slot, id, v, glide, prevGain](double tt) {
      Channel &ch = slots_[slot];
      if (ch.live && ch.id == id) faderMove(ch, v, tt, glide > 0 ? glide : 0, prevGain);
    });
    return true;
  }
  if (key == "bendEnabled") {
    if (c.live && c.hasInst && v == 0.0) {  // false -> inst.setBend(0)
      Command b{};
      b.op = Op::Bend;
      b.f.a = 0;
      m_.sendUnitOp(instSlot(static_cast<std::size_t>(slot)), b, when);
    } else if (v != 0.0) {
      m_.perform().bendEnabled(slot, when);  // T14: true in pitch mode -> inst.setBend(bend * range)
    }
    return true;
  }
  if (key == "release") {  // read at release: every later note-off of the slot's instrument (contract 2.3)
    if (c.live && c.hasInst) sendRelease(c, v, when);
    return true;
  }
  // octave / transpose / lowNote / highNote / sustain / mono / velocityCurve / touch.* / pedalHold: read at the next
  // noteOn / noteOff
  return key == "octave" || key == "transpose" || key == "lowNote" || key == "highNote" || key == "sustain" ||
         key == "mono" || key == "velocityCurve" || key.rfind("touch.", 0) == 0 || key == "pedalHold";
}

bool SongGraph::eqAudition(int slot, std::string_view mode, double when) {
  if (slot < 0 || slot >= kMaxSlots) return false;
  const bool bypass = mode == "bypass";
  if (bypass == auditioned(slot)) return true;
  if (bypass) bypass_ |= 1u << slot;
  else bypass_ &= ~(1u << slot);
  const UnitSlot s = stripSlot(static_cast<std::size_t>(slot));
  if (!slots_[slot].live || !m_.attachedIsModule(s)) return true;
  Command c{};
  c.op = opOf(StripOp::EqAudition);
  c.aux = bypass ? 1u : 0u;
  // INTERFACE-CHANGE(T02): applied at call time with `when` as the automation time (audio.js eqAudition runs
  // SlotEq.set(eq, when) when called, like every other EQ write)
  c.f.b = when >= 0.0 ? when : -1.0;
  m_.sendUnitOp(s, c, -1.0);
  return true;
}

double SongGraph::setDynamicRange(double range) {
  // shared/touch-curve.js validDynRange (?? 1): 1..3, rounded to 0.01
  dynRange_ = std::isfinite(range) ? std::floor(std::min(3.0, std::max(1.0, range)) * 100 + 0.5) / 100 : 1.0;
  auto send = [&](UnitSlot u) {
    if (m_.attachedKind(u) != kKindSampler) return;
    Command c{};
    c.op = opOf(SamplerOp::DynamicRange);
    c.f.a = dynRange_;
    m_.sendUnitOp(u, c, -1.0);
  };
  for (std::size_t i = 0; i < kChannels; ++i) send(instSlot(i));
  for (std::size_t j = 0; j < kRetiring; ++j) send(retireInstSlot(j));
  return dynRange_;
}

// ---- queries ------------------------------------------------------------------------------------------------------

UnitSlot SongGraph::instUnitOf(std::uint32_t id) const {
  if (id == 0) return UnitSlot::Count;
  for (int i = 0; i < kMaxSlots; ++i)
    if (slots_[i].live && slots_[i].id == id) return slots_[i].hasInst ? instSlot(static_cast<std::size_t>(i))
                                                                       : UnitSlot::Count;
  for (int j = 0; j < static_cast<int>(kRetiring); ++j)
    if (retiring_[j].live && retiring_[j].id == id)
      return retiring_[j].hasInst ? retireInstSlot(static_cast<std::size_t>(j)) : UnitSlot::Count;
  return UnitSlot::Count;
}

const Channel *SongGraph::channelById(std::uint32_t id) const {
  if (id == 0) return nullptr;
  for (const Channel &c : slots_)
    if (c.live && c.id == id) return &c;
  for (const Channel &c : retiring_)
    if (c.live && c.id == id) return &c;
  return nullptr;
}

std::string SongGraph::instIdAt(UnitSlot u) const {
  const auto v = static_cast<std::size_t>(u);
  if (isInstSlot(u)) return slots_[v].live && slots_[v].hasInst ? slots_[v].cfg.instId : std::string();
  if (isRetireInstSlot(u)) {
    const Channel &c = retiring_[v - static_cast<std::size_t>(UnitSlot::RetireInst0)];
    return c.live && c.hasInst ? c.cfg.instId : std::string();
  }
  return {};
}

void SongGraph::onRateChanged(double sampleRate, double oldRate) {
  if (oldRate > 0 && oldRate != sampleRate)  // Graph::adoptRate: frame' = ceil(frame * new / old)
    for (std::int64_t &f : slotFrame_)
      if (f != kFrameNow)
        f = static_cast<std::int64_t>(std::ceil(static_cast<double>(f) * sampleRate / oldRate - 1e-9));
  // T13 review: a pending plan's units were built at prepare for the old rate (synth.js wavetables, sampler / FX
  // state sized per rate) and nothing re-points an unattached unit: rebuild its fresh channels at the new rate
  if (plan_ && sampleRate != oldRate)
    for (int i = 0; i < kMaxSlots; ++i) {
      PlanSlot &ps = plan_->slots[i];
      if (ps.kind != PlanSlot::Fresh) continue;
      delete ps.built.inst;
      delete ps.built.strip;
      ps.built = build(plan_->patch, i, sampleRate);
      ps.kind = ps.built.inst ? PlanSlot::Fresh : PlanSlot::None;
    }
  // T11 O3: InstrumentService re-points Inst0..15; the retiring synth.js instruments get the new rate's tables here
  // (never synth-extra units, which share kind inst.synth)
  for (std::size_t j = 0; j < kRetiring; ++j) {
    const Channel &c = retiring_[j];
    if (!c.live || c.kind != inst::kKindSynth || !inst::findPatch(c.cfg.instId)) continue;
    auto *w = new inst::WavesPayload();
    w->bank = inst::WaveBank::get(sampleRate, inst::synthWaveFamilies(c.cfg.instId));
    m_.sendOwned(retireInstSlot(j), opOf(inst::SynthOp::SetWaves), w, -1.0);
  }
}

void SongGraph::statsFields(std::string &out) const {
  out += ",\"retiring\":" + std::to_string(retiringCount()) + ",\"channelsBuilt\":" + std::to_string(n_.built) +
         ",\"channelsReused\":" + std::to_string(n_.reused) + ",\"channelsRetired\":" + std::to_string(n_.retired) +
         ",\"channelsDisposed\":" + std::to_string(n_.disposed) + ",\"plansDiscarded\":" +
         std::to_string(n_.discarded) + ",\"retireForced\":" + std::to_string(n_.forcedRetire);
}

void SongGraph::stateFields(JsonOut &j) const {
  j.key("routing").begin();
  auto wheel = [&](const char *k, const Routing::Wheel &w) {
    j.key(k).begin().kv("target", w.target).kv("min", w.min).kv("max", w.max);
    if (w.logCurve) j.kv("curve", "log");
    j.end();
  };
  wheel("modWheel", routing_.mod);
  wheel("expression", routing_.expr);
  j.key("volume").begin().kv("target", routing_.volTarget).end();
  j.key("bend").begin().kv("mode", routing_.bendMode).kv("range", routing_.bendRange).end();
  j.key("swell").begin().kv("seconds", routing_.swellSeconds);
  if (routing_.swellPedal) j.kvBool("pedal", true);
  j.end();
  j.end();
  j.kv("retiring", retiringCount()).kv("dynamicRange", dynRange_);
}

}  // namespace rig
