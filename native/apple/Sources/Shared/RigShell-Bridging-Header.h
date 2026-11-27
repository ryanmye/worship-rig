// Swift sees the core's C API, rig_hostkit and the C audio/MIDI helpers through this header. UNBUILT on Linux.
#include <rig/rig_engine.h>
#include <rig/rig_hostkit.h> /* patch packs for /api/user-patches (lane N1) */
#include "rig_apple_audio.h"
#include "rig_apple_midi.h"
#include "rig_apple_null_sink.h" /* self-test output (E4) */
