// MIDI port table (T07; SETUP_REVIEW 21c): the ports the platform reports through rig_host_midi_ports
// (`[{id, name, manufacturer, state:'connected'|'disconnected', kind:'input'|'output'}]`, contract 6.5 `midi ports`).
// Entries keep a stable index in order of first appearance, never reused (the same rule as T08's
// runtime/midi_ports.h MidiPortTable, which turns rig_midi_in's id string into that index on the MIDI thread), so the
// uint16 MidiService::onBytes receives names the same port here. byWire() also accepts the T00 string hash that
// rig_midi_in used before T08's table (values >= the table size).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace rig::midi {

inline constexpr std::size_t kMaxPorts = 128;  // MidiPortTable::kMax

struct Port {
  std::string id, name, manufacturer;
  bool connected = false;
  bool input = true;  // kind 'input' (else 'output')
  bool present = false;  // listed in the last report
  std::uint16_t legacyHash = 0;
};

class PortTable {
 public:
  /** api/engine.cpp Engine::midiIn's id hash (h = h * 31 + byte, uint16). */
  static std::uint16_t legacyHash(std::string_view id);

  /** Apply a report. `vanished` receives the ids of inputs that were connected and are not any more. False = not
   *  a JSON array (table unchanged). Control thread. */
  bool update(const char *json, std::size_t len, std::vector<std::string> &vanished);
  /** Index of a known id (order of first appearance), else the legacy hash. */
  std::uint16_t wireId(std::string_view id) const;

  const Port *byId(std::string_view id) const;
  const Port *byName(std::string_view name, bool input) const;
  /** The port a uint16 from rig_midi_in names (table index, else the legacy hash), or null. */
  const Port *byWire(std::uint16_t wire) const;
  /** First connected output (`midiClock.port: 'auto'`, SHELL.md G4). */
  const Port *firstOutput() const;
  /** Collisions of the legacy hash among present ports (warned once per report). */
  std::size_t hashCollisions() const { return collisions_; }

  /** Present ports as the contract's JSON array. */
  std::string json() const;
  const std::vector<Port> &ports() const { return ports_; }

 private:
  std::vector<Port> ports_;
  std::size_t collisions_ = 0;
};

}  // namespace rig::midi
