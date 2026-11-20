// "sampler" service: see sampler_service.h. JS counterparts: SamplerInstrument constructor + _load
// (app/js/engine/sampler.js), AudioEngine._effWidth (app/js/engine/audio.js).
#include "inst/sampler_service.h"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <utility>

#include "mix/slot_channel_api.h"
#include "model/model.h"
#include "model/patch.h"
#include "samples/cache_service.h"
#include "yyjson.h"

namespace rig {
namespace {

std::mutex gEnvMu;
std::vector<std::pair<const UnitEnv *, SamplerService *>> gEnvs;  // one entry per live Model

/** SamplerInstrument constructor: params[key] = Number(initial) clamped into [min, max], else the default. */
double initialParam(yyjson_val *obj, const char *key, double dflt, double lo, double hi) {
  yyjson_val *v = obj ? yyjson_obj_get(obj, key) : nullptr;
  if (!v) return dflt;
  double x;
  if (yyjson_is_num(v)) x = yyjson_get_num(v);
  else if (yyjson_is_bool(v)) x = yyjson_get_bool(v) ? 1 : 0;
  else if (yyjson_is_null(v)) x = 0;  // Number(null) === 0
  else return dflt;
  return std::isfinite(x) ? std::min(hi, std::max(lo, x)) : dflt;
}

}  // namespace

struct SamplerService::Load {
  struct Entry {
    std::size_t layer = 0;
    int midi = 60;
    std::string key;
    const SampleBuffer *buf = nullptr;  // carries one cache reference (requestJob takeRef)
  };
  std::uint32_t instSeq = 0;
  int channel = 0;
  int pending = 0;
  bool issued = false, cancelled = false;
  std::string name;
  std::vector<std::pair<int, int>> layers;  // lo, hi (def order: sorted by lo)
  std::vector<Entry> entries;
};

SamplerService::SamplerService(Model &m) : m_(m), leases_(std::make_shared<SamplerLeases>(nullptr)) {
  std::lock_guard<std::mutex> lk(gEnvMu);
  gEnvs.emplace_back(&m.env(), this);
}

SamplerService::~SamplerService() {
  {
    std::lock_guard<std::mutex> lk(gEnvMu);
    gEnvs.erase(std::remove_if(gEnvs.begin(), gEnvs.end(), [this](const auto &e) { return e.second == this; }),
                gEnvs.end());
  }
  for (auto &ld : loads_) {
    ld->cancelled = true;
    for (auto &e : ld->entries) leases_->release(e.buf);
  }
  loads_.clear();
  leases_->detach();  // tables of units the graph deletes after the Model must not touch the cache any more
}

SamplerService *SamplerService::forEnv(const UnitEnv *env) {
  std::lock_guard<std::mutex> lk(gEnvMu);
  for (const auto &e : gEnvs)
    if (e.first == env) return e.second;
  return nullptr;
}

samples::CacheServiceImpl *SamplerService::cacheService() {
  auto *cs = dynamic_cast<samples::CacheServiceImpl *>(m_.service(CacheService::kName));
  if (cs && !leases_->cache()) leases_ = std::make_shared<SamplerLeases>(&cs->cache());
  return cs;
}

const samples::SamplerDef *SamplerService::def(const std::string &id) {
  samples::CacheServiceImpl *cs = cacheService();
  return cs ? cs->registry().find(id) : nullptr;
}

SamplerZones *SamplerService::makeTable(Load &ld, bool final) {
  auto *z = new SamplerZones();
  z->instSeq = ld.instSeq;
  z->leases = leases_;
  samples::CacheServiceImpl *cs = final ? nullptr : cacheService();
  for (std::size_t li = 0; li < ld.layers.size(); ++li) {
    SamplerZones::Layer L;
    L.lo = ld.layers[li].first;
    L.hi = ld.layers[li].second;
    for (auto &e : ld.entries) {
      if (e.layer != li || !e.buf) continue;
      const SampleBuffer *b = e.buf;
      if (!final) {  // a partial table holds references of its own (the load keeps its ones for the final table)
        b = cs ? cs->cache().acquire(e.key) : nullptr;
        if (b != e.buf) {
          leases_->release(b);
          continue;
        }
      } else {
        e.buf = nullptr;  // the reference moves into the table
      }
      L.samples.push_back({e.midi, b});
    }
    std::stable_sort(L.samples.begin(), L.samples.end(),
                     [](const SamplerZones::Sample &a, const SamplerZones::Sample &b) { return a.midi < b.midi; });
    if (!L.samples.empty()) z->layers.push_back(std::move(L));  // sampler.js: layers without samples are dropped
  }
  if (final && z->layers.empty()) m_.warn(ld.name + ": no samples could be loaded.", "decode");
  return z;
}

void SamplerService::finish(const std::shared_ptr<Load> &ld) {
  loads_.erase(std::remove(loads_.begin(), loads_.end(), ld), loads_.end());
  if (ld->cancelled) {
    for (auto &e : ld->entries) leases_->release(e.buf), e.buf = nullptr;
    return;
  }
  SamplerZones *z = makeTable(*ld, true);
  ++lateTables_;
  m_.sendOwned(instSlot(static_cast<std::size_t>(ld->channel)), opOf(SamplerOp::Zones), z, -1.0, ld->instSeq);
}

Unit *SamplerService::build(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0 || spec.channel >= static_cast<int>(std::size(spec.patch->slots)))
    return nullptr;
  const SlotPatch &sp = spec.patch->slots[spec.channel];
  samples::CacheServiceImpl *cs = cacheService();
  const samples::SamplerDef *d = cs ? cs->registry().find(sp.instId) : nullptr;
  if (!d) {
    m_.warn("sampler '" + sp.instId + "' is not in the sample manifest (slot stays silent)", "unsupported");
    return nullptr;
  }
  SamplerSetup s;
  s.multiLayer = d->layers.size() > 1;
  s.gainTrimDb = d->gainTrimDb;
  s.undampedFrom = d->undampedFrom;
  s.instSeq = spec.instSeq;
  s.releaseOverride = std::isfinite(sp.release) && sp.release > 0 ? sp.release : 0;
  {
    yyjson_doc *doc = yyjson_read(sp.paramsJson.data(), sp.paramsJson.size(), 0);
    yyjson_val *root = doc ? yyjson_doc_get_root(doc) : nullptr;
    if (root && !yyjson_is_obj(root)) root = nullptr;
    s.release = initialParam(root, "release", d->release, samples::kReleaseMin, samples::kReleaseMax);
    s.tone = initialParam(root, "tone", 1, 0, 1);
    yyjson_doc_free(doc);
  }

