// MIDI port table (T07). See port_table.h.
#include "midi/port_table.h"

#include <algorithm>
#include <cstring>

#include "bridge/json_out.h"
#include "yyjson.h"

namespace rig::midi {
namespace {

std::string strField(yyjson_val *o, const char *k) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return yyjson_is_str(v) ? std::string(yyjson_get_str(v), yyjson_get_len(v)) : std::string();
}

}  // namespace

PortTable::PortTable() {
  publish();
}

std::uint16_t PortTable::legacyHash(std::string_view id) {
  std::uint16_t pid = 0;
  for (char c : id) pid = static_cast<std::uint16_t>(pid * 31u + static_cast<unsigned char>(c));
  return pid;
}

bool PortTable::update(const char *json, std::size_t len, std::vector<std::string> &vanished) {
  yyjson_doc *doc = yyjson_read(json, len, 0);
  if (!doc) return false;
  yyjson_val *arr = yyjson_doc_get_root(doc);
  if (!yyjson_is_arr(arr)) {
    yyjson_doc_free(doc);
    return false;
  }
  std::vector<std::string> before;  // inputs connected before this report
  for (Port &q : ports_) {
    if (q.present && q.connected && q.input) before.push_back(q.id);
    q.present = false;
  }
  std::size_t idx, max;
  yyjson_val *p;
  yyjson_arr_foreach(arr, idx, max, p) {
    if (!yyjson_is_obj(p)) continue;
    const std::string id = strField(p, "id");
    if (id.empty()) continue;
    Port *e = nullptr;
    for (Port &q : ports_)
      if (q.id == id) e = &q;
    if (!e) {
      if (ports_.size() >= kMaxPorts) {  // reuse the oldest absent entry
        for (Port &q : ports_)
          if (!q.present) {
            e = &q;
            break;
          }
        if (!e) continue;
      } else {
        ports_.emplace_back();
        e = &ports_.back();
      }
      e->id = id;
      e->legacyHash = legacyHash(id);
    }
    e->name = strField(p, "name");
    e->manufacturer = strField(p, "manufacturer");
    e->connected = strField(p, "state") != "disconnected";
    e->input = strField(p, "kind") != "output";
    e->present = true;
  }
  yyjson_doc_free(doc);
  for (const std::string &id : before) {
    const Port *q = byId(id);
    if (!q || !q->present || !q->connected) vanished.push_back(id);
  }
  collisions_ = 0;
  for (std::size_t i = 0; i < ports_.size(); ++i)
    for (std::size_t j = i + 1; j < ports_.size(); ++j)
      if (ports_[i].present && ports_[j].present && ports_[i].legacyHash == ports_[j].legacyHash) ++collisions_;
  publish();
  return true;
}

void PortTable::publish() {
  Ids s{};
  s.n = static_cast<std::uint32_t>(ports_.size());
  for (std::size_t i = 0; i < ports_.size(); ++i) {
    const std::size_t n = std::min(ports_[i].id.size(), kMaxIdLen);
    std::memcpy(s.id[i], ports_[i].id.data(), n);
    s.id[i][n] = 0;
  }
  ids_.write(s);
}

std::uint16_t PortTable::wireId(const char *id) const {
  if (!id) id = "";
  const Ids s = ids_.read();
  const std::size_t len = std::strlen(id);
  if (len <= kMaxIdLen)
    for (std::uint32_t i = 0; i < s.n && i < kMaxPorts; ++i)
      if (std::strcmp(s.id[i], id) == 0) return static_cast<std::uint16_t>(kIndexTag | i);
  return legacyHash(id);
}

const Port *PortTable::byId(std::string_view id) const {
  for (const Port &q : ports_)
    if (q.id == id) return &q;
  return nullptr;
}

const Port *PortTable::byName(std::string_view name, bool input) const {
  for (const Port &q : ports_)
    if (q.present && q.connected && q.input == input && q.name == name) return &q;
  return nullptr;
}

const Port *PortTable::byWire(std::uint16_t wire) const {
  if ((wire & 0xff00) == kIndexTag && (wire & 0xffu) < ports_.size()) return &ports_[wire & 0xffu];
  for (const Port &q : ports_)
    if (q.legacyHash == wire) return &q;
  return nullptr;
}

const Port *PortTable::firstOutput() const {
  for (const Port &q : ports_)
    if (q.present && q.connected && !q.input) return &q;
  return nullptr;
}

std::string PortTable::json() const {
  JsonOut j;
  j.beginArray();
  for (const Port &q : ports_) {
    if (!q.present) continue;
    j.begin().kv("id", q.id).kv("name", q.name).kv("manufacturer", q.manufacturer);
    j.kv("state", q.connected ? "connected" : "disconnected").kv("kind", q.input ? "input" : "output").end();
  }
  j.endArray();
  return j.take();
}

}  // namespace rig::midi
