# Shell review: Electron security/reliability, store, controller, midi, recorder, presets, build

Scope: server.js, serve.mjs, main.js, preload.js, `Start Worship Rig.command`, build/afterPack.js, package.json,
app/js/{store,controller,midi,recorder,presets}.js, worklets/recorder-processor.js.
Baseline: `node test/phase1/shell/run.mjs` passes all 77 tests (59 unit, 9 Playwright, 9 Electron boot under xvfb).

Tags:
- **CONFIRMED**: reproduced by running code. Probes are in `scratchpad/review-shell/`: `server-probe.cjs`,
  `store-probe.mjs`, `ctl-probe.mjs`, `two-windows.mjs`, `equit/` (Electron SIGTERM-quit test), `asar-probe.cjs`
  (Range served from a real `electron-builder --linux dir` asar).
- **CONFIRMED (trace)**: a deterministic code path that I followed by reading and did not execute end-to-end.
- **SUSPECTED**: needs a Mac or Chrome to confirm.

Severity: **H** = data loss or a live-service failure that is likely to happen; **M** = a live-service failure in a
plausible situation; **L** = robustness or hygiene; **N** = nit.

---
## Findings

### H1. A corrupt or future-schema library overwrites the only copy when the backup write fails. CONFIRMED
`store.js:423-431` (backupRaw), `438-450` (load), `1061-1062` (seed and persist).
When the raw library fails to parse or migrate, `backupRaw()` writes `rig.v1.backup-<ts>` and then
`seedFactory()` persists a fresh library over `rig.v1`. If the backup write throws, the code only warns and still
overwrites. The backup write is exactly the one likely to throw, because it doubles a large library against the
~5 MB localStorage quota.
Probe: raw `{"schema":1,"songs":{BROKEN…` plus a backup `setItem` that throws QuotaExceededError. After the debounce
the raw string is gone from storage (`raw still in storage? false`). The same happens for schema 2 opened by the
v1 app (`newer library overwritten? true`).
Backup keys are also never pruned, so every corrupt or future-schema load adds another multi-MB key and moves the
quota closer.
**Fix:** if `backupRaw` fails, do not persist. Set `info.status = 'read-only'`, keep the in-memory fresh state, skip
`schedulePersist()` until the user exports or confirms, and surface it in `loadInfo`. Keep at most 2 backup keys
(delete older `rig.v1.backup-*` before writing). In Electron, also hand the raw string to `rig.backupNow()` (disk,
no quota).

### H2. Two windows on the same origin silently clobber each other's library, and both play. CONFIRMED (store) / SUSPECTED (second window)
`serve.mjs:145-157`, `store.js:474-498`.
Each store keeps its own in-memory state and writes the whole state. Nothing listens for `storage` events and there
is no Web Lock or BroadcastChannel. Probe: store A renames a song, store B then changes `settings.view`, and the
stored name reverts to the factory name.
The likely trigger is double-clicking `Start Worship Rig.command` a second time (for example because the first
launch looked slow). serve.mjs detects the running server (`reused`) but still calls `openChrome()`. With the same
`--user-data-dir`, Chrome opens a second `--app` window. That gives two AudioContexts, both listening to MIDI, so
every note sounds twice, plus the lost edits. Electron is protected by the single-instance lock.
**Fix:** (a) in serve.mjs, when `info.reused`, print "already running" and do not open Chrome again, or open only if
a flag asks for it. (b) In the renderer (ui/main.js bootstrap, or store), take
`navigator.locks.request('worship-rig-instance', {ifAvailable:true})`. If the lock isn't granted, show "Worship Rig
is already open in another window" and don't start the engine or MIDI. Optionally, the store listens to `storage`
for `rig.v1` and refuses to persist over a newer `lastSavedAt`.

### M1. Restart Audio (manual, watchdog auto-restart, or engine-internal) leaves the rig in a different state. CONFIRMED (a, c) / CONFIRMED (trace) (b)
`controller.js:818-859` (restartAudio), `924-934` (onSetting outputDeviceId), `1036-1039` (statechange listener);
engine `audio.js:164` (`wheel = {mod:1, expr:1, vol:1}` in `_resetState`), `248-266`, `270-280`.
- **(a) Wheel values jump to 1.0.** `engine.restart()` → `_teardown()` → `_resetState()` resets `wheel.mod/expr/vol`
  to 1, and `getState/applyState` don't carry them. The controller doesn't re-send them. Example: the player has
  the mod wheel down (pad out) or the CC7 volume slider low. The watchdog auto-restarts after a glitch, and the pad
  or master volume jumps to full until a control is touched. `virtualWheel` isn't re-sent either.
  **Fix:** the controller records the last hardware value per source (`lastCC = {mod, expr, vol}` updated in the
  `cc` handler, plus `virtualWheel`). After any restart it re-sends them through `modWheel/expression/volumeCC`
  and `setWheel('virtual')`. Alternatively the engine keeps `wheel` across `restart()`.
