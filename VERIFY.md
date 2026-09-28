# Worship Rig — Technical Assumption Verification

Environment: Node v22.22.2, Python 3.11.15, ffmpeg 6.1.1-3ubuntu5 (system, `/usr/bin/ffmpeg`;
`/opt/pw-browsers/ffmpeg-1011` also present but system ffmpeg was used — both have libmp3lame/libopus/libvorbis).
Playwright browsers at `/opt/pw-browsers`: chromium-1194, chromium_headless_shell-1194, ffmpeg-1011.
Work dir: `/tmp/.../scratchpad/verify` (scripts/output kept there, not copied into this repo).

---

## Q1 — Headless Chromium audio: VIABLE (real-time AudioContext works headless)

Used `playwright@1.56.0`, confirmed to bundle **chromium revision 1194** (matches the
pre-installed browser) by downloading each candidate version's `browsers.json` from the npm
registry and diffing the chromium revision field (1.55.0→1187, **1.56.0→1194**, 1.57.0→1200, …).
`npx playwright --version` → `Version 1.56.0`.

Launched with `chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })`,
navigated to a page served by `python3 -m http.server` (localhost:8791), and in-page:

```json
{
  "initialState": "running",
  "stateAfterResume": "running",
  "sampleRate": 44100,
  "baseLatency": 0.01,
  "currentTimeAdvanced": true,
  "rms": 0.7078262355565075,
  "rmsNonZero": true,
  "workletAddModule": "ok",
  "workletNodeCreated": true
}
```

- `AudioContext` starts in `"running"` state already (the no-user-gesture flag makes it so);
  `resume()` is a no-op confirming it. `currentTime` advances in real wall-clock time (0 → 0.51s
  after a 500ms sleep) — this is realtime (not offline) audio.
- Oscillator → Analyser RMS ≈ 0.708 (expected for a 440Hz sine sampled over one period), i.e.
  **non-zero, real audio is being generated/processed**, not silently stubbed.
- `audioWorklet.addModule()` against a module served by a local `http.server` succeeded and the
  node instantiated cleanly.

**Conclusion: real-time `AudioContext` (not just `OfflineAudioContext`) is fully viable headless**
in this sandbox with the autoplay-policy flag. No workaround needed.

---

## Q2 — Electron on Linux: mostly works; MIDI blocked by container audio/MIDI subsystem, not Electron

- `npm view electron version` → **44.4.5**. Installed with `npm i electron@44.4.5`; the postinstall
  script successfully downloaded the Electron binary through the proxy.
- `which xvfb-run` → `/usr/bin/xvfb-run` (already installed, Xvfb package `2:21.1.12-1ubuntu1.5`).
  No `apt-get install` was needed.
- Built a minimal app (`main.js` + `appfiles/index.html`, `w.js`, `data.json`, `sample.wav`) and ran:
  `xvfb-run -a npx electron . --no-sandbox` (also needs `--no-sandbox` because the process runs as
  root in this container — Electron refuses the Chromium sandbox for root otherwise, unrelated to
  Xvfb).

Renderer-side results (captured via `webContents.on('console-message')` and a final
`executeJavaScript` read of `window.__TEST_RESULT__`, quit after 8s):

```json
{
  "workletUrlResolved": "app://main/w.js",
  "audioWorklet": "ok",
  "fetchJson": { "status": 200, "body": { "hello": "world", "from": "app-scheme-fetch" } },
  "audioElement": { "duration": 2, "readyState": 4, "networkState": 1, "ok": true },
  "fullFetch": { "status": 200, "headers": {"content-length":"352878","content-type":"audio/wav","accept-ranges":"bytes"}, "bytesReceived": 352878 },
  "rangeFetch": { "status": 206, "headers": {"content-range":"bytes 100-199/352878","content-length":"100",...}, "bytesReceived": 100 },
  "midi": "error: Platform dependent initialization failed."
}
```

Findings per sub-part:

- **(a) AudioWorklet via `new URL('./w.js', import.meta.url)` from an ES-module page loaded over a
  privileged custom `app://` scheme** — works. `protocol.registerSchemesAsPrivileged` with
  `{standard:true, secure:true, supportFetchAPI:true, stream:true, corsEnabled:true}` +
  `protocol.handle('app', ...)` serving files via `net.fetch(pathToFileURL(...))` is sufficient;
  `import.meta.url`-relative resolution works normally because the scheme is `standard`.
