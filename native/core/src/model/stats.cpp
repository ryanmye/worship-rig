// Model state and stats (T13): `get state` (audio.js getState) and the Model's `_debugStats` members.
#include <algorithm>
#include <string>

#include "bridge/json_out.h"
#include "model/model.h"
#include "model/song.h"

namespace rig {

std::string Model::stateJson() const {
  JsonOut j;
  j.begin().kvBool("committed", committedAny_);
  // T00c: slotCount (D3; the array keeps at least the web engine's 4 entries) and the polyphony cap (D1)
  j.kv("slotCount", active_.slotCount).kv("polyphony", polyphony_);
  voiceLimitJson(j);  // INTERFACE-CHANGE(D4)
  j.key("slots").beginArray();
  const int shown = std::clamp(active_.slotCount, kWebSlots, kMaxSlots);
  for (int i = 0; i < shown; ++i) {
    const SlotPatch &s = active_.slots[i];
    j.begin()
        .kvBool("present", s.present)
        .kv("type", s.instType)
        .kv("id", s.instId)
        .kv("gain", s.gain)
        .kv("pan", s.pan);
    j.kvBool("live", sg_->liveChannel(i) != nullptr);  // T13: the slot has a channel (audio.js this.slots[i])
    j.end();
  }
  j.endArray();
  j.kv("transpose", song_.transpose).kv("tempo", song_.tempo).kvBool("mono", song_.mono);
  // T13: audio.js getState members beyond the patch (timeSig, keyContext, routing) + retiring, dynamicRange
  j.kv("timeSig", std::to_string(song_.sigNum) + "/" + std::to_string(song_.sigDen));
  j.key("keyContext").begin().kv("pc", song_.keyPc < 0 ? 0 : song_.keyPc).kvBool("minor", song_.keyMinor).end();
  j.kvBool("lowResource", lowResource_);
  sg_->stateFields(j);
  j.end();
  return j.take();
}

std::string Model::statsJson() const {
  std::string out = "\"unitsAttached\":" + std::to_string(stats_.unitsAttached) +
                    ",\"unitsFreed\":" + std::to_string(stats_.unitsFreed) +
                    ",\"rateChanges\":" + std::to_string(stats_.rateChanges) +
                    ",\"memoryWarnings\":" + std::to_string(stats_.memoryWarnings);
  out += ",\"lowResource\":" + std::string(lowResource_ ? "true" : "false") + ",\"instSeq\":" +
         std::to_string(instSeq_);
  sg_->statsFields(out);  // T13: retiring (audio.js _debugStats.retiring), channel counters
  forEachService([&](Service &s) {
    const std::string f = s.statsFields();
    if (!f.empty()) out += "," + f;
  });
  return out;
}

}  // namespace rig
