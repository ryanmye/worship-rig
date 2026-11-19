/* See rig_apple_midi.h. UNBUILT on Linux. */
#include "rig_apple_midi.h"

#include "rig_apple_audio.h" /* rig_apple_host_to_ns (HostTime.h is macOS-only) */
#include <stdint.h>

static uint32_t msg_len(uint8_t status) {
  if (status >= 0xF8) return 1;
  switch (status & 0xF0) {
    case 0xC0:
    case 0xD0:
      return 2;
    case 0xF0:
      return status == 0xF1 || status == 0xF3 ? 2 : status == 0xF2 ? 3 : 1;
    default:
      return 3;
  }
}

void rig_apple_midi_receive(rig_engine *engine, const char *port_id, const MIDIEventList *list) {
  const MIDIEventPacket *pkt = &list->packet[0];
  for (UInt32 p = 0; p < list->numPackets; p++) {
    uint64_t ns = pkt->timeStamp ? rig_apple_host_to_ns(pkt->timeStamp) : 0;
    for (UInt32 i = 0; i < pkt->wordCount; i++) {
      uint32_t w = pkt->words[i];
      uint32_t mt = w >> 28;
      if (mt == 1 || mt == 2) { /* system real-time/common, or MIDI 1.0 channel voice: one 32-bit word */
        uint8_t b[3] = {(uint8_t)(w >> 16), (uint8_t)(w >> 8), (uint8_t)w};
        rig_midi_in(engine, port_id, b, msg_len(b[0]), ns);
      } else if (mt == 3 || mt == 4) {
        i += 1; /* 64-bit words (SysEx7 / MIDI 2.0 voice): skipped, consume the second word */
      } else if (mt == 5) {
        i += 3; /* 128-bit */
      }
    }
    pkt = MIDIEventPacketNext(pkt);
  }
}
