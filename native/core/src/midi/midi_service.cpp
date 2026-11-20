// "midi" service (T07). See midi_service.h.
#include "midi/midi_service.h"

#include <cmath>
#include <vector>

#include "api/engine.h"
#include "bridge/json_out.h"
#include "model/model.h"
#include "num/js_number.h"
#include "yyjson.h"

namespace rig::midi {

const rig_host *hostOf(const Model &m) {
  const rig_config *c = m.env().config;
  return c ? c->host : nullptr;
}

namespace {
/** The Engine behind the Model (T08's clock map and port index), or null in a test harness with another sink. */
const Engine *engineOf(Model &m) {
  return dynamic_cast<const Engine *>(&m.sink());
}
}  // namespace

std::uint64_t hostTimeFor(Model &m, double t) {
  if (!std::isfinite(t) || t <= m.now()) return 0;
  if (const Engine *e = engineOf(m); e && e->clockMap().valid()) return e->clockMap().hostTimeAt(t);
  const rig_host *h = hostOf(m);
  if (!h || !h->host_time_ns) return 0;
  return h->host_time_ns(h->user) + static_cast<std::uint64_t>(std::llround((t - m.now()) * 1e9));
}

double engineTimeFor(Model &m, std::uint64_t hostNs) {
  const double now = m.now();
  if (!hostNs) return now;
  if (const Engine *e = engineOf(m); e && e->clockMap().valid())
    return std::max(0.0, e->clockMap().engineTimeAt(hostNs));
  const rig_host *h = hostOf(m);
  if (!h || !h->host_time_ns) return now;
  const std::uint64_t hn = h->host_time_ns(h->user);
  const double ago = hn >= hostNs ? static_cast<double>(hn - hostNs) * 1e-9 : -static_cast<double>(hostNs - hn) * 1e-9;
  return std::max(0.0, now - ago);
}

std::string portIdOf(Model &m, const PortTable &t, std::uint16_t port) {
  if (const Engine *e = engineOf(m)) {
    std::string id = e->midiPortId(port);  // T08's MidiPortTable index (rig_midi_in)
    if (!id.empty()) return id;
  }
  if (const Port *p = t.byWire(port)) return p->id;  // T00 hash of the id string
  return std::to_string(port);
}

// ---- Perform: the Model's contract methods ------------------------------------------------------------------------

void MidiServiceImpl::noteOn(int note, int vel, double when, const yyjson_val *touch) {
  m_.noteOn(note, vel, when, touch);
}
void MidiServiceImpl::noteOff(int note, double when) {
  m_.noteOff(note, when);
}
void MidiServiceImpl::sustain(bool down, double when) {
  m_.sustain(down, when);
}
void MidiServiceImpl::wheel(const char *source, double value01, double when) {
  m_.setWheel(source, value01, when, 0);  // controller.js modWheel / expression / volumeCC
}
void MidiServiceImpl::bend(double value, double when) {
  m_.pitchBend(value, when);
}

// ---- input ----------------------------------------------------------------------------------------------------------

void MidiServiceImpl::onBytes(std::uint16_t port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostNs) {
  if (!bytes || !len) return;
  const std::string id = portIdOf(m_, table_, port);
  const Port *p = table_.byId(id);
  if (listenSet_ && !listening_.count(id)) {
    ++filtered_;
    return;
  }
  const double ts = engineTimeFor(m_, hostNs);
  // jitterFree: host time + one quantum of fixed delay (contract 6.3), else the next block
  const double when = router_.jitterFree() && hostNs ? ts + 128.0 / m_.sink().timeBase().sampleRate : -1.0;
  const std::string name = p ? p->name : std::string();
  parser_.parse(port, bytes, len, [&](const RawMessage &raw) {
    Event e{};
    bool handled = false;
    if (dispatch(raw.bytes[0], raw.bytes[1], raw.bytes[2], e)) handled = router_.handle(*this, id, name, e, when);
    handled_ += handled ? 1u : 0u;
    ++forwarded_;
    JsonOut j;
    j.begin().kv("v", 1).kv("ev", "midi").kv("type", "msg").kv("port", id);
    j.key("data").beginArray();
    for (std::uint8_t i = 0; i < raw.len; ++i) j.elem(raw.bytes[i]);
    j.endArray();
    j.kvRaw("ts", js::numberToString(ts)).kvBool("handled", handled).end();
    m_.emit(j.take());
  });
}

bool MidiServiceImpl::ports(const char *json, std::size_t len) {
  if (!json) return false;
  std::vector<std::string> vanished;
  if (!table_.update(json, len, vanished)) return false;
  for (const std::string &id : vanished) {  // midi.js 'disconnected': release that input's notes and pedal
    router_.releaseSource(*this, id, -1.0);
    // midi.js _parse.delete(id): the parser is keyed by rig_midi_in's uint16, which is T08's MidiPortTable index
    // (its order can differ from this table's: it also interns ids rig_midi_in saw before any report)
    for (std::size_t w = 0; w < kMaxPorts; ++w)
      if (portIdOf(m_, table_, static_cast<std::uint16_t>(w)) == id) parser_.reset(static_cast<std::uint32_t>(w));
    parser_.reset(table_.wireId(id));
    parser_.reset(PortTable::legacyHash(id));
  }
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "midi").kv("type", "ports").key("ports").raw(table_.json()).end();
  m_.emit(j.take());
  return true;
}

