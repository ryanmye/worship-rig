# Lane REMOTE: the Mac command bus, then the browser remote (D34, D40)

Owner: the remote session (issue #1). Plan first, then status blocks at the end. Decisions made here are logged in
DECISIONS.md as new D-numbers marked "(remote lane)".

## 1. Goal

1. **Mac command bus.** One validated channel between the main page and every other client: the browser remote now,
   the menu-bar popover (N7) and the iPhone remote (D30) later. Same messages as `shared/bus.js` contract v1, same
   limits as Electron main.js (state ≤ 64 KB, command ≤ 4 KB). Nothing is on the network unless the remote is on.
2. **Browser remote.** The Mac app serves one small page on the local network, off by default. Settings › Remote shows
   the address, a QR code and a 6-digit pairing code. The page shows the song and snapshot names and has Previous /
   Next song, Previous / Next snapshot, PANIC and drone on/off. Nothing else. Lock blocks everything but PANIC.

## 2. Design

```
main page (controller) ── rig.busPublish(stateJson) ──▶ RigBus.swift ──▶ rig_bus_check_state (C++, hostkit)
                        ◀─ rig.onBusCommand(cmdJson) ──      │                     │ valid → last state
                                                             ▼                     ▼
                                                  (N7 popover later)     rig_remote_publish_state
                                                                                   │
   phone browser ◀── HTTP / WebSocket on the LAN ── RemoteServer (C++, hostkit, own poll thread)
                 ── pair / commands ──▶ pairing + rate limits + Lock gate + dedupe ──▶ command callback
                                                                     ──▶ RigBus.swift ──▶ page onBusCommand
```

Almost everything is C++ in `native/core/src/hostkit` (it compiles and tests on Linux and is already linked into the
Apple app on every slice: `build-core.sh` builds `rig_hostkit`). Swift only switches the server on and off, passes the
page's HTML and the bus state in, and hands commands back to the page.

### 2.1 Bus validation (C++ port of bus.js)

- `rig_bus_check_state(json)` / `rig_bus_check_command(json)`: the size cap (64 KB / 4 KB, as main.js
  `BUS_STATE_MAX` / `BUS_COMMAND_MAX`), JSON parse, then `stateError` / `commandError` from `shared/bus.js`, rule for
  rule. They return NULL when valid, else the first problem in bus.js's words.
- Parity: `rig-hostkit bus-state` / `bus-command` CLI subcommands and a node test that runs the same corpus through bus.js and the
  C++ port (the pattern of `test/unit/hostkit/parity.test.mjs`).

### 2.2 Bus v1 additions (optional fields, still v1)

The remote needs two things the v1 state does not carry yet. Both are optional, like `theme` and `scene`:
- `scene.name` (string, ≤ 40 chars, D25's `SCENE_NAME_MAX`): the playing snapshot's name; absent = "Scene n".
- `locked` (bool): `settings.performLock`.
- Commands may carry `via: 'remote'`. bus.js refuses any other `via` value (an ignored `'Remote'` would skip a gate
  that compares with `===`). The controller refuses any `via: 'remote'` command outside D34's list, and all but
  `panic` while locked. That makes the controller the authority, not a possibly stale state in the relay. The relay
  also refuses at once, so the phone gets an immediate "Locked" answer.
- `droneToggle` may carry `on` (bool): set instead of flip. The remote always sends it, so a doubled press or a retry
  against a state up to one throttle window old can't flip the drone twice (skeptic S4).
- RigBus.swift builds remote commands itself (from rig_remote's callback) and never forwards page-supplied JSON on the
  remote path: the gate trusts `via` to come from the relay only.

These need small edits to `app/js/shared/bus.js` (state check) and `app/js/controller.js` (`menuBarState`,
`handleCommand`), both in the menu-bar section, far from TOUCH's MIDI note path. The web engine is untouched.

### 2.3 Remote service (C++, pure logic, no sockets)

`remote_service.{h,cpp}`: every decision lives here, unit-tested on plain values with an injected clock and RNG.
- **Pairing:** a 6-digit code (CSPRNG: `getentropy` / `arc4random_buf`), shown in Settings and carried in the QR
  (`http://<ip>:<port>/#p=<code>`). A correct code returns a 128-bit random token (hex). Tokens live in memory only:
  quitting the app, switching the remote off or "Forget phones" ends every pairing. At most 8 paired phones (the
  oldest is dropped).
- **Pairing window:** /api/pair is open for 5 minutes after the remote is switched on or "New code" is pressed;
  outside it every try is refused without looking at the code ('pairing-closed'), so guessing is only possible while
  someone is at the Mac (skeptic-2 F3).
- **Brute force:** per peer IP (an IPv6 /64 counts as one), 5 failed codes per 60 s; a busy IP table never evicts an
  IP that is still failing. Globally, 20 failures rotate the code and pause pairing: 60 s, doubling with each rotation
  up to 1 h (≈ 20 guesses an hour at most once grown); "New code" or a successful pairing resets it; failures more
  than an hour apart start the count over (typos over days don't add up).
- **Rate limits:** per token, a token bucket of 10 commands/s with a burst of 20; per peer IP, 30 requests/s across
  every route (WebSocket messages and pings included); at most 16 connections in total and 4 per IP. When full, the
  oldest connection that has proved nothing yet (no request served, no paired WebSocket) makes room; a new connection
  must send its first byte within 3 s (skeptic-2 F8).
- Only a command that ran is remembered for dedupe: a refusal (locked, not-ready) retried later is a new try.
- **Commands from the page:** `prevSong`, `nextSong`, `prevSnapshot`, `nextSnapshot`, `panic`, `droneOn`, `droneOff`,
  each with a client `id` (≤ 32 chars, `[A-Za-z0-9_-]`). They are mapped to bus commands (`prevScene` / `nextScene`;
  `droneOn` / `droneOff` become `droneToggle` with `on: true / false`). A repeated `id` within 30 s is answered from
  the first result and not run again.
- **Lock:** while the last state says `locked`, every command but `panic` is answered `{ok:false, error:'locked'}`.
- **View:** the page never sees the bus state. It sees `{seq, song, snapshot, snapshotCount, droneOn, locked, audio}`,
  built from it (names cut to 80 / 40 chars).

### 2.4 Remote server (C++, POSIX sockets)

`remote_server.{h,cpp}` with its own small HTTP parser and WebSocket codec (`remote_http`, `remote_ws`; adapted from
devhost's `http.cpp` / `ws_codec.cpp`, with tighter limits: 8 KB request head, 1 KB body, 4 KB WS message).
- Off by default. `start` binds `0.0.0.0:<port>` (8450, next free up to 8459). `stop` closes every socket.
- **Local network only:** the peer address must be loopback, RFC 1918, link-local, CGNAT 100.64/10, IPv6 ULA or
  link-local (IPv4-mapped IPv6 handled). Anything else is closed without a reply.
- **DNS rebinding:** `Host` must be an IP literal (with the port) or `<name>.local`. **Cross-site:** POSTs and the WS
  upgrade need an `Origin` equal to `http://<Host>`, or none. Auth is a header token (`X-Rig-Token`), never a cookie,
  so another site cannot ride it.
- POST bodies must be `application/json` (a cross-site form can't send that without a CORS preflight, which never
  succeeds here).
- Routes: `GET /` (the page, `Cache-Control: no-store`, a strict CSP: `default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' ws://<Host>; frame-ancestors 'none'`), `POST /api/pair`, `GET /api/state` (poll; `?since=<seq>` waits up to 10 s,
  then answers the same view), `POST /api/cmd`, `GET /ws` (upgrade; the first message must be `{"auth":token}` within
  5 s; then state pushes and `{cmd,id}` → `{ack:id, ok, error?}`). Everything else is 404. Bodies must be JSON
  objects.
- Timeouts: an idle HTTP connection is dropped after 15 s, an unauthenticated WS after 5 s, a WS with no traffic
  after 60 s (the page pings every 20 s).
- C API in `include/rig/rig_remote.h`: `rig_remote_create`, `rig_remote_set_page`, `rig_remote_start` / `stop`,
  `rig_remote_publish_state`, `rig_remote_info_json` (on, port, addresses, code, paired count, QR modules),
  `rig_remote_new_code`, `rig_remote_forget_all`, `rig_remote_destroy`. Commands leave through a callback on the
  server thread (Swift hops to the main queue).
- QR: Nayuki's QR Code generator (MIT) vendored under `native/core/third_party/qrcodegen`, with a row in LICENSES.md.
  `info_json` carries the module matrix and Settings draws it on a canvas, so no QR code runs in JS.

### 2.5 The remote page (`app/remote/index.html`)

One file: ES5 script, plain CSS, no modules, no build step, no web fonts, system fonts only. A pairing screen (the code
from the URL fragment or typed in, kept in `localStorage` with a try/catch: old private Safari throws), then the
control screen: song name, snapshot name, ◀ Song ▶, ◀ Snapshot ▶, drone on/off, and PANIC set apart, large, needing a
deliberate tap. WebSocket first, then polling once WS fails twice (or isn't there). It shows connected / reconnecting /
locked plainly. Big touch targets for an iPhone 4 screen; no hover; `-webkit-` prefixes where iOS 7 needs them; no
`classList`, `Promise`, `fetch` or `JSON` features past ES5.

### 2.6 Mac (Swift, thin)

- `app/js/native-shell/40-bus.js`: `rig.busPublish`, `rig.onBusCommand` (native → page through `__rigShell.bus(json)`),
  and `rig.remote = {info, setEnabled, newCode, forgetAll, onInfo}`.
- `RigBus.swift` (a `RigShellFeature`: validate through `rig_bus_check_*`, keep the last state, hand it to the remote,
  later to N7's popover) and `RigRemote.swift` (owns the `rig_remote` handle, reads `remote/index.html` from the app
  bundle, keeps on/off in UserDefaults; default off).
- Settings › Remote (`app/js/views/settings-remote.js`, mounted from settings.js with a few additive lines, shown only
  when `rig.remote` exists): an On switch, the address, the QR, the code, "New code", "Forget phones", the number of
  paired phones, and a line on what the page can do.
- `RigSelfTest`: a `remote` step (start on a free port, pair over loopback with a real socket, a command reaches the
  page's `onBusCommand`, Lock refuses, stop closes the port).

## 3. Files

New: `native/core/include/rig/rig_bus.h`, `rig_remote.h`; `native/core/src/hostkit/bus_check.cpp`,
`remote_service.{h,cpp}`, `remote_http.{h,cpp}`, `remote_ws.{h,cpp}`, `remote_server.{h,cpp}`, `remote_c.cpp`;
`native/core/third_party/qrcodegen/*`; `native/core/tests/hostkit/test_bus_check.cpp`, `test_remote_*.cpp`;
`native/core/tools/hostkit/remote-dev` (a test host: the server with stdin/stdout JSON lines for state in / commands
out); `app/remote/index.html`; `app/js/native-shell/40-bus.js`; `app/js/views/settings-remote.js`;
`test/unit/hostkit/bus-parity.test.mjs`; `test/phase2/remote/*` (Playwright + ES5 parse);
`native/apple/Sources/Shared/RigBus.swift`, `RigRemote.swift`.

Edited (small): `app/js/shared/bus.js`, `app/js/controller.js` (menu-bar section), `app/js/views/settings.js`
(mount), `native/core/CMakeLists.txt`, `native/core/tools/hostkit/main.cpp`, `native/apple/Sources/Shared/RigHost.swift`
and `RigSelfTest.swift` (register / one step), the bridging header, `test/run-all.mjs` (a `remote` suite),
`LICENSES.md`, `CONTRACT_CHANGES.md` / `DECISIONS.md` (appended), `docs/menubar-mode.md` (the two optional fields).

Not touched: `app/js/engine/**` (the oracle), the N2 and TOUCH files, `RigPaths.swift`.

## 4. Tests and gates

- ctest (`unit.hostkit-bus`, `unit.hostkit-remote-*`) on g++, clang++-20 `-Werror`, and ASan+UBSan: validation,
  pairing / rate limits / dedupe / Lock with a fake clock, HTTP and WS parsing on byte strings (fuzz-style random and
  truncated inputs), the LAN filter, and real loopback sockets for the server (pair, poll, WS, limits, stop).
- Node: bus.js ↔ C++ parity on one corpus; bus.js / controller unit tests for `scene.name`, `locked`, `via:'remote'`.
- Playwright (Chromium) against `remote-dev`: pair from the QR fragment, a wrong code, every button sends the right
  bus command, the state shows, Lock disables everything but PANIC, WS blocked → polling still works, reconnect.
- Old browsers: the page's script parses with acorn `ecmaVersion: 5`, and a lint check that no listed post-ES5 API
  is used (`fetch`, `Promise`, `classList`, `addEventListener` options objects, `const` / `let`, …).
- Fixtures byte-identical (`native/golden`, core fixtures); the affected UI suites (`unit`, `mini`, `settings`,
  `shell-unit`) through `node tools/cloud/gates.mjs`.
- Each change is reviewed by a separate skeptic agent before it is pushed.

Known and accepted (skeptic-2 nits): more than ~8 KB of WebSocket frames pending at once closes the socket (the page
sends one small message at a time); a 1-byte close payload is accepted and text frames are not UTF-8 checked (nothing
reads them as text but the JSON parser); `HEAD /` answers Content-Length 0.

## 5. Only a Mac can verify

- Swift compiles (CI `mac-check`), and the self-test `remote` step passes.
- macOS asks to allow incoming connections (application firewall) on first start; the Local Network prompt
  (macOS 15+) if any.
- A real phone on the same Wi-Fi: iPhone 5s/6 on iOS 12 (must), iPhone 4 on iOS 7 (best effort), Android Chrome 50+.
  Scan the QR, pair, run every button, Lock from the Mac, Wi-Fi drop and return.
- The remote stays responsive with the window hidden or the app in menu-bar mode later (WebKit throttling, finding 9).

## 6. Order

1. Plan, D-number, intro on #1.
2. C++ bus validation + parity test.
3. bus.js / controller: `scene.name`, `locked`, `via:'remote'`.
4. Remote service (pure).
5. HTTP / WS codecs, server, LAN filter, C API, QR, `remote-dev`.
6. The page + Playwright + ES5 checks.
7. Mac: native-shell file, RigBus / RigRemote, Settings › Remote, self-test step; CI.
8. Status blocks here after each push.

## Status

### Status 2026-11-28 (remote session)

- **Done (on v2-native):** the Mac command bus and the browser remote, end to end on Linux.
  - Bus: `rig_bus.h` (bus.js checks in C++, parity-tested), bus v1 optional `scene.name` / `locked` /
    `via:'remote'` / `droneToggle.on`; the controller refuses remote commands under Lock except PANIC.
  - Remote: `rig_remote.h` server (LAN-only, Host/Origin checks, pairing code → token, backoff, rate limits, long
    poll + WebSocket), `app/remote/index.html` (ES5), `rig-remote-dev`, suite `remote` (run-all).
  - Mac: `40-bus.js`, `RigBus.swift`, Settings › Mac › Remote (D46), self-test step `remote`.
  - Two skeptic reviews: no blockers left. Review 1 S1–S4 fixed; review 2 F1–F7 fixed (an unauthenticated
    WebSocket could grow memory without bound and wedge every slot; the pause between code rotations now doubles to
    1 h).
- **Next:** fix forward from CI `mac-check` (Swift compiles only there); skeptic-2's two late minor items: G1 (a
  WebSocket between upgrade and auth can be evicted under a connection flood; the page falls back to polling, so the
  remote keeps working) and G2 (count IPv6 failures per /128, sockets per /64). Then, for the iPhone remote (D30), more
  commands and fields on the same bus (pick a song, drone key / level, master), plus Bonjour.
- **Blocked:** nothing.
- **Ryan, on the Mac:**
  1. Settings › Mac › Remote: switch it on. macOS may ask to allow incoming connections: allow it.
  2. Scan the QR with an iPhone on the same Wi-Fi. Pair, try every button, then Lock on the Mac (only PANIC works).
  3. Turn Wi-Fi off and on, and check the page reconnects.
  4. Old phones if you have them: iOS 12 (must work), iOS 7 (best effort), Android Chrome 50+.
  5. Quit the app: the phone shows "Reconnecting…". Open it again: the remote comes back on with a new code, and
     phones pair again.
