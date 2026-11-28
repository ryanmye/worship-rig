/*
 * rig_hostkit.h: host-side helpers shared by the Apple shell (RigSchemeHandler) and rig-devhost (lane N1, D35).
 *
 * Not part of the audio core: a separate static library (rig_hostkit) with no dependency on rig_core, so the engine
 * stays as it is. Today it holds the patch-pack scanner, a port of server.js `scanUserPatches` / `hasUserPatches`
 * (DECISIONS O-AW-PP, docs/patch-packs.md): every <root>/<slug>/songs/<file>.json under the My Samples roots, with
 * server.js's caps, messages, ordering (localeCompare numeric/base), pack ids and hashes (sha1 of
 * JSON.stringify([schema, song, bank]), JSON.stringify reproduced byte for byte). Output is the JSON server.js sends,
 * byte for byte (test/unit/hostkit/parity.test.mjs).
 *
 * Threading: every function is [any]: pure (no global state), reentrant, may block on file I/O (call it off the main
 * thread). Strings are UTF-8; roots are absolute paths (relative ones resolve against the working directory).
 * Returned strings are malloc'd, NUL-terminated, and released with rig_hostkit_free.
 */
#ifndef RIG_HOSTKIT_H
#define RIG_HOSTKIT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(__GNUC__) || defined(__clang__)
#define RIG_HOSTKIT_API __attribute__((visibility("default")))
#else
#define RIG_HOSTKIT_API
#endif

/**
 * Scan the patch packs under `roots_json` (a JSON array of folder paths, earlier roots win a slug) and return
 * `{"patches":[...],"packs":[...],"errors":[...]}`, exactly what server.js `scanUserPatches(roots, {userIds})` gives.
 * `user_ids_json`: NULL (or "null") = don't check `user:` instruments; else a JSON array of the `user:<id>` refs My
 * Samples has (a song using any other `user:` id gets a warning in `errors`). Never NULL except on allocation failure.
 */
RIG_HOSTKIT_API char *rig_hostkit_scan_patches(const char *roots_json, const char *user_ids_json);

/**
 * The body of GET /api/user-patches: `{"app":"worship-rig","kind":"user-patches","enabled":true,` + the scan's three
 * lists `}` (server.js handle() with My Samples on).
 */
RIG_HOSTKIT_API char *rig_hostkit_user_patches_json(const char *roots_json, const char *user_ids_json);

/** 1 when some pack under the roots has a songs/<name>.json (server.js hasUserPatches: the /api/health flag), else 0.
 */
RIG_HOSTKIT_API int rig_hostkit_has_patches(const char *roots_json);

/** Release a string returned above (NULL is fine). */
RIG_HOSTKIT_API void rig_hostkit_free(char *s);

#ifdef __cplusplus
}
#endif

#endif /* RIG_HOSTKIT_H */