  // an older unit of this channel is being replaced: its late samples are no longer wanted
  for (auto &old : loads_)
    if (old->channel == spec.channel) old->cancelled = true;

  auto ld = std::make_shared<Load>();
  ld->instSeq = spec.instSeq;
  ld->channel = spec.channel;
  ld->name = d->name;
  samples::BufferCache &bc = cs->cache();
  for (std::size_t li = 0; li < d->layers.size(); ++li) {
    ld->layers.emplace_back(d->layers[li].lo, d->layers[li].hi);
    for (const auto &smp : d->layers[li].samples) {
      Load::Entry e;
      e.layer = li;
      e.midi = smp.midi;
      e.key = bc.keyOf(smp.url, smp.midi, d->decodeOpts.maxSec);
      ld->entries.push_back(std::move(e));
    }
  }
  loads_.push_back(ld);
  std::size_t k = 0;
  for (std::size_t li = 0; li < d->layers.size(); ++li) {
    for (const auto &smp : d->layers[li].samples) {
      samples::SampleJob job;
      job.url = smp.url;
      job.midi = smp.midi;
      job.opts = d->decodeOpts;
      ++ld->pending;
      std::weak_ptr<Load> w = ld;
      auto leases = leases_;
      const std::size_t idx = k++;
      // inline (offline) the callback runs before requestJob returns; realtime on a later pump()
      bc.requestJob(job, 0, true, [this, w, leases, idx](const SampleBuffer *b) {
        std::shared_ptr<Load> l = w.lock();
        if (!l || l->cancelled) {
          leases->release(b);
          if (l && --l->pending == 0 && l->issued) finish(l);
          return;
        }
        l->entries[idx].buf = b;
        if (--l->pending == 0 && l->issued) finish(l);
      });
    }
  }
  ld->issued = true;
  SamplerZones *z;
  if (ld->pending == 0) {
    z = makeTable(*ld, true);
    loads_.erase(std::remove(loads_.begin(), loads_.end(), ld), loads_.end());
  } else {
    z = makeTable(*ld, false);  // what is decoded already plays now; the rest follows (SamplerOp::Zones)
  }
  ++built_;
  return new SamplerInstrument(s, z, env.sampleRate);
}

void SamplerService::onCommit(const PatchSpec &patch, double when) {
  const std::size_t slots = std::size(patch.slots);
  for (auto &ld : loads_) {
    const auto ch = static_cast<std::size_t>(ld->channel);
    if (ch >= slots || !patch.slots[ch].present || patch.slots[ch].instType != "sampler") ld->cancelled = true;
  }
  // audio.js _effWidth: the strip's effective width is the slot width x the instrument's widthDefault, set on a
  // fresh channel at the commit instant (setWidth(.., t, true))
  for (std::size_t i = 0; i < slots; ++i) {
    const SlotPatch &sp = patch.slots[i];
    if (!sp.present || sp.instType != "sampler") continue;
    if (const samples::SamplerDef *d = def(sp.instId)) sendWidthDefault(m_, static_cast<int>(i), d->widthDefault, when);
  }
}

std::string SamplerService::statsFields() {
  return "\"samplersBuilt\":" + std::to_string(built_) + ",\"samplerLateTables\":" + std::to_string(lateTables_);
}

}  // namespace rig
