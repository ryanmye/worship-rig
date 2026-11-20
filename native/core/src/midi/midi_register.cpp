// rig_register_midi_midi: the "midi" service (midi/midi_service.h; contract 5, 6.4 `midi`). No unit, no set rows.
#include "api/registry.h"
#include "midi/midi_service.h"

namespace {

rig::Service *makeMidi(rig::Model &m) {
  return new rig::midi::MidiServiceImpl(m);
}

}  // namespace

void rig_register_midi_midi(rig::Registry &r) {
  r.addService(rig::MidiService::kName, &makeMidi);
}
