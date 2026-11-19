/*
 * rig_apple_midi: CoreMIDI receive path in C (UMP MIDI 1.0 words -> bytes -> rig_midi_in) so the receive block does no
 * Swift work (ARCHITECTURE 5.1). UNBUILT on Linux.
 */
#ifndef RIG_APPLE_MIDI_H
#define RIG_APPLE_MIDI_H

#include <CoreMIDI/CoreMIDI.h>
#include <rig/rig_engine.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Called from a MIDIInputPortCreateWithProtocol(_1_0) receive block: converts every channel-voice (UMP type 2) and
 * system (type 1) word to the 1 to 3 MIDI bytes it carries and calls rig_midi_in(port_id, bytes, n, host_ns) per
 * message. SysEx (type 3 / 5) packets are skipped in this first cut. `port_id` must stay valid for the call.
 */
void rig_apple_midi_receive(rig_engine *engine, const char *port_id, const MIDIEventList *list);

#ifdef __cplusplus
}
#endif
#endif
