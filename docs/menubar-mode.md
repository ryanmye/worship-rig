# Menu-bar mode ("keep it on in the background") — contract v1

Ryan's ask: like *Macs Fan Control*: the app can live in the menu bar with low resource use; one set of 2–3
**modes** you switch between from the menu bar (or a tiny popover); modes are edited in the main app; a few settings
live there too; the main app is one click away.

## Definitions
- **Mode** = a song from the library. The **menu-bar set** is a setlist chosen in Settings (`settings.menuBarSetlistId`);
  if unset, the first 3 songs of the current setlist. The popover shows at most 6.
- **Low-resource mode** (`settings.lowResource`, also auto-on while the main window is hidden; an open popover does not
  count as visible, lowres2-critic R2):
  pin only the current song (no neighbour preload); stop all meters/analyser reads and rAF loops in hidden views;
  reverb units capped to the ones in use (no idle-IR warming); drone files keep streaming; audio quality unchanged.
  Target: idle CPU < 1 % of one core, RSS growth 0.
  lowres2: a sounding **synth** drone is **frozen** (rendered offline once into a seamless 20 s loop with its reverb,
  played from one buffer; the live voices stop and the reverb sleeps; re-rendered when its key/sound changes).
  lowres2-critic: the last loop is kept, so off → on with nothing changed (popover opened and closed) renders nothing
  (back on within the thaw's 1.5 s lead keeps the loop playing untouched); one render at a time; a same-voicing
  re-render swaps in step with the playing loop (linear crossfade, no beating).
- **Audio sleep** (lowres2, **low-resource mode only** — lowres2-scope, Ryan 2026-09-30): while low-resource is on,
  after `settings.audioSleepSec` (30 s, counted from the later of the last input and low-resource turning on; 0 =
  never; no Settings UI) with nothing to play and no input (a held sustain pedal counts as input in progress), the
  AudioContext is suspended (150 ms fade first); the first input wakes it (60 ms fade in; a note that woke it is
  queued and played, not lost). Leaving low-resource wakes it at once. In normal play the context never sleeps and
  the drone is never frozen. Status `audio: "asleep"`.
- **The popover is not the main window** (lowres2-critic R2): opening it must not end low-resource. Its `hello` is
  not input (no wake, no thaw); only a real command (mode, drone, master, record, …) wakes the audio. Electron main
  reports the popover as rig menu ids `popoverShown` / `popoverHidden` (status only), never as `windowShown` /
  `rig:window-visible`.

## Processes and the bus
Audio lives in the MAIN WINDOW renderer (hidden, never destroyed while the app runs: on macOS closing the window hides it;
Quit is explicit from the tray/menu/⌘Q). The popover is a SEPARATE renderer (`app/mini.html`) and has no audio; it talks
to the main renderer through a bus:

```
main renderer  ──publish(state)──▶  bus  ──▶ popover(s) + Electron main (for the Tray menu)
popover        ──command(cmd)────▶  bus  ──▶ main renderer (controller executes)
```
`app/js/shared/bus.js` (CLOUD) — one API, two transports:
- Electron: `window.rig.busPublish(json)` / `window.rig.onBusCommand(cb)` in the main renderer; `window.rig.miniSubscribe(cb)` /
  `window.rig.miniCommand(json)` in the popover; Electron main relays (and reads `state` to rebuild the Tray menu).
- Browser fallback: `BroadcastChannel('rig-bus')` between the main tab and a small `mini.html` tab/window — same messages,
  so the popover UI and its Playwright tests run on Linux too.

### Messages (JSON, all fields required unless noted)
`state` (published on every change, throttled ≤ 4/s, and on `hello`):
```json
{ "v":1, "current": {"id":"…","name":"Sunday Pad + Piano","key":"D"}, "modes":[{"id":"…","name":"…","key":"D","index":0}],
  "master": 0.5, "masterDb": -6.0, "droneOn": true, "droneKey": "D", "audio": "running|stalled|suspended|asleep",
  "latencyMs": 12, "midi": {"connected": true, "name": "Keystation 49es"}, "lowResource": false, "recording": false,
  "windowVisible": true, "memoryMB": 417 }
```
Optional in `state` (mini-theme, 2026-09-29; `v` stays 1): `"theme": "daylight-day"`, the applied theme id (non-empty
string). The popover follows it when present and different (an unknown id resolves to the default, as in the app);
absent, it follows the `localStorage['worship-rig.theme']` mirror alone (its `storage` event, plus a re-read on show /
focus). Nothing publishes it yet; the main renderer's publisher may add it.
`audio: "asleep"` (lowres2, still v 1): the main renderer suspended its AudioContext on purpose — nothing to play (no
voices, drone off or a frozen drone at level 0, not recording) and no input for `settings.audioSleepSec` (default 30 s,
0 = never; low-resource mode only). Any input wakes it: a MIDI message or hot-plug, a key, a pointer/wheel anywhere
in the app, and every bus command **except `hello`** (lowres2-critic R2: a popover opening leaves it asleep and the
drone frozen); leaving low-resource wakes it too. Show it as a calm state ("Audio asleep — play a note or press a
key to wake"), not as a fault.

`command` (popover/tray → main renderer): `{ "v":1, "type": "hello" | "selectMode" (id) | "nextMode" | "prevMode" | "panic" |
"fadeOutAll" | "master" (value 0..2) | "droneToggle" | "droneKey" (pc 0..11) | "lowResource" (on: bool) | "openMain" |
"record" (on: bool) }` — `openMain` is handled by Electron main (show + focus the window); everything else by the controller.

## Ownership (parallel build)
| Piece | Owner | Files |
|---|---|---|
| Tray icon (template image, mono), tray menu built from `state` (current mode ✓, modes radio, Panic, Open Worship Rig, Low-resource toggle, Quit), popover `BrowserWindow` (frameless, 320×440, anchored under the tray icon, hides on blur), hide-on-close, `app.dock.hide()` while in menu-bar mode (`settings.menuBarMode` mirrored to main via IPC), "Open at login" (`app.setLoginItemSettings`), IPC relay for the bus, `RIG_SELFTEST` hooks for tray state | **LOCAL** | `main.js`, `preload.js` (add `busPublish/onBusCommand/miniSubscribe/miniCommand/setMenuBarMode/getMenuBarState`), `test/phase1/shell/electron.boot.mjs` (tray self-test), `README.md` |
| `shared/bus.js` (transport abstraction + message validation), controller: `controller.modes` (list/select/next/prev from the menu-bar set), `controller.setLowResource(on)`, state publishing, command handling; engine low-resource hooks (`engine.setLowResource(on)`: pin policy 'current-only', skip idle IR warming, pause slotLevel taps); store: `settings.menuBarSetlistId`, `settings.lowResource`, `settings.menuBarMode` | **CLOUD A** | `app/js/shared/bus.js`, `controller.js`, `engine/audio.js`, `store.js`, `shared/params.js`? (no), tests in `test/phase1/shell/` + `test/phase1/engine/` |
| Popover UI `app/mini.html` + `app/js/views/mini.js` + `app/mini.css`: big current-mode name + key, 2–6 mode buttons (colour = slot 0 colour of the song? no — neutral, current highlighted), Prev/Next, master fader (relative drag), drone on/off + key, Panic (hold), Open Worship Rig, low-resource toggle, status line (audio/MIDI/latency); works in Electron popover and in a 320×440 browser window; keyboard accessible; Settings section in the main app: "Menu bar" (enable menu-bar mode, choose the set, open at login, low-resource) — settings.js | **CLOUD B** | `app/mini.html`, `app/mini.css`, `app/js/views/mini.js`, `app/js/views/settings.js` (new section), `app/js/main.js` (renderer: publish hidden-state, react to lowResource: stop meters), tests `test/phase2/mini/**` (Playwright with two pages over BroadcastChannel) |

Low-resource must be observable: `engine._debugStats()` gains `lowResource:true`, `slotLevelTaps:0`; controller status
`memory.mode:'current-only'`. Cloud tests assert taps = 0 and pins = current only; local measures CPU on the Mac.

## Not in v1
Global hotkeys (later, via `globalShortcut`), Touch Bar, a Windows/Linux tray (Electron supports it; test later), multiple
menu-bar sets.
