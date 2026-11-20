// Port of app/js/midi.js bendValue / _noteInput / _dispatch (T07). See midi_parser.h.
#include "midi/midi_parser.h"

namespace rig::midi {

double bendValue(int lsb, int msb) {
  const int v = ((msb & 0x7f) << 7) | (lsb & 0x7f);
  return static_cast<double>(v - 8192) / (v < 8192 ? 8192.0 : 8191.0);
}

bool Parser::isInput(const std::uint8_t *bytes, std::size_t len) {
  for (std::size_t i = 0; i < len; ++i)
    if (bytes[i] < 0xf8) return true;
  return false;
}

bool dispatch(std::uint8_t status, std::uint8_t d1, std::uint8_t d2, Event &out) {
  const int type = status & 0xf0;
  out.channel = status & 0x0f;
  switch (type) {
    case 0x90:
      out.type = d2 > 0 ? Event::NoteOn : Event::NoteOff;
      out.note = d1;
      out.velocity = d2;
      return true;
    case 0x80:
      out.type = Event::NoteOff;
      out.note = d1;
      out.velocity = d2;
      return true;
    case 0xb0:
      out.type = Event::Cc;
      out.cc = d1;
      out.value = d2;
      out.value01 = d2 / 127.0;
      return true;
    case 0xe0:
      out.type = Event::Bend;
      out.bend = bendValue(d1, d2);
      out.raw = (d2 << 7) | d1;
      return true;
    case 0xc0:
      out.type = Event::Program;
      out.program = d1;
      return true;
    default:
      return false;  // aftertouch (A0, D0) ignored
  }
}

}  // namespace rig::midi
