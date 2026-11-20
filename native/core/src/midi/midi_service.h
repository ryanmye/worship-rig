// "midi" service (T07; contract 5, 6.4 `midi`, 6.5 `midi` events): the MIDI byte parser (midi_parser.h), the port
// table (port_table.h, fed by rig_host_midi_ports through Model::midiPorts), `midi listen/route/send`, and the
// direct perform path (midi_route.h). Every complete channel message is forwarded to JS as
// `{ev:'midi', type:'msg', port, data, ts, handled}` so midi.js runs unchanged behind the JS NativeMidiAccess adapter
// (realtime bytes and SysEx are not forwarded: midi.js ignores them, and Web MIDI without sysex never delivers SysEx).
// `ts` is engine seconds (the host timestamp mapped through the host clock; arrival time when the host gives none).
// Control thread only.
#pragma once
#include <cstdint>
#include <set>
#include <string>

#include "midi/midi_parser.h"
#include "midi/midi_route.h"
#include "midi/port_table.h"
#include "model/services.h"
#include "rig/rig_engine.h"

namespace rig {
class Model;
}

namespace rig::midi {

/** The platform callbacks (rig_config.host, copied by the Engine), or null (offline tools). */
const rig_host *hostOf(const Model &m);
/** Engine time t -> host clock ns for rig_host.midi_send (0 = now or past): T08's ClockMap (render timestamps) when
 *  it has an anchor, else a linear map through rig_host.host_time_ns() and the engine's current time. */
std::uint64_t hostTimeFor(Model &m, double t);
/** Host ns (rig_midi_in) -> engine seconds; 0 or no host clock = now. */
double engineTimeFor(Model &m, std::uint64_t hostNs);
/** The platform id of rig_midi_in's uint16: T08's MidiPortTable index (Engine::midiPortId), else the T00 string hash
 *  looked up in `t`, else the number as text. */
std::string portIdOf(Model &m, const PortTable &t, std::uint16_t port);

class MidiServiceImpl final : public MidiService, private Perform {
 public:
  explicit MidiServiceImpl(Model &m) : m_(m) {}

  void onBytes(std::uint16_t port, const std::uint8_t *bytes, std::size_t len, std::uint64_t hostTimeNs) override;
  bool ports(const char *portsJson, std::size_t len) override;
  std::string op(const yyjson_val *msg) override;
  std::string statsFields() override;

  const PortTable &table() const { return table_; }
  const Router &router() const { return router_; }
  std::uint64_t forwarded() const { return forwarded_; }

 private:
  // Perform (the Model's perform methods)
  void noteOn(int note, int vel, double when, const yyjson_val *touch) override;
  void noteOff(int note, double when) override;
  void sustain(bool down, double when) override;
  void wheel(const char *source, double value01, double when) override;
  void bend(double value, double when) override;

  Model &m_;
  Parser parser_;
  PortTable table_;
  Router router_;
  bool listenSet_ = false;  // a `midi listen` arrived: only those ids are forwarded
  std::set<std::string> listening_;
  std::uint64_t forwarded_ = 0, handled_ = 0, filtered_ = 0;
};

}  // namespace rig::midi