- **(b) The files-mode drone comes back as the synth drone.** `restart()` runs `applyState()`, which calls
  `drone.setMode('files')` on a new Drone with no files, so it falls back to synth and warns "No pad file for X".
  Only then does restartAudio call `attachFiles()`. That doesn't restart anything, because `setKey` for the same
  key is a no-op while sounding. The user's pad is replaced by the synth until the next key change.
  **Fix:** after `attachFiles` in restartAudio, force a drone re-apply: `lastDroneKey = null`, then
  `droneCall('configure', {...applied.drone, mode:'off'})` followed by `applyDrone(applied, null, true)`. Better,
  let `engine.restart({files})` attach before `applyState`.
- **(c) Engine-internal restarts bypass the controller.** `engine.setSinkId()` falls back to `this.restart()` when
  `ctx.setSinkId` rejects (a device vanished). The controller calls `setSinkId` directly (`controller.js:930-932`),
  so no `recorder.stop()` happens and there is no pad re-attach. The recorder stays in "recording" with its worklet
  on a closed context: no data, timer frozen. Probe: `restart called 1 | attachFiles after: 0 | recorder.stop
  called: false`.
  **Fix:** for output changes, route through `restartAudio()` when `setSinkId` fails. Also handle
  `engine 'statechange' {restarted:true}` in the controller (re-attach pads, re-send wheels, stop and restart the
  recorder) as a catch-all.

### M2. MIDI Learn captures the first CC of any kind, including the sustain pedal. CONFIRMED
`midi.js:253-259`, `controller.js:1090-1098`, `505-508`.
Probe: `learn('nextSong')` followed by a pedal press produces `{cc:64, channel:0}`. From then on the pedal changes
songs and never sustains (`sustain calls: 0`), because learned CCs are routed before the CC64 case. The same thing
happens with mod-wheel pot jitter (CC1), an expression pedal (CC11), or channel-mode messages (120–127). Learning a
*fader* (`slots.1.gain`) with a key press stores `{note:36}`, which is then inert: the note just plays.
**Fix:** in `learn()`, ignore CC 64/66/67 and 120–127 (or require an explicit "allow pedal" flag). Require CC motion
(two messages on the same CC, or |Δ| ≥ 8) before accepting it. Let `learn(controlId, {accept:'cc'|'any'})` accept
only CC for faders (`!isLearnButton`). Show the captured control in the UI before saving.

### M3. The held-note refcount ignores the MIDI channel, so layered or dual-zone keyboards cut notes. CONFIRMED
`controller.js:407-427`, `489-501`.
`heldBySrc` is keyed by inputId only. Probe: note 60 on ch1 and ch2 from one input, then ch1 note-off, sends
`noteOff(60)` while ch2 is still held (`noteOn 1 | noteOff 1`). Keyboards that transmit a layer or zone on a second
channel (Yamaha/Roland "dual" or "split" transmit, arranger keyboards) will drop sustained notes.
**Fix:** use `` `${inputId}:${channel}` `` as the source key for notes, and keep pedal per input or per channel as
now. `releaseSource(inputId)` must then release every channel of that input. Iterate `heldBySrc` keys with the
prefix.

### M4. The setlist position is lost after remove, move or a failed load, so Next jumps to the wrong song. CONFIRMED
`store.js:686-692` (currentIndex), `868-875` (removeFromSetlist), `877-889` (moveSong resets setlistIndex to -1),
`916-922` (neighbors with i<0 → next = ids[0]), `controller.js:343-347` (revert without index).
Probes:
- Remove the current song (position 4) from the set, press Next, and it selects position **0**.
- At a reprise (the same song at 0 and 5, current index 5), move two unrelated songs, and `currentIndex` becomes
  0, so Next plays song 1.
- A failed prepare on Next from a reprise reverts to index 0.
**Fix:**
- `moveSong`: recompute `setlistIndex` by applying the same splice to the index instead of −1.
- `removeFromSetlist`/`addToSetlist`: shift `setlistIndex` when the edit is before it. When the removed entry *is*
  the current one, set `setlistIndex` to the removed position and treat "current not in list" as "between index−1
  and index" in `neighbors()`.
- Controller failure path: `store.selectSongId(appliedId, appliedIndex)`, remembering the index at commit.

