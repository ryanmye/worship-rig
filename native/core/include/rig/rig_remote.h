/*
 * rig_remote.h: the browser remote (remote lane, D34 / D45; native/docs/lanes/REMOTE.md).
 *
 * A small HTTP / WebSocket server for one page (app/remote/index.html) on the local network: off until started,
 * local-network peers only, pairing with a 6-digit code that buys a token kept in memory only, rate limits, and Lock
 * (from the main page's bus state) blocking everything but PANIC. Part of rig_hostkit (no dependency on rig_core).
 *
 * Threading: every function may be called from any thread, except that rig_remote_destroy must not race the others.
 * Callbacks run on the server's own thread (or, for `info`, on the thread whose call changed it): hop to the main
 * queue there. A callback must not call rig_remote_stop / rig_remote_destroy.
 * Returned strings are malloc'd; release them with rig_hostkit_free.
 */
#ifndef RIG_REMOTE_H
#define RIG_REMOTE_H

#include <stddef.h>

#include "rig_hostkit.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct rig_remote rig_remote;

/** A bus command for the main page: `{"v":1,"type":…,"via":"remote"}` (rig.onBusCommand's JSON). */
typedef void (*rig_remote_command_fn)(void *ctx, const char *bus_command_json);
/** What Settings › Remote shows changed: call rig_remote_info_json. */
typedef void (*rig_remote_info_fn)(void *ctx);

RIG_HOSTKIT_API rig_remote *rig_remote_create(rig_remote_command_fn on_command, rig_remote_info_fn on_info, void *ctx);
RIG_HOSTKIT_API void rig_remote_destroy(rig_remote *r);

/** The page served at `/` (UTF-8 HTML; copied). */
RIG_HOSTKIT_API void rig_remote_set_page(rig_remote *r, const char *html, size_t len);

/**
 * Listen on every interface: `port` 0 = the first free of 8450..8459, else exactly `port`. Returns the bound port, or
 * -1 with `*error` (malloc'd, may be NULL) set. Starting a running server returns its port.
 */
RIG_HOSTKIT_API int rig_remote_start(rig_remote *r, int port, char **error);
/** Close every socket; every pairing ends and the code rolls. */
RIG_HOSTKIT_API void rig_remote_stop(rig_remote *r);

/** The main page's bus `state` JSON (rig_bus_check_state's rules). 1 = taken, 0 = invalid (ignored). */
RIG_HOSTKIT_API int rig_remote_publish_state(rig_remote *r, const char *json, size_t len);

/**
 * {"on":bool,"port":n,"code":"123456","paired":n,"pausedSec":n,"addresses":[{"name":"en0","ip":"192.168.1.20"}],
 *  "url":"http://…/"|null,"pairUrl":"http://…/#p=123456"|null,"qr":{"size":n,"modules":"0101…"}|null}
 */
RIG_HOSTKIT_API char *rig_remote_info_json(rig_remote *r);
RIG_HOSTKIT_API void rig_remote_new_code(rig_remote *r);
RIG_HOSTKIT_API void rig_remote_forget_all(rig_remote *r);

#ifdef __cplusplus
}
#endif

#endif /* RIG_REMOTE_H */
