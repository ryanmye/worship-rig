# native/devhost: `rig-devhost`, the Linux / Mac dev host (T09)

The native core (`native/core`) + miniaudio + a WebSocket relay, so the **real UI** (`app/`) runs against the
**native engine** in Chromium on Linux or macOS, without the Apple shell. It is the shell's `RigHost` in miniature:

```
Chromium: app/ (unchanged) -> BridgeEngine (engine-bridge/bridge-engine.js)
            -> websocketTransport (engine-bridge/ws-transport.js) -- ws://127.0.0.1:8440/__rig/ws --
rig-devhost: Server (poll thread) -> rig_post()            rig_render() <- miniaudio data callback (RT thread)
             on_event (core control thread) -> one text frame per payload (a message or an ordered array)
             rig_host vtable -> AudioHost (miniaudio: ALSA / PulseAudio / JACK / Core Audio / null)
```

## Build and run

```sh
cmake -S native/devhost -B native/core/build-t09 -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/core/build-t09 -j2
(cd native/core/build-t09 && ctest --output-on-failure)          # unit.devhost-{ws,http,audio,relay}
native/core/build-t09/rig-devhost                                 # then open http://127.0.0.1:8440/
native/core/build-t09/rig-devhost --backend null --port 0         # headless (CI, this box: no sound card)
```

`-DDEVHOST_CORE_TESTS=ON` also builds and registers the core's own `rig_tests` / golden tests in the same tree.
`-DRIG_SANITIZE="address;undefined"` or `thread` work as in the core.

| option | default | |
|---|---|---|
| `--port N` / `--bind ADDR` | 8440 / 127.0.0.1 | one port for HTTP and the WebSocket (`/__rig/ws`); 0 = any free port |
| `--backend` | auto | `null` renders on a timer thread at real-time pace (no device needed) |
| `--period N` | 128 | frames per callback for `latency: 'interactive'`; a numeric latency sets `latency·rate/2` |
| `--rate HZ` | device | otherwise the device's native rate; the core adopts it (contract 6.3) |
| `--recordings DIR` | `~/Music/Worship Rig` | `rig_config.recordings_dir` for `rec` takes (created) |
| `--log FILE` | off | every bridge payload, both directions, as JSON lines (`{ms, dir:'in'\|'out', msg}`) |
| `--no-serve` | | WebSocket only; serve the UI elsewhere and open it with `?devhost=ws://host:port/__rig/ws` |
| `--no-patch-main` | | serve `js/main.js` unchanged (then the page uses the Web Audio engine) |
| `--seed N`, `--exit-after SEC`, `--repo DIR` | | engine seed; stop after SEC (tests); repository root |

## What it serves

- `app/` as static files (path traversal, `..` segments and symlinks out of `app/` refused), with **`js/main.js`
  served with one line swapped**: `./engine/index.js` -> `./engine-bridge/boot-devhost.js` (the same swap
  `boot-smoke.mjs` and the Apple `RigSchemeHandler` do; no file under `app/` is edited).
- `/__bridge/engine-api.json` (the contract), `/api/health` (`userSamples:false`, `devhost:true`),
  `/api/user-samples*` (empty), `/api/pads` (empty), `/api/heartbeat` and `/favicon.ico` (204). Other `/api/*`: 404.
  No pads folder, no My Samples, no MIDI ports, no AAC decode (`decode_file` NULL): those ops answer `unsupported`.
- `/__rig/ws`: the BRIDGE v1 link. **The newest page wins**: a second page (reload, another tab) closes the older
  socket with code 4000; for every page that goes away after `hello`, the relay posts
  `[{play panic}, {rec stop}]`, as `RigHost.webContentDidTerminate` does (SHELL.md). The page side reports a lost
  socket as a `warn` (code `device`) + `state {state:'closed'}` and closes its link; there is no reconnect (reload).

## Threads and real-time rules

| thread | does | rules |
|---|---|---|
| main | `poll()` loop: accept, HTTP, WebSocket frames, `rig_post` | never touches audio |
| core control | `on_event` -> queue + wake pipe | only a mutex-protected `deque` push |
| core host-call | `audio_start/stop/list_devices` -> miniaudio open/close | may block (a device open) |
| miniaudio RT | `renderInterleaved`: `rig_render`, then interleave | no locks, no allocation |

The RT body is unit-tested under the core's allocation trap; `RenderScope` also sets FTZ/DAZ. `rig_host_audio_started`
is called before `ma_device_start`, so the core adopts the device rate before the first callback.

Devices: id = ALSA/PulseAudio name or Core Audio UID, else `<backend>:<index>` (`Null:0`). A 4-channel request
(aux click) opens 4 channels only when the device has them. An unexpected device stop ->
`rig_host_audio_state(INTERRUPTED)`; a reroute -> `rig_host_devices_changed`.

## Tests

- C++ (`ctest -L devhost`): `unit.devhost-ws` (SHA-1 FIPS vectors incl. padding boundaries, base64 RFC 4648,
  RFC 6455 accept key and frame examples, fragmentation, 16/64-bit lengths, every protocol error), `unit.devhost-http`
  (parsing, upgrade detection, traversal/symlink refusal), `unit.devhost-audio` (callback body allocation-free and
  timed; null backend open/restart/4 channels/device list), `unit.devhost-relay` (the whole host in-process).
- JS (`test/unit/engine-bridge/`, in `run-all --only unit`): `ws-transport.test.mjs`, `native-recorder.test.mjs`
  (replays `data/rec-session.jsonl`, recorded from this host by `record-devhost-log.mjs`), `devhost.test.mjs`
  (end to end, opt-in: `RIG_DEVHOST=1`).
- `node test/unit/engine-bridge/boot-devhost.mjs` boots the real UI headless against `rig-devhost` and reports how far
  it gets (not in run-all).

Licence of the vendored audio library: `third_party/miniaudio/` (public domain or MIT-0, tag 0.11.22).
