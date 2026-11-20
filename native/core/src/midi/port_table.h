// MIDI port table (T07; SETUP_REVIEW 21c): the ports the platform reports through rig_host_midi_ports
// (`[{id, name, manufacturer, state:'connected'|'disconnected', kind:'input'|'output'}]`, contract 6.5 `midi ports`).
// Entries keep a stable index for the engine's lifetime (up to kMaxPorts ids), so the MIDI receive thread can turn
// the platform's port id string into a small integer without a hash collision: wireId() is lock-free (a seqlock
// snapshot of the ids) and RT-safe. Until T08 forwards ids through it, rig_midi_in still hashes the id string to a
// uint16 (api/engine.cpp); byWire() accepts both encodings (kIndexTag | index, else the legacy hash).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "runtime/seqlock.h"

namespace rig::midi {

inline constexpr std::size_t kMaxPorts = 64;
inline constexpr std::size_t kMaxIdLen = 47;
inline constexpr std::uint16_t kIndexTag = 0xff00;  // wire id of table entry i = kIndexTag | i

struct Port {
  std::string id, name, manufacturer;
  bool connected = false;
  bool input = true;  // kind 'input' (else 'output')
  bool present = false;  // listed in the last report
  std::uint16_t legacyHash = 0;
};

class PortTable {
 public:
  PortTable();
  /** api/engine.cpp Engine::midiIn's id hash (h = h * 31 + byte, uint16). */
  static std::uint16_t legacyHash(std::string_view id);

  /** Apply a report. `vanished` receives the ids of inputs that were connected and are not any more. False = not
   *  a JSON array (table unchanged). Control thread. */
  bool update(const char *json, std::size_t len, std::vector<std::string> &vanished);
  /** Wire id for a platform id: kIndexTag | index when known, else the legacy hash. [rt, any thread] */
  std::uint16_t wireId(const char *id) const;

  const Port *byId(std::string_view id) const;
  const Port *byName(std::string_view name, bool input) const;
  /** The port a uint16 from rig_midi_in names (index tag or legacy hash), or null. */
  const Port *byWire(std::uint16_t wire) const;
  /** First connected output (`midiClock.port: 'auto'`, SHELL.md G4). */
  const Port *firstOutput() const;
  /** Collisions of the legacy hash among present ports (warned once per report). */
  std::size_t hashCollisions() const { return collisions_; }

  /** Present ports as the contract's JSON array. */
  std::string json() const;
  const std::vector<Port> &ports() const { return ports_; }

 private:
  struct Ids {
    std::uint32_t n;
    char id[kMaxPorts][kMaxIdLen + 1];
  };
  void publish();
  std::vector<Port> ports_;
  Seqlock<Ids> ids_;
  std::size_t collisions_ = 0;
};

}  // namespace rig::midi