### M5. Electron reusing a server on 8438 breaks pads and hands IPC to another process's page. CONFIRMED
`main.js:520-537`, `server.js:374-391`.
If 8438 answers `/api/health` as worship-rig (a stale process, or `node serve.mjs --port 8438`), main reuses it.
Main's own `server` object never listens, but `choosePadFolder`, `listPads` and `padsBaseUrl` use its token and
padsRoot. The URLs they return 404 on the real server (probe: `pads URL … 404`). The window also depends on another
process that can exit mid-service, and the IPC origin check then trusts pages served by that process.
**Fix:** in Electron, pass `reuse:false` and treat "busy with Worship Rig" as fatal with a dialog ("Another copy is
running on port 8438; quit it"). Alternatively probe once, wait, and retry. The single-instance lock already covers
the legitimate case. Also show a dialog, not only a log line, when `serverInfo.port !== 8438`, because the library
lives on the 8438 origin and will look empty.

### M6. Recording streams outlive a renderer reload, and the close path trusts the renderer's header. CONFIRMED (trace)
`main.js:124-138`, `445-449`; `recorder.js:132-138`, `266-268`.
Streams are closed only on `render-process-gone` or quit. View → Reload Window, or any navigation, during a take
fires `pagehide`. `recorder.stop()` is async IPC that never completes, so the fd stays open, the header stays at
the last 10 s patch, and the file is only fixed at app quit. Separately, `ElectronSink.close()` skips the final
header patch once `this.error` is set (the ChainSink queue short-circuits) and then calls `streamClose` without
`fix`. The file then keeps a stale header.
**Fix:**
- In main, close with `fix:true` all streams owned by `wc.id` on `did-start-navigation` (main frame, not
  same-document) and on `wc.on('destroyed')`.
- Always run `fixWavSizes` in `closeStream`. It is cheap, and the file size is authoritative. That makes
  renderer-side header math advisory.
- Optionally add a fire-and-forget `ipcRenderer.send('rig:streamAbandon', id)` from the recorder's pagehide.

Verified solid in the same area: on SIGTERM or app quit with an open stream, the header is patched from the real
size. Probe: 1 s of data, never closed, gives `RIFF 192036 / data 192000` on a 192044-byte file. localStorage
writes, including one made in `pagehide`, survive the `app.exit(0)` quit path across relaunch.

### M7. A failed library save is never retried. CONFIRMED
`store.js:474-498`.
`persistNow()` failure (QuotaExceededError) leaves `dirty = true`, but nothing reschedules. Probe: the save fails
once, storage recovers, and with no further edits the library is **never** written (`saved? false`). The only
signal is `loadInfo.persistError`, which nothing polls.
**Fix:** on failure, `schedulePersist()` with backoff (for example 5 s, 30 s, 2 min). Emit a store-level event (or
call `warn` in a way the UI turns into a persistent banner). In Electron, fall back to `rig.backupNow(exportJSON())`
so the latest state lands on disk.

### L1. `set()` coerces garbage instead of rejecting it; some inputs mean silence or +6 dB. CONFIRMED
`store.js:639`, `644`, `652` through `params.clamp`.
`set('slots.1.gain', X)` returns **true** for NaN, 'abc', '', {} and null (value reset to default 0.8), Infinity
(→ 2 = +6 dB), and [] (→ 0 = silence). Dynamic params: `slots.0.params.tone = Infinity` is accepted, JSON-cloned
to `null`, and `null` is sent to `engine.setParam`. This contradicts the header's "invalid writes return false".
**Fix:** in `validatePatch` and the drone branch, reject when `typeof value !== 'number' || !Number.isFinite(value)`
for numeric entries (booleans and enums keep their current rules). Reject non-finite numbers for dynamic params.

### L2. Settings and import keys hit `Object.prototype`. CONFIRMED
`store.js:595-598`, `308-313`, `1005`.
`set('settings.hasOwnProperty', 1)` **throws** TypeError out of `set()`. `set('settings.toString', 5)` stores a
string, after which `String(settings)` throws. A song keyed `__proto__` in an imported file is silently dropped
(the assignment sets the prototype). An array import with two songs sharing an `id` imports one.
**Fix:** use `Object.hasOwn(SETTINGS_VALIDATORS, k)`. Build maps with `Object.create(null)` or skip
`__proto__`/`constructor`/`prototype` ids. For arrays, key by index when ids collide.

### L3. The crash-reload loop has no backoff. CONFIRMED (trace)
`main.js:445-449`. A renderer that crashes during load (OOM decoding, GPU) is reloaded every 1 s forever.
**Fix:** count crashes. After 3 in 60 s, show a dialog (Reload / Quit / Open backups).

### L4. `streamOpen` of an absolute path inside the recordings folder truncates, and uniquePath is racy. CONFIRMED (trace)
`main.js:90-102`, `210-228`. `fsp.open(target, 'w+')` truncates an existing take whenever the renderer passes an
absolute path inside `~/Music/Worship Rig` (only dialog-approved paths should overwrite). `uniquePath` is
check-then-open.
**Fix:** open with `'wx+'` for both non-dialog cases, and loop on EEXIST with `" 2"`, `" 3"`, and so on. Keep
`'w+'` only for `approvedPaths`.

### L5. Recorder hygiene. CONFIRMED (trace)
`recorder.js:424-427`: `_errored` is never reset in `start()`, so write failures in any later take are never
warned. `recorder.js:185-209`: MemorySink grows about 690 MB/hour at 48 kHz stereo, with one warning at 10 min.
A 2-hour service in the fallback path risks a renderer OOM, which kills audio too.
**Fix:** reset `_errored` in `start()`. Auto-stop the memory sink at 30–45 min, or at a byte cap, with a clear
message, then offer the download.

### L6. Pads: symlinks escape the chosen folder, and every listing re-walks the tree. CONFIRMED
`server.js:124-159`, `302-311`. A symlinked dir inside the pad folder is listed and served (probe:
`link/secret.mp3 → 200`; audio extensions only). The walk follows dir symlinks to depth 4 with no dir-count cap and
no caching. Picking `~` as the pad folder walks `~/Library` on every `/api/pads` and can trigger macOS TCC prompts.
**Fix:** `fsp.realpath` each served file and require it to be under `realpath(padsRoot)` (or explicitly allow
symlinks and document it). Cap directories visited (for example 5000). Cache the listing per token.

### L7. HTTP header polish. CONFIRMED
`server.js:75-96`, `218-225`, `264-270`.
- No CSP and no `frame-ancestors`/`X-Frame-Options`. The renderer holds file-writing IPC, so add
  `Content-Security-Policy: default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; media-src 'self'
  blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'`
  on HTML, and `Cross-Origin-Resource-Policy: same-origin` on everything.
- App samples are `public, max-age=604800`, so after an app or git update Chrome keeps stale samples for up to a
  week while `manifest.json` (no-cache) carries new `gainTrim`. Use `no-cache` plus ETag (revalidation on localhost
  is ~free) or versioned URLs.
- Minor RFC points: a syntactically invalid Range (`bytes=abc`, `bytes=5-2`) gets 416 where it should be ignored
  (200). `Range: bytes=0-` on a 0-byte file gets 416. The weak ETag is accepted in `If-Range` (RFC wants strong
  comparison).

### L8. The 'first' MIDI input isn't sticky. SUSPECTED
`midi.js:128-136`. 'first' is re-resolved on every statechange from `access.inputs` iteration order. Plugging in a
second controller (or re-enumeration after sleep or wake) can switch the active keyboard and "disconnect" the one
being played.
**Fix:** when 'first' resolves, remember that id and keep it while it is connected. Only re-resolve when it
disappears.

### L9. Toggling pedal invert while the pedal is moving leaves sustain inverted until the next press cycle. CONFIRMED
`controller.js:511-516`. Probe: `sustain [true]` stays on after the physical release.
**Fix:** store the raw CC64 value per source and recompute `pedalBySrc` when `settings.pedalInvert` changes
(`onSetting`).

### L10. Quit or close has no confirmation during a take or a service. CONFIRMED (trace)
`main.js:354`, `498`. ⌘Q or the red close button quits at once, even while recording. The file is safe (M6 probe),
but the service isn't.
**Fix:** `win.on('close')`: if a recording is active (ask the renderer, or track it in main via open streams),
show a "Stop recording and quit?" dialog.

### N1–N4
- **N1.** `.command`: no Node version check. `base64url` and ESM need Node ≥ 16 (use ≥ 18). An old Homebrew or nvm
  node fails with a cryptic error. Add
  `"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'` with a friendly message.
- **N2.** Electron fuses aren't configured (RunAsNode, NODE_OPTIONS, `--inspect` still enabled). Flip them in
  afterPack with `@electron/fuses` (it is already in node_modules). Low value for ad-hoc signed builds, but it's
  free.
- **N3.** electron-builder logs "Specified application directory equals to project dir — superfluous". That's
  harmless and required (CONTRACT_CHANGES #7). Add a comment in package.json so nobody removes it.
- **N4.** `perform.wheel()` doesn't emit `'wheel'` (nudgeWheel does), so the on-screen strip can lag a UI-driven
  value.

---
## Solid (verified)
- **Server:** bound to 127.0.0.1 with a Host allowlist. DNS rebinding is blocked (`evil.com` and `127.0.0.1.nip.io`
  both 403). GET/HEAD only. `..`, dotfiles, NUL, `\` and `%2e%2e` are rejected. `nosniff`. The pad token is 72
  bits, rotated on every folder change, and served only with an audio-extension allowlist. Cross-origin pages can't
  read `/api/pads` (no CORS).
- **Range:** 206/Content-Range, suffix, open-ended, multi-range falls back to 200, HEAD, 304, If-Range. **Works from
  inside app.asar** (real `--linux dir` build: `bytes=100-199 → 206 bytes 100-199/401325`, suffix OK).
- **Build:** the asar contains main/preload/server/package.json/README/LICENSES/app/** (678 entries, 629 sample
  files). `directories.app: "."` is correct. afterPack only runs on darwin. The icon is 1024².
- **Electron:** contextIsolation + sandbox + no nodeIntegration. Every IPC handler checks the sender-frame origin.
  Permission request and check handlers are both origin-gated (midi/midiSysex per CONTRACT_CHANGES; `media` is
  check-only). `window.open` is denied, off-origin navigation is blocked, and the single-instance lock is taken
  after `userData` is set. powerSaveBlocker is stopped on quit.
- **Quit path:** open streams are finalized with correct RIFF/data sizes. localStorage, including `pagehide`
  writes, survives the `app.exit(0)` quit (relaunch test).
- **streamOpen path policy:** `path.resolve` normalizes `..`; paths are one-shot dialog approvals or inside the
  recordings folder only.
- **Store:** migrate is idempotent (verified on messy input). Unknown fields are preserved, state is deep-frozen,
  subscribe is batched per microtask with union paths and a final state, and persist is debounced with a
  pagehide flush. Merge import always remaps ids (no collisions). Device-local settings survive a replace-import.
- **Controller:** latest-token selectSong with catchUp of edits made during load. Structural edits re-prepare
  gaplessly. Refcount across kb/ui/MIDI sources; disconnect releases notes and pedal. No watchdog false positive
  while suspended before the first gesture (10 ticks, 0 stalls) or while hidden. ⌘←/⌘→ leave text fields alone.
  The virtual wheel starts at 1.0.
- **MIDI:** running status, realtime bytes inside messages, sysex skipping, velocity-0 → off, exact 14-bit bend
  (0 → −1, 8192 → 0, 16383 → +1). `onmidimessage` is re-assigned rather than added, so there is no double
  trigger. Parse state is per input. Learn has a timeout and cancel.
- **Recorder:** clamps ±1, NaN → 0, asymmetric Int16 scaling. Chunks are transferred at ~12 messages/s, so a
  blocked main thread only queues (no loss). A silent or disconnected input still advances time. Header byte counts
  match what was queued (flush before patch). Blob-URL retry; per-context module cache.
- **Presets:** 11 songs with stable `factory:` ids, all paths valid and clamped. Wheels never start silent (engine
  wheel = 1.0, reverb-return routings use min 0.3). Delay-sync times match the tempos (80 bpm 1/8d = 0.5625,
  72 bpm = 0.625). Organ sustain is off. Sub-bass is split at B3 in mono-lowest. Drone is on for Sunday/Prayer/Sub.

## Prioritized fix list
1. **H1**: never persist over an unreadable library whose backup failed; prune backup keys.
2. **H2**: single-instance guard in the renderer (Web Locks); serve.mjs doesn't reopen Chrome when reused.
3. **M1**: after any restart, re-send the wheels and CC7, re-apply the files drone after `attachFiles`, and handle
   engine-internal restarts (`statechange.restarted`).
4. **M2**: learn filters for pedals and channel-mode CCs, needs motion, and accepts only CC for faders.
5. **M3**: refcount notes per input and channel.
6. **M6**: main closes and fixes streams on navigation and destroy; `closeStream` always fixes sizes.
7. **M7**: retry failed persists, surface the error, add an Electron disk fallback.
8. **M4**: keep `setlistIndex` consistent across move, remove, add and a failed load.
9. **M5**: no server reuse in Electron; dialog on a port change.
10. **L1/L2**: reject non-finite values; use hasOwn for validators; handle null-prototype maps in import.
11. **L3/L4/L5/L9/L10**: crash backoff, `wx` opens, recorder `_errored` reset and memory cap, pedal-invert
    recompute, quit confirmation while recording.
12. **L6/L7/L8/N\***: symlink realpath and walk caps, CSP and caching headers, sticky 'first' input, Node version
    check, fuses.
