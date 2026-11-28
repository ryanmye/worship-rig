/*
 * rig_bus.h: the menu-bar / remote command bus's message checks (remote lane, D45; native/docs/lanes/REMOTE.md).
 *
 * A C++ port of app/js/shared/bus.js `stateError` / `commandError` (contract v1, docs/menubar-mode.md, with D45's
 * optional `scene.name`, `locked` and command `via`), behind Electron main.js's size caps (BUS_STATE_MAX 64 KB,
 * BUS_COMMAND_MAX 4 KB, counted as JS string length, i.e. UTF-16 code units). Same rules, same order, same words:
 * test/unit/hostkit/bus-parity.test.mjs runs one corpus through both.
 *
 * Part of rig_hostkit (no dependency on rig_core). Threading: [any], pure and reentrant.
 * Returns 0 when the message is valid, 1 when it is not (then `*reason`, if `reason` is not NULL, gets a malloc'd,
 * NUL-terminated reason; release it with rig_hostkit_free), -1 on an internal error (out of memory): treat that as
 * invalid. Never throws. Reasons:
 *   "too large (<n> bytes > <max>)" (byte pre-check), "too large (<n> > <max>)" (UTF-16 units), "not JSON",
 *   "too deep" (nested deeper than 16: no bus message is; bus.js / main.js have no such limit), or bus.js's own
 *   reason ("v must be 1", "current", "unknown type \"x\"", "droneToggle.on", …).
 * `json` need not be NUL-terminated; `len` is its byte length (UTF-8; invalid bytes read as U+FFFD, as JSON.parse
 * would see a decoded string).
 */
#ifndef RIG_BUS_H
#define RIG_BUS_H

#include <stddef.h>

#include "rig_hostkit.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Bus v1 state cap (Electron main.js BUS_STATE_MAX), in UTF-16 code units of the JSON text. */
#define RIG_BUS_STATE_MAX 65536
/** Bus v1 command cap (Electron main.js BUS_COMMAND_MAX), in UTF-16 code units of the JSON text. */
#define RIG_BUS_COMMAND_MAX 4096

/** Check a `state` message (JSON text). 0 valid, 1 invalid (`*reason`), -1 internal error. */
RIG_HOSTKIT_API int rig_bus_check_state(const char *json, size_t len, char **reason);

/** Check a `command` message (JSON text). 0 valid, 1 invalid (`*reason`), -1 internal error. */
RIG_HOSTKIT_API int rig_bus_check_command(const char *json, size_t len, char **reason);

#ifdef __cplusplus
}
#endif

#endif /* RIG_BUS_H */
