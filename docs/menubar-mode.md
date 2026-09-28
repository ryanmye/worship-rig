# Menu-bar mode ("keep it on in the background") — contract v1

Ryan's ask: like *Macs Fan Control*: the app can live in the menu bar with low resource use; one set of 2–3
**modes** you switch between from the menu bar (or a tiny popover); modes are edited in the main app; a few settings
live there too; the main app is one click away.

## Definitions
- **Mode** = a song from the library. The **menu-bar set** is a setlist chosen in Settings (`settings.menuBarSetlistId`);
  if unset, the first 3 songs of the current setlist. The popover shows at most 6.
- **Low-resource mode** (`settings.lowResource`, also auto-on while the main window is hidden and the popover is closed):
  pin only the current song (no neighbour preload); stop all meters/analyser reads and rAF loops in hidden views;
  reverb units capped to the ones in use (no idle-IR warming); drone files keep streaming; audio quality unchanged.
  Target: idle CPU < 1 % of one core, RSS growth 0.

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
  "master": 0.5, "masterDb": -6.0, "droneOn": true, "droneKey": "D", "audio": "running|stalled|suspended",
  "latencyMs": 12, "midi": {"connected": true, "name": "Keystation 49es"}, "lowResource": false, "recording": false,
  "windowVisible": true, "memoryMB": 417 }
```
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

## Electron side: as built (LOCAL, branch `menubar-local`)

**Files.** `main.js` (section "menu-bar mode"), `preload.js` (bus methods on `window.rig`), `build/trayTemplate.png`
(22×22) + `build/trayTemplate@2x.png` (44×44) from `build/trayTemplate.svg` via `node build/make-tray-icon.mjs`
(no deps; main.js also embeds the PNGs, because electron-builder `files` does not ship `build/`), `app/mini.html`
(**placeholder**, see below), `test/phase1/shell/electron.boot.mjs` (menu-bar self-test assertions).

**`window.rig` (preload.js).** All messages are JSON **strings** (`{"v":1,…}`), exactly as in "Messages" above.

| method | who | what |
|---|---|---|
| `busPublish(stateJson)` → `Promise<{ok, seq}\|{error}>` | main renderer only | ≤ 64 KB; `v:1`, `modes` array of `{id, name}`, `current` null or `{id, name}` |
| `onBusCommand(cb)` → unsubscribe | main renderer | `cb(commandJson)`; never `openMain` (main.js handles it) |
| `miniSubscribe(cb)` → unsubscribe | popover | `cb(stateJson)` for every publish, plus the last one right away; in order (a stale "last state" reply never overwrites a newer push) |
| `miniCommand(commandJson)` → `Promise<{ok}\|{error}>` | popover (any page of ours) | ≤ 4 KB; type from the command list; `selectMode.id` string, `master.value` 0..2, `droneKey.pc` int 0..11, `lowResource.on` / `record.on` boolean |
| `setMenuBarMode(on)` → `Promise<MenuBarState>` | both | mirror of `settings.menuBarMode`; persisted in `<userData>/rig-shell.json`, so the tray exists before the renderer boots |
| `getMenuBarState()` → `Promise<MenuBarState>` | both | `{on, popoverOpen, loginItem, windowVisible, tray}` |
| `setLoginItem(on)` → `Promise<MenuBarState\|{error}>` | both | `app.setLoginItemSettings({openAtLogin, openAsHidden:true})`; packaged app only (from source it would register the bare Electron binary) |
| `onMenuBarState(cb)` → unsubscribe | both | pushes `MenuBarState` on every change (popover shown/hidden, window shown/hidden, mode, login item): the renderer's "window hidden and popover closed" low-resource trigger |

IPC channels: `rig:busPublish`, `rig:miniCommand`, `rig:miniLastState`, `rig:setMenuBarMode`, `rig:getMenuBarState`,
`rig:setLoginItem` (invoke; our origin only, like every `rig:*` handler) and `rig:busCommand`, `rig:miniState`,
`rig:menuBarState` (main → renderer). Invalid payloads resolve to `{error}` and never replace the last state.

**Window events (Rig menu channel).** While menu-bar mode is on, main.js sends `onMenu` ids `windowShown` /
`windowHidden` to the main renderer whenever its window is shown or hidden (hide-on-close, `openMain`, dock click,
minimise/restore, ⌘H), because with `backgroundThrottling:false` `visibilitychange` may never fire. Opening the
popover does not count as shown. `setMenuBarMode(true)` answers with the current one right away (the renderer is
listening by then); `setMenuBarMode(false)` sends `windowFollowDocument` (back to the document's own visibility).

**`setMenuBarMode(on)` is the source of truth.** The renderer calls it at start and on every change. It creates or
destroys the tray (the tray exists only while on), hides the dock icon while on with the window hidden and shows it
otherwise, and shows a hidden window when turned off. The `rig-shell.json` copy only lets the tray appear before the
renderer boots. `openMain` commands are handled by main.js (show, focus, dock icon) and never forwarded.

**Tray** (macOS only in v1). Left click toggles the popover; right click or ⌃/⌘-click opens the menu: "Now: <name>
(<key>)" (disabled), "Memory: N MB" (disabled; RSS of the main process + renderers from `app.getAppMetrics()`,
rounded to 5 MB, refreshed on each state publish), the modes as radio items (≤ 12), Previous, Next, Panic (all notes off), Low-resource mode
(checkbox), Open Worship Rig, Quit Worship Rig. The menu is rebuilt only when `current`, `modes`, `lowResource` or
the rounded memory change; the tooltip shows the current mode. Menu clicks send the same commands as the popover.

**Popover.** Frameless, transparent, 320×440, always on top (`pop-up-menu` level), on every Space; created on the
first tray click and then kept (hidden). Centred under the tray icon, 4 px below it, clamped to the display's work area
(`popoverBounds()`, exported). Hidden on blur, Esc, a second tray click and `openMain`. Loads
`http://127.0.0.1:<port>/mini.html` (same origin: localStorage and BroadcastChannel are shared). While hidden it gets
no state pushes; the newest state is sent when it is shown.

