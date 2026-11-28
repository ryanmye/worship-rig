// Swift sees the core's C API, rig_hostkit and the C audio/MIDI helpers through this header. UNBUILT on Linux.
#include <rig/rig_engine.h>
#include <rig/rig_hostkit.h> /* patch packs for /api/user-patches (lane N1) */
#include <rig/rig_bus.h>     /* the Mac command bus checks (remote lane, D45) */
#include <rig/rig_remote.h>  /* the browser remote server (remote lane, D45) */
#include "rig_apple_audio.h"
#include "rig_apple_midi.h"
#include "rig_apple_null_sink.h" /* self-test output (E4) */