- **(b) `fetch()` of a JSON file** over the same `app://` scheme — works, status 200, correct body.
- **(c) `<audio>` element + Range support over a second custom scheme `pads://`** — works, but
  **only with a hand-rolled Range handler**. Important finding:
  `net.fetch(pathToFileURL(file), { headers: { range } })` — i.e. forwarding the incoming
  `Range` header straight into `net.fetch` on a `file://` URL — **silently slices the response
  body to the requested byte range but reports `status: 200` and omits `Content-Range`/
  `Content-Length` headers** (verified: requesting `bytes=100-199` returned 100 bytes back but
  with `status 200` and no range headers). This is **not spec-conformant** and will confuse
  `<audio>`/`<video>` elements doing real seeking on large files (they rely on the 206 status and
  `Content-Range` to know the seek succeeded and the total size). The fix (implemented and
  verified here) is to parse the `Range` header yourself in the `protocol.handle` callback,
  `fs.readSync` the requested byte slice, and manually construct
  `new Response(buf, { status: 206, headers: { 'content-range': 'bytes A-B/total', ... } })`.
  With that manual implementation: full fetch → `200` + `content-length: 352878`; ranged fetch
  (`bytes=100-199`) → `206` + `content-range: bytes 100-199/352878` + 100 bytes. The `<audio>`
  element itself loaded metadata correctly (`duration: 2`, `readyState: 4`) against the manual
  handler.
- **(d) `navigator.requestMIDIAccess()`** with `session.defaultSession.setPermissionRequestHandler`
  / `setPermissionCheckHandler` allowing `'midi'`/`'midiSysex'` — the **permission layer passed**
  (no permission-denied error), but the call still failed with
  **`"Platform dependent initialization failed."`**. This is Chromium's Web MIDI service failing
  to open `/dev/snd/seq` (confirmed in the electron stderr: `ALSA lib seq_hw.c: open /dev/snd/seq
  failed: No such file or directory`) — **this container has no ALSA sequencer device**, not an
  Electron/permission bug. On a real Linux desktop with a MIDI/ALSA sequencer available (or a
  connected MIDI device), this should succeed. **This must be re-verified on the actual target
  machine/device** since it can't be exercised here.
- Also saw benign `dbus` connection errors (no session bus in the container) and ALSA `PcmOpen`
  errors for the default audio *output* device — expected in a headless container without a sound
  server; unrelated to the app logic.

**Conclusion:** all of Electron's plumbing (custom privileged schemes, ES modules, fetch, Range/
seeking, MIDI permission flow) works as expected on Linux; the only failure is hardware/container
specific (no ALSA MIDI sequencer here) and the Range-handling gotcha above (needs manual 206
implementation, don't rely on `net.fetch` header pass-through).

---

## Q3 — Sample hosts

### midi-js-soundfonts (raw.githubusercontent.com)

Tested `C4`, `Db4`, `C#4` (literal), `A0`, `C8` against 9 instrument folders
(`acoustic_grand_piano`, `electric_piano_1`, `vibraphone`, `music_box`, `celesta`,
`acoustic_guitar_nylon`, `kalimba`, `glockenspiel`, `orchestral_harp`), all `*-mp3` folders.

**Naming convention confirmed uniformly across all 9 instruments: flats (`Db4`), not sharps
(`C#4`).** `C#4.mp3` → **404** (14-byte GitHub error body) in every single case; `Db4.mp3` → **200**
in every case. `A0` and `C8` (range extremes) both exist for every instrument tested (200 OK).

Representative sizes (bytes, `acoustic_grand_piano-mp3`): C4=20177, Db4=20177, A0=25403, C8=14041.
All other instruments returned 200/appropriately-sized files for C4/Db4/A0/C8 too (13–23 KB range).

Downloaded `acoustic_grand_piano-mp3/C4.mp3` (20,177 bytes) and ran `ffprobe`:
```
codec_name=mp3, sample_rate=44100, channels=2
duration=3.160816s, bit_rate=51067
```

### `api.github.com/repos/darosh/samples-piano-mp3/git/trees/master?recursive=1`

**Blocked — HTTP 403, but not by GitHub.** The response body is from this session's own egress
proxy, not GitHub's API:
```
{"message":"GitHub access to this repository is not enabled for this session. Use add_repo to
request access...","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}
```
i.e. `api.github.com` calls are gated by the sandbox's GitHub integration (repo not attached to
this session), independent of whether the repo/API itself would be reachable. Could not summarize
the tree. If this host is needed for real, either fetch it outside this sandbox or attach the repo
via the session's `add_repo` mechanism.

### SalamanderGrandPiano (raw.githubusercontent.com)

- `Samples/C4v8.flac` → 200, **1,774,472 bytes** (~1.7 MB, not 3 MB as one might guess from a single
  velocity layer — still a solidly large per-note file).
  `ffprobe`: `codec_name=flac, sample_rate=48000, channels=2, bits_per_raw_sample=24`,
  `duration=16.187s`.