**Hide-on-close (macOS, menu-bar mode on).** Closing the window (red button, ⌘W) hides it, audio keeps running, the
dock icon goes away, and a library backup is still written (same `__rigShell.library()` path as a real close). The app
quits only from the tray, the app menu or ⌘Q (`before-quit` → `quitting`); quitting while hidden and recording shows
the window first, so the "recording in progress" sheet is visible. Dock click, second launch and `openMain` show and
focus the window and bring the dock icon back. `--hidden` (or a login-item launch; best effort, macOS 13+ deprecates
those flags) starts with the window hidden. Turning menu-bar mode off shows a hidden window again and removes the tray.

**Placeholder `app/mini.html`.** The server's CSP forbids inline scripts and LOCAL may not add files under `app/js`,
so the placeholder has no script. main.js `drivePlaceholder()` injects a small driver (miniSubscribe → text, three
buttons → miniCommand, `hello` on load) only into a page with `<meta name="rig-mini-placeholder">`, so the cloud's
real mini.html is never touched. The driver creates no bus; it only calls the preload methods. **Cloud: replace
the file with the real popover and delete `drivePlaceholder()`.** The self-test does not depend on the placeholder:
it calls `window.rig.miniSubscribe` / `miniCommand` in whatever `/mini.html` is served.

**Self-test (`RIG_SELFTEST=1`).** After the page's own checks, main.js runs `menubarSelftest()` and adds `menubar` to
the `RIG_SELFTEST` line: `tray`; the menu (labels, radio/checkbox state) after a fake state is published through
`window.rig.busPublish`; six rejected payloads; tray-menu clicks arriving through `onBusCommand`; the popover opened
through the tray-click path (URL, 320×440, state received, a command relayed, Esc, toggle: transitions
`show,hide,show,hide`); the window events (`windowShown` on enable, none while the popover opens, `windowHidden` on
hide, `windowShown` on `openMain`, `windowFollowDocument` on disable, tray gone after disable); and on macOS
hide-on-close (hidden, not destroyed, dock hidden, library backup written) + `openMain`. It runs on the shell fixture page only: a page with `window.__rig` (the real app, e.g. electron-full's
probe) gets `menubar: {skipped}`, so no fake state or command reaches a real controller. The boot test copies
`app/mini.*` into its fixture app dir and asserts all of it; the popover's console counts toward the zero-errors check.

**macOS caveat.** Window `show`/`hide`/`blur` events follow the occlusion state, so they don't fire while the screen is
locked; main.js does its popover bookkeeping in `showPopover`/`hidePopover` instead. Blur-to-hide and the real tray
click can only be checked by hand at an unlocked Mac.
