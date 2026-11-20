// MIDI 1.0 byte parser (T07): port of app/js/midi.js MidiInput._parseBytes / _noteInput / _dispatch / bendValue.
// Running status per port, note-on velocity 0 = note-off, 14-bit bend -> -1..1, CC value01, program change;
// realtime bytes (>= 0xF8: clock, active sensing, ...) are skipped without touching running status; SysEx is
// skipped up to F7 (a status byte aborts it); system common (F1-F6) cancels running status; stray data bytes are
// dropped; polyphonic / channel aftertouch complete a message but dispatch nothing. Control thread; no allocation
// after the port's state exists. Vectors: tests/test_midi_parser.cpp replays tools/golden/vectors/data/midi-parse.txt
// (tools/golden/vectors/dump-midi.mjs runs the real midi.js on random byte streams).
#pragma once
#include <cstddef>
#include <cstdint>
#include <unordered_map>

namespace rig::midi {

/** bendValue(lsb, msb): (v - 8192) / (v < 8192 ? 8192 : 8191). */
double bendValue(int lsb, int msb);

/** One complete channel message as framed by the parser (status always explicit). */
struct RawMessage {
  std::uint8_t bytes[3];
  std::uint8_t len;  // 2 or 3
};

/** midi.js _dispatch result (event types of the MidiInput CustomEvents). */
struct Event {
  enum Type : std::uint8_t { NoteOn, NoteOff, Cc, Bend, Program } type;
  int channel;
  int note = 0, velocity = 0;      // NoteOn / NoteOff
  int cc = 0, value = 0;           // Cc
  double value01 = 0;              // Cc: value / 127
  double bend = 0;                 // Bend: -1..1
  int raw = 0;                     // Bend: (msb << 7) | lsb
  int program = 0;                 // Program
};

/** _dispatch(status, d1, d2): false for aftertouch and anything else midi.js ignores. */
bool dispatch(std::uint8_t status, std::uint8_t d1, std::uint8_t d2, Event &out);

class Parser {
 public:
  /** _noteInput: true when any byte is not a realtime byte (< 0xF8): the `input` wake signal. */
  static bool isInput(const std::uint8_t *bytes, std::size_t len);

  /** _parseBytes for `port`: calls fn(const RawMessage&) for every complete channel message (aftertouch included). */
  template <class F>
  void parse(std::uint32_t port, const std::uint8_t *bytes, std::size_t len, F &&fn) {
    State &st = state_[port];
    for (std::size_t i = 0; i < len; ++i) {
      const std::uint8_t b = bytes[i];
      if (b >= 0xf8) continue;  // realtime: clock, active sensing (doesn't affect running status)
      if (st.sysex) {
        if (b == 0xf7) {
          st.sysex = false;
          continue;
        }
        if (b < 0x80) continue;
        st.sysex = false;  // a new status byte aborts the sysex; handle it below
      }
      if (b >= 0x80) {
        if (b == 0xf0) {
          st.sysex = true;
          st.running = 0;
          continue;
        }
        if (b >= 0xf0) {
          st.running = 0;  // system common cancels running status
          st.n = 0;
          continue;
        }
        st.running = b;
        st.n = 0;
        continue;
      }
      if (!st.running) continue;  // stray data byte
      st.data[st.n++] = b;
      const std::uint8_t need = dataLen(st.running);
      if (st.n >= need) {
        const std::uint8_t d2 = need > 1 ? st.data[1] : std::uint8_t{0};
        const RawMessage m{{st.running, st.data[0], d2}, static_cast<std::uint8_t>(need + 1)};
        st.n = 0;
        fn(m);
      }
    }
  }

  /** Forget a port's running status (hot-plug). */
  void reset(std::uint32_t port) { state_.erase(port); }

  /** DATA_LEN by status high nibble (0x80..0xE0). */
  static std::uint8_t dataLen(std::uint8_t status) {
    const std::uint8_t t = status & 0xf0;
    return (t == 0xc0 || t == 0xd0) ? 1 : 2;
  }

 private:
  struct State {
    std::uint8_t running = 0;
    std::uint8_t data[2] = {0, 0};
    std::uint8_t n = 0;
    bool sysex = false;
  };
  std::unordered_map<std::uint32_t, State> state_;
};

}  // namespace rig::midi