- `Salamander%20Grand%20Piano%20V3.sfz` → 200, 2113 bytes. It's a *wrapper* file that
  `#include`s note/velocity data from `Data/*.txt` (also fetched to resolve the actual layout):
  - **16 velocity layers** (`Data/notes.txt`: 16 `<group>` blocks, `vel_01.txt`..`vel_16.txt`,
    velocity ranges from `1-26` up to `121-127`).
  - **30 sampled note names**, one every minor third across the keyboard (`Data/region.txt`):
    `A0, C1, D#1, F#1, A1, C2, D#2, F#2, A2, C3, D#3, F#3, A3, C4, D#4, F#4, A4, C5, D#5, F#5, A5,
    C6, D#6, F#6, A6, C7, D#7, F#7, A7, C8` — i.e. flat/sharp-as-`D#`/`F#` naming (uses `#` in
    filenames here, unlike midi-js-soundfonts which uses `Db`-style flats and rejects `#`).
    So **file naming conventions differ between these two sample sets** — don't assume one scheme
    covers both.

### ffmpeg transcoding

`ffmpeg -version` shows `--enable-libmp3lame --enable-libopus --enable-libvorbis` all built in.
Actually transcoded the 1.7MB FLAC:
- → mp3 (`libmp3lame`, `-qscale:a 4`): succeeded, 135,285 bytes.
- → opus (`libopus`): succeeded, 245,389 bytes.
- → ogg/vorbis (`libvorbis`): succeeded, 177,606 bytes.

**Conclusion: ffmpeg here can transcode FLAC → mp3, opus, or ogg/vorbis natively, no missing
codecs.**

---

## Q4 — Headless Chromium decode time & memory

Same chromium (1194) via playwright 1.56.0, `decodeAudioData` on two files:

| File | Size | Decode time | Result duration |
|---|---|---|---|
| `piano_C4.mp3` (real sample, Q3) | 20,177 bytes (~20 KB) | **13.1 ms** | 3.129s, 44100Hz, 2ch |
| `big_3mb.mp3` (FLAC→mp3, looped 16s FLAC ×11 @192kbps, FLAC-derived) | 4,275,117 bytes (~4.2 MB, closest available to the requested "3MB" scale) | **782.6 ms** | 178.06s, 44100Hz, 2ch |

Decode time scales roughly with output-samples decoded (~178s of audio in 783ms ≈ 227x
real-time), not raw file size — consistent with MP3 decode cost being dominated by frame count.

Memory for a decoded 10s stereo 48kHz buffer:
- **Computed directly:** Web Audio buffers are stored as planar Float32 per channel:
  `10s × 48000 samples/s × 2 channels × 4 bytes/sample = 3,840,000 bytes (~3.66 MB)`, plus
  small per-channel/object overhead.
- **Measured via `performance.memory`:** allocating `ctx.createBuffer(2, 480000, 48000)` moved
  `usedJSHeapSize` by only ~88 bytes — because the actual PCM sample storage for an `AudioBuffer`
  lives in **native (non-V8-heap) memory**; `performance.memory` only reflects the JS heap and
  under-reports real audio memory use. **Use the computed formula (channels × samples × 4 bytes),
  not `performance.memory`, to budget AudioBuffer memory.**

---

## Summary of build-relevant conclusions

1. Real-time `AudioContext` works headless in Playwright/Chromium with
   `--autoplay-policy=no-user-gesture-required` — no need to fall back to `OfflineAudioContext`
   for testing.
2. Electron 44.4.5 on this Linux container works for all the custom-protocol/ES-module/fetch/Range/
   MIDI-permission plumbing the app needs; the one real gap (no ALSA MIDI sequencer) is a container
   limitation, not a code defect — **re-verify MIDI on real target hardware**. Don't rely on
   `net.fetch(file://, {headers:{range}})` to produce a conformant 206 — implement Range parsing
   manually in the `protocol.handle` callback.
3. `midi-js-soundfonts` uses flat naming (`Db4`) and has no sharp-name aliases; `SalamanderGrandPiano`
   uses sharp naming (`D#4`) with 30 notes × 16 velocity layers per note, ~1.7MB per top velocity
   FLAC sample — naming schemes are inconsistent between sample sets, and any loader needs to
   normalize note-name → filename per-source. `api.github.com` tree browsing is blocked in this
   sandbox (proxy-level, not GitHub) — don't rely on it here; use raw file fetches instead.
4. ffmpeg here can transcode FLAC to mp3/opus/vorbis with no missing codec build.
5. MP3 decode cost in headless Chromium is small (~13ms for a 20KB single-note sample; ~0.8s for
   a 4.2MB/178s file) — well within budget for a pad-triggering app loading many samples. Budget
   AudioBuffer memory as `channels × sampleRate × seconds × 4 bytes`, not via `performance.memory`.
