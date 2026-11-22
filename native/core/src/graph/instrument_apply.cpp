// Instrument::apply: core perform opcodes -> Instrument virtuals (inst/instrument.h). Orchestrator-owned.
#include <algorithm>

#include "inst/instrument.h"

namespace rig {

void Instrument::apply(const Command &c) {
  switch (c.op) {
    case Op::NoteOn: {
      const int note = static_cast<int>(c.aux & 0xff), vel = static_cast<int>((c.aux >> 8) & 0xff);
      const double g = c.f.c > 0.0 ? c.f.c : std::clamp(vel, 0, 127) / 127.0;
      noteOn(note, vel, static_cast<float>(g), c.frame);
      break;
    }
    case Op::NoteOff:
      noteOff(static_cast<int>(c.aux & 0xff), c.frame, c.sub == 1);
      break;
    case Op::AllNotesOff:
      allNotesOff(c.frame);
      break;
    case Op::Panic:
      kill();
      break;
    case Op::Sustain:
      sustain(c.aux != 0, c.frame);
      break;
    case Op::Bend:
      setBend(c.f.a, c.frame);
      break;
    case Op::LegatoTo:
      legatoTo(static_cast<int>(c.aux & 0xff), static_cast<int>((c.aux >> 8) & 0xff), c.frame, c.f.c);
      break;
    case Op::InstParam:
      setParam(c.aux, c.f.a, c.f.b, c.f.c);
      break;
    case Op::ReleaseVoice:
      releaseVoice(c.aux, c.frame, c.f.a);
      break;
    case Op::VoiceCap:  // INTERFACE-CHANGE(T00c) D1
      setVoiceCap(c.aux);
      break;
    case Op::FadeNote:  // INTERFACE-CHANGE(T14) O-W3-1
      fadeNote(static_cast<int>(c.aux & 0xff), c.frame, c.f.a);
      break;
    default:
      if (isModuleOp(c.op)) applyModule(c);
      break;
  }
}

}  // namespace rig