// ---- `midi` op ----------------------------------------------------------------------------------------------------

std::string MidiServiceImpl::op(const yyjson_val *cmsg) {
  yyjson_val *msg = const_cast<yyjson_val *>(cmsg);
  yyjson_val *a = yyjson_obj_get(msg, "action");
  const std::string action = yyjson_is_str(a) ? yyjson_get_str(a) : "";
  if (action == "listen") {
    listening_.clear();
    listenSet_ = true;
    JsonOut ids;
    ids.beginArray();
    if (yyjson_val *arr = yyjson_obj_get(msg, "ids"); yyjson_is_arr(arr)) {
      std::size_t i, n;
      yyjson_val *v;
      yyjson_arr_foreach(arr, i, n, v) {
        if (!yyjson_is_str(v)) continue;
        listening_.insert(yyjson_get_str(v));
        ids.elemStr(yyjson_get_str(v));
      }
    }
    ids.endArray();
    if (const rig_host *h = hostOf(m_); h && h->midi_listen) h->midi_listen(h->user, ids.view().c_str());
    return "{\"ports\":" + table_.json() + "}";
  }
  if (action == "route") {
    router_.configure(msg, *this, -1.0);
    const rig_config *c = m_.env().config;
    if (c && (c->flags & RIG_FLAG_NO_DIRECT_MIDI)) router_.setOn(false);
    return std::string("{\"on\":") + (router_.on() ? "true" : "false") + "}";
  }
  if (action == "send") {
    yyjson_val *port = yyjson_obj_get(msg, "port");
    yyjson_val *data = yyjson_obj_get(msg, "data");
    if (!yyjson_is_str(port) || !yyjson_is_arr(data)) return "{\"sent\":false}";
    std::vector<std::uint8_t> bytes;
    std::size_t i, n;
    yyjson_val *v;
    yyjson_arr_foreach(data, i, n, v) {
      if (!yyjson_is_num(v)) return "{\"sent\":false}";
      const double b = yyjson_get_num(v);
      if (!(b >= 0 && b <= 255) || b != std::floor(b)) return "{\"sent\":false}";
      bytes.push_back(static_cast<std::uint8_t>(b));
    }
    const rig_host *h = hostOf(m_);
    if (!h || !h->midi_send || bytes.empty()) return "{\"sent\":false}";
    yyjson_val *w = yyjson_obj_get(msg, "when");
    const std::uint64_t at = yyjson_is_num(w) ? hostTimeFor(m_, yyjson_get_num(w)) : 0;
    h->midi_send(h->user, yyjson_get_str(port), bytes.data(), bytes.size(), at);
    return "{\"sent\":true}";
  }
  return std::string();  // unknown action: unsupported
}

std::string MidiServiceImpl::statsFields() {
  JsonOut j;
  j.key("midi").begin().kv("forwarded", static_cast<double>(forwarded_)).kv("handled", static_cast<double>(handled_));
  j.kv("filtered", static_cast<double>(filtered_)).kvBool("route", router_.on());
  j.kv("sounding", static_cast<double>(router_.sounding())).kv("ports", static_cast<double>(table_.ports().size()));
  j.end();
  return j.take();
}

}  // namespace rig::midi
