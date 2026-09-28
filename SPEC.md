# Worship Rig — Architecture & Module Contract (v3)

Target user: Ryan, Apple Silicon Mac, MIDI keyboard + sustain pedal, no audio-dev background.
Purpose: open the app, play the MIDI keyboard, hear great pads/keys (worship, ambient, lofi), run a key drone under a set,
step through songs without audio gaps, record to WAV.
Runs (a) as an Electron app built on the user's Mac (`npm run build:mac`) and (b) in Chrome launched by a double-click
launcher — **byte-identical renderer, same local HTTP server module in both**. No bundler, no CDN, no network at runtime.
Vanilla ES2022 modules. No TypeScript. Root package is CommonJS (main.js/preload.js/server.js); `app/package.json` = `{"type":"module"}`.

v3 incorporates REVIEW.md (adversarial review) and VERIFY.md (empirical checks). Design lineage: Song → Setlist → four fixed
slots, Easy Transpose, wheel macros, MIDI Learn on a handful of controls — distilled from Sunday Keys and simplified.

---
## 0. Non-negotiables (every agent)
1. **Relative URLs only.** Page origin is `http://127.0.0.1:<port>/` in both Electron and Chrome. Worklets via `new URL('./x.js', import.meta.url)`.
2. **Never call AudioParam automation directly.** Use `rampTo/glideTo/setNow` from `app/js/shared/automation.js` (they `cancelAndHoldAtTime` first). Release = time to −60 dB (τ = release/6.9); `stop(t + release*1.3)`.
3. **Never click, never gap.** Song/instrument switches keep physically-held and pedal-held voices on the *old* instrument until their own release (MainStage semantics). Only new note-ons go to the new instrument.
4. **Voices are tracked by physical key.** `sounding: Map<physNote, Voice[]>` recorded at noteOn; noteOff/pedal-up release exactly those. Split/transpose are evaluated once at noteOn.
5. **Every time-sensitive public engine call takes optional `when` (ctx seconds).** All internal timing is derived from audio-clock event times or `onended` — never `setTimeout` — so the engine renders correctly in an `OfflineAudioContext`.
6. **Long user pad files are streamed** (`<audio>` + `MediaElementAudioSourceNode`, same-origin), never `decodeAudioData`.
7. **Recordings stream to disk** as Int16, header patched at close and every 10 s (crash-safe); in-memory fallback warns above 10 min.
8. **Deterministic when seeded:** `new AudioEngine({ context, seed })` — noise IRs, oscillator phases, crackle, drift all from one PRNG.
9. **Errors degrade, never throw to UI:** `console.warn` + `engine` `warn` event. Tests assert zero `console.error`.
10. **File ownership is strict** (§1). Contract changes → write `CONTRACT_CHANGES.md` and stop; the orchestrator merges.
11. **Expensive work happens in `prepare`, never in `commit`** (IR build, PeriodicWave creation, decode, DOM re-render, autosave → `requestIdleCallback`).

---
## 1. Repo layout & FILE OWNERSHIP

```
worship-rig/
  package.json, build/icon.png, README.md, Start Worship Rig.command     [shell]
  server.js         [shell]  CommonJS static server module: serve(appDir, {port, padsRoot}) → Range-capable (206/Content-Range/Accept-Ranges via fs.createReadStream), correct MIME (.js/.mjs text/javascript, .wasm, .mp3, .wav, .json, .webmanifest), /pads/<token>/<rel> from the chosen pad folder, /api/pads (list). Used by BOTH main.js and serve.mjs. Reuses an existing server on the port if health check /api/health answers.
  serve.mjs         [shell]  CLI: `node serve.mjs [--port 8437] [--open]` → launches Chrome dedicated profile (--user-data-dir "$HOME/Library/Application Support/Worship Rig Chrome" --app=http://127.0.0.1:8437/ --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding)
  main.js           [shell]  Electron: starts server.js on 8438, window → http://127.0.0.1:8438/, MIDI permission handlers (request+check; 'midi' only), powerSaveBlocker, menu (⌘. Panic, ⌘E view, ⌘←/⌘→ songs — no bare arrows), IPC for save dialog/stream write/pad folder, auto-backup JSON to userData (keep 10)
  preload.js        [shell]  contextBridge → window.rig (§7)
  LICENSES.md       [samples]
  app/
    package.json {"type":"module"}   [shell]
    index.html, styles.css, icons/   [ui]
    js/
      shared/music.js      [phase0]  KEYS as pitch-class ints, keyName(pc,minor), parseNoteName, transposeSemis(play,hear), noteToFreq, chord spelling helpers
      shared/params.js     [phase0]  PARAMS table: address grammar + {min,max,default,unit,curve}, faderTaper(pos)→gain, gainToDb
      shared/automation.js [phase0]  rampTo, glideTo, setNow, fadeCurveEqualPower
      shared/prng.js       [phase0]  mulberry32(seed), gaussian
      shared/keydetect.js  [phase0]  detectKeyFromName(name) → {pc, minor} | null (tokenizer grammar, §5.3)
      shared/chords.js     [phase0]  chordName(pcs, bassPc, keyPref) → {name, root, quality, bass}
      shared/wav.js        [phase0]  wavHeader(sampleRate, channels, dataBytes), int16Encode(Float32Array[])
      store.js             [shell]   state model + persistence (§2); injectable storage adapter
      controller.js        [shell]   the ONLY owner of selectSong / store→engine diffing / perform-time input routing (§6)
      midi.js              [shell]   Web MIDI in, sustain/expression, learn with pickup, hot-plug, `_inject(bytes, ts)` for tests
      recorder.js, worklets/recorder-processor.js  [shell]
      presets.js           [shell]   factory Songs (§8); ids stable
      main.js              [ui]      bootstrap: store → engine → controller → views
      views/perform.js, views/edit.js, views/settings.js, views/components/*.js   [ui]
      engine/index.js, audio.js, sampler.js, drone.js, fx.js, instruments.js (registry/listInstruments), test.html   [engine-core]
      engine/synth.js, engine/organ.js, engine/voice.js (shared voice/env helpers)                                  [engine-instruments]
    samples/manifest.json, samples/<id>/...   [samples]
  test/                    [integration]  playwright + node:test; screenshots/; audition/
  tools/calibrate.mjs, tools/audition.mjs   [integration]
```
Agents & phases: **phase0** (shared modules; small, done first and reviewed), then in parallel **engine-core**, **engine-instruments**, **shell**, **samples**; then **ui**; then **integration** (may edit any file to fix bugs, must log changes in `INTEGRATION_NOTES.md`).

---
## 2. Domain model (store.js)

```js
Song {
  id, name, notes,
  playIn: pc(0..11), hearIn: pc, transposeOctave: -1|0|1, minor: bool,
  patch: Patch,
  drone: { mode:'off'|'synth'|'files', gain, brightness, movement, width, fade, chordFollow:false, continueAcrossSongs:true, minorUsesRelativeMajorFile:true },
  tempo: number|null
}
Patch {
  slots: [Slot|null ×4],            // roles 0 Keys(orange) 1 Pad(green) 2 Extra(blue) 3 Bass(purple)
  fx: { reverb:{size,damp,predelay,returnGain}, delay:{time,feedback,pingpong,tone,sync,returnGain}, chorus:{rate,depth,returnGain},
        lofi:{amount,wow,flutter,crackle,bits,tone,saturation}, master:{volume} },
  modWheel:   { target: WheelTarget, min:0, max:1 },      // default 'slots.1.gain' (pad swell)
  expression: { target: WheelTarget, min:0, max:1 },      // CC11, default 'slots.1.gain'
  volume:     { target: WheelTarget },                    // CC7 (keyboard volume knob/slider), default 'master.volume'
  bend: { mode:'pitch'|'morph'|'drone-swell'|'tape'|'none', range:2 },
  swell: { seconds: 8 }                                   // "Swell" button behaviour (see below)
}
WheelTarget = 'slots.<i>.gain' | 'drone.gain' | 'fx.reverb.returnGain' | 'master.volume' | 'macro.intensity' | 'macro.wash' | 'none'
// Macros (engine implements; one wheel drives several things at once — the "build the bridge with one hand" move):
//   macro.intensity x: pad slot gain × lerp(.35,1,x); pad-like synth slots filter cutoff +lerp(0,1800,x)¢ via morph; reverb returnGain × lerp(.8,1.15,x); glass-pad octave bloom x
//   macro.wash      x: reverb size → lerp(size, .9, x) (idle-convolver swap, debounced), reverb returnGain × lerp(1,1.6,x), delay feedback → lerp(fb,.75,x)
// Bend modes: 'pitch' (synth/organ slots with bendEnabled), 'morph' (each slot instrument.morph(|x|)),
//   'drone-swell' (push up: drone.gain rises toward 1 while held, falls back over 3 s when released; pull down: drone ducks to .3),
//   'tape' (pull down: tape-stop — global playbackRate/pitch glide down via lofi wow delay + LPF close; release recovers over 1 s; push up: filter sweep)
// Swell button (for keyboards WITHOUT wheels; also learnable and on-screen): automates the modWheel value 0→1 over `swell.seconds`; pressing again (or release for a held footswitch) returns it to the pre-swell value over 4 s.
//   Computer keys: ↑/↓ nudge the virtual mod wheel; Shift+↑ = Swell; on-screen wheel strip in Perform shows the effective wheel value whatever its source (hardware, button, or automation). Hardware CC always takes over (pickup) from the virtual value.
Slot {
  instrument: { type:'sampler'|'synth'|'organ', id },
  gain (linear, fader taper), pan, octave, transpose, lowNote, highNote, sustain:true, bendEnabled,
  mono:'off'|'lowest'|'highest', velocityCurve:'soft'|'normal'|'hard'|'fixed',
  sends: { reverb, delay, chorus },   // 0..1; Bass defaults 0/0/0; Keys .25/.1/0; Pad .5/.15/.4; Extra .35/.2/.2
  params: { ...instrument-specific, from listInstruments() }
}
Setlist { id, name, songIds:[] }
Settings { latency:'lowest'|'balanced'|'safe', outputDeviceId:'default'|id, monoOutput:false, midiInputId:'first'|'all'|id, programChange:false,
           pedalInvert:false, velocitySens:'normal', midiLearn:{ [controlId]: {cc, channel} }, padFolder:{kind:'electron',path}|{kind:'fsa'}|null,
           currentSetlistId, currentSongId, view:'perform'|'edit', performLock:false, computerKeyboard:true }
```
Defaults per role: Bass `{mono:'lowest', highNote:59, sends 0}`, Pad `{sustain:true}`, Keys `{sustain:true}`, Extra `{}`.
Store API: `create({storage})`, `get()`, `set(path, value)` (path uses the §4 grammar for patch params, `songs.<id>.name` for entities), `update(fn)`, `subscribe((state, changedPaths) => {})`, `addSong(fromSongOrPreset)`, `duplicateSong`, `deleteSong`, `moveSong(setlistId, from, to)`, `exportJSON()`, `importJSON(text)`, `seedFactory()` on first run (factory songs copied with new ids; `factoryId` kept for "reset to factory"). Persistence key `rig.v1`, debounced 300 ms, `migrate(state)` idempotent; unknown fields preserved; future schema refused with backup of raw string; corrupt → factory reset + backup. Chrome and Electron have separate libraries (different browser profiles) — README says so; export/import bridges them.

---
## 3. Engine contract (engine-core; engine-instruments implements instruments)

```js
import { AudioEngine } from './engine/index.js';
const engine = new AudioEngine({ context?, seed?, latency?: 'interactive'|number });
await engine.start();                         // idempotent; offline ctx: skip resume, files mode disabled (warn)
await engine.restart({ latency?, sinkId? })   // new ctx + graph, re-applies current state; decoded cache survives
engine.ctx, engine.recordTap /*post-clip, exact output*/, engine.analyserL/R
engine.addEventListener: 'notes' {held:Set}, 'chord' {chord}, 'loading' {slot, progress 0..1}, 'ready', 'warn' {message}, 'statechange' {state, latencyMs}, 'stats'
engine.latencyMs                              // baseLatency + outputLatency (ms)
engine.setSinkId(id) (via restart if unsupported), engine.setMono(bool)

// Instruments
engine.listInstruments() → [{ ref:{type,id}, name, group:'Piano'|'Electric Piano'|'Organ'|'Synth Pads'|'Synth Keys'|'Mallets & Bells'|'Guitar'|'Bass', params:[{key,label,min,max,default,unit,curve}], license }]
// Patch lifecycle
const token = await engine.prepare(patchState)   // decodes/builds everything; resolves when ready; multiple prepares → only latest token may commit
engine.commit(token, { when })                   // gapless swap (§0.3); retires old instruments; disposes after live voices==0 for 1 s (audio-clock based)
engine.preload(patchStates[])                    // warm decoded cache (setlist); pinned instruments never evicted
engine.setParam(path, value, { when })           // grammar §4; smoothed. e.g. 'slots.1.gain', 'slots.0.params.tone', 'fx.reverb.size', 'drone.gain', 'master.volume'
engine.getParam(path)
engine.setTranspose(semis /*incl. octave*/, { when })   // affects new note-ons only; never touches drone
engine.setTempo(bpm|null)
engine.setRouting({ modWheel, expression, volume, bend, swell })   // from Patch; engine combines: effective = fader × lerp(min,max,wheel); lastWheel initial 1.0; macros per §2
engine.setWheel(source:'mod'|'expr'|'vol'|'virtual', value01, { when })   // controller feeds hardware CC or virtual/automated values; engine resolves pickup
engine.swell(start:boolean, { when })                      // Swell button automation (§2); engine emits 'wheel' {source, value} events for the UI strip

// Perform input (all `when` optional)
engine.noteOn(note, vel, { when }); engine.noteOff(note, { when }); engine.sustain(bool, { when })
engine.pitchBend(-1..1, { when }); engine.modWheel(0..1) = setWheel('mod'); engine.expression(0..1) = setWheel('expr'); engine.volumeCC(0..1) = setWheel('vol')
engine.allNotesOff({ when })   // panic: 30 ms fade all voices, clear pedal & sounding, bend→0, delay feedback→0 for 200 ms, drone untouched
engine.fadeOutAll(seconds=6)   // master fade incl. drone; next noteOn restores master instantly
engine.activeNotes             // physically held (untransposed)
engine.heldChord()             // from physically held notes, spelled per current key preference
engine.getState()/applyState() // test & audition only; controller uses setParam/prepare/commit
engine._debugStats() → { voices, nodes, retiring, decodedMB }
engine.dispose()
```

### 3.1 Signal topology (fx.js)
```
slot[i] → slotGain(fader×wheel) → pan ─┬─ dry bus ───────────────────────────────┐
                                        ├─ send.reverb → [HPF180,LPF9k] → reverb ─┤
                                        ├─ send.delay  → delay (2 lines xfade) ───┤ → sum → lofi (bypassable) → master gain → catcher comp → tanh clip(4x, −0.3 dBFS) → [mono sum?] → destination + recordTap
                                        └─ send.chorus → chorus ──────────────────┤
drone.synth → (its own reverb send .4 + dry) ────────────────────────────────────┤
drone.files → dry only ──────────────────────────────────────────────────────────┘
```
- Reverb: two convolvers crossfaded (idle one receives new IR during prepare / debounced 300 ms; `normalize=false`, own energy norm; idle input disconnected after fade). IR recipe: per channel independent seeded noise in 7 octave bands, RT60 = size×[125:1.2, 250:1.1, 500:1.0, 1k:0.9, 2k:0.8, 4k:0.5, 8k:0.3] × 9 s max; 30 ms cosine fade-in; 6–10 random early taps 7–60 ms; low shelf −6 dB < 150 Hz; length 1.1×longest RT; buckets 1.5, 2, 2.8, 3.8, 5, 6.5, 8 s; predelay via DelayNode.
- Delay: `createDelay(2)`, feedback ≤ .9 with tone LPF in loop, ping-pong option, two lines crossfaded when time changes > 5 %; sync 'off'|'1/4'|'1/8d'|'1/8' from tempo.
- Chorus: 2 voices, 7 ms base, ±2 ms, rate .15–1.5 Hz, stereo.
- Lofi (after reverb, before master): saturation (tanh, 4x, 0→+9 dB) → quantize WaveShaper (16→11 bits, curve from `bits`; no worklet) → wow/flutter (DelayNode base 5 ms; wow .35 Hz ±2 ms; flutter 5 Hz ±.03 ms) → tilt (LPF 18k→3.5k, HPF 20→120) → + crackle (sparse impulses, BPF, −60→−38 dBFS). `amount` macro scales all; engage/bypass with 30 ms crossfade; amount 0 ⇒ wet chain disconnected (bit-exact bypass).
- Master: catcher compressor (thr −3, knee 3, ratio 12, att .003, rel .25) → tanh WaveShaper ceiling −0.3 dBFS. Default master −6 dB. Mono option: sum −3 dB.
- Continuous controls coalesced ≤ 1 update / 10 ms, τ 15 ms.

### 3.2 Instrument interface (engine-instruments implements synth & organ; engine-core implements sampler & drone-osc use)
```js
class Instrument { constructor(ctx, prng, def, initialParams); output: GainNode; ready: Promise;
  noteOn(note, vel01, when) → Voice; noteOff(voice, when); allOff(when, fadeSec=0.03);
  setParam(key, value, when); morph(x01, when); setBend(semis, when) /*if bendable*/; liveVoiceCount(); dispose() }
class Voice { kill(when) /*stops every source incl. LFOs, disconnects on last onended*/; releaseAt(when); note; startedAt }
```
Max 16 voices per instrument; steal oldest-released then oldest-held with 20 ms fade. Re-strike of a pedaled note: fade old voice 30 ms then start new.

### 3.3 Synth patches (synth.js) — ids & robust recipes
- `warm-pad`: 5 saws (0, ±9¢, ±17¢) panned ±0.6, random start phase via 8 pre-built phase-rotated PeriodicWave saws; sub tri −12 dB; HPF 120 Hz; LPF = two biquads Q .54/1.31 at 1.8 kHz, keytrack 50 %, velocity ±30 %; LFO .08 Hz on filter detune ±300¢; env A 1.2 D .5 S .8 R 3; voice gain −3 dB/oct above C4; mono below 150 Hz. morph = filter sweep (+2400¢).
- `glass-pad`: tri + sine partials (1, 2, 3 @ −6/−14 dB), chorus-heavy; "octave bloom" voice +12 fades in on morph.
- `strings`: 5-voice unison saw, A .4 R 1.8, delayed vibrato (.5 s onset, 5 Hz ±8¢), LPF 4 kHz, HPF 150 Hz; morph = brightness.
- `sub-bass`: sine + tri, mild tanh for 2nd harmonic, LPF 250 Hz, mono legato 30 ms; morph = drive.
- `soft-keys` (EP): FM 1:1 index `0.3 + 1.5·vel` decaying to .2 τ .4 s; tine modulator 14:1 index .8 τ 30 ms; keytracked amp decay τ 3 s@C3 → .8 s@C6; stereo tremolo 4.5 Hz (depth param); soft sat 4x; morph = tremolo depth.
- `bell`: FM ratio 3.5→(morph) 5.1, index 2 decaying, long decay; morph = ratio.
- `drone-osc` (for drone.js): 4 voices warm-pad-like, per-voice ±3¢ random walk, HPF 80 Hz, extra slow unison drift.
Cut from v1: choir-pad, lofi-keys as a patch (it is a preset: soft-keys + lofi FX).

### 3.4 Organ (organ.js) — additive via PeriodicWave
One oscillator per voice at f/2 with a PeriodicWave (`disableNormalization:true`) containing harmonics 1,3,2,4,6,8,10,12,16 for drawbars 16′,5⅓′,8′,4′,2⅔′,2′,1⅗′,1⅓′,1′; amplitude `d ? 10**(-3*(8-d)/20) : 0`. One wave per drawbar preset (rebuilt on param change, debounced, in prepare). Key click: 4 ms noise burst BPF 2–4 kHz. Percussion: 3rd harmonic, τ .2 s, single-trigger. Overdrive: tanh 4x before rotary. Rotary: crossover 800 Hz; horn delay ±.35 ms + 3 dB AM; drum 2 dB AM; speeds horn .8→6.8 Hz, drum .7→5.9 Hz; inertia τ .3 s / 1.5 s; L/R 90° apart. Presets: `gospel` 888800000 fast, `soft-pad` 008800000 slow, `full` 888888888, `church` 806000000 no rotary, long release. morph = rotary fast/slow. No scanner vibrato in v1.

### 3.5 Sampler (sampler.js) — decaying instruments only
Manifest-driven. Layer by velocity, nearest note, playbackRate repitch. Onset trim at decode: first sample > −50 dBFS minus 1 ms, 2 ms fade-in. Length cap with 1 s fade: 10 s above C4, 16 s below. Velocity gain span −10 dB (multi-layer) / −24 dB + LPF 2k→12k (single-layer). Release exponential τ .12 s (piano), param; notes ≥ 90 ignore release. Decoded-buffer LRU (cap 700 MB by formula ch×frames×4, not performance.memory), setlist instruments pinned; never decode while playing unless requested by prepare.

### 3.6 Drone (drone.js)
Synth voicing default **root + 5th + octave (+ 9th when brightness > .6); no third** unless chord-follow. Key changes crossfade over `fade` (equal-power). Same key → no-op. `continueAcrossSongs` else fade out on song change. Files mode: pool of 4 `<audio>` elements, loop region `[8 s, duration − 12 s]`, incoming element started 1.5 s early at gain 0, ramp after `playing` event, equal-power curves, random start offset, `ended` fallback; minor song → relative-major file when enabled; chordFollow disabled in files mode (UI says so). No pad folder → synth fallback + toast.
**Chord-follow (experimental, off by default, implemented LAST):** input = held notes < followSplit (C4) ∪ lowest held; debounce 150 ms (event-time based); < 2 pcs → hold. Bass voice = lowest pc in C2–B2; 3 upper voices in C3–C5 choosing pcs by priority 3rd > 7th > 5th > 9th > root; cost = Σ|Δ| + 6·(interval < 3 semis below C3) + 3·duplicates; exhaustive search; |Δ| ≤ 2 semis → glide 1.2 s, else crossfade old 1.5 s / new 2 s. `_debugTargets()` returns target freqs.

---
## 4. Parameter address grammar (shared/params.js) — used by store.set, engine.setParam, MIDI learn, presets
`slots.<i>.gain|pan|octave|transpose|lowNote|highNote|sustain|mono|velocityCurve|bendEnabled`, `slots.<i>.sends.reverb|delay|chorus`, `slots.<i>.params.<key>`,
`fx.reverb.size|damp|predelay|returnGain`, `fx.delay.time|feedback|pingpong|tone|sync|returnGain`, `fx.chorus.rate|depth|returnGain`,
`fx.lofi.amount|wow|flutter|crackle|bits|tone|saturation`, `master.volume`, `drone.gain|brightness|movement|width|fade`.
Gains stored linear 0..2 (fader taper `2·pos³`, display dB). Frequencies in Hz (`curve:'log'`), times in seconds, everything else 0..1 unless the table says otherwise. Learnable controlIds: `slots.0.gain slots.1.gain slots.2.gain slots.3.gain drone.gain fx.reverb.returnGain master.volume nextSong prevSong panic fadeOutAll swell` (buttons: note-on or CC ≥ 64; faders: pickup mode).

---
## 5. Shared pure modules (phase0)
5.1 `music.js`: `KEY_NAMES_MAJOR = C Db D Eb E F F# G Ab A Bb B`, `KEY_NAMES_MINOR = Cm C#m Dm Ebm Em Fm F#m Gm G#m Am Bbm Bm`, `keyName(pc, minor)`, `parseNoteName('Db4'|'C#4') → midi`, `noteName(midi, pref)`, `transposeSemis(play, hear) = ((hear-play+18)%12)-6`, `noteToFreq`, `relativeMajor(pc)`.
5.2 `chords.js`: qualities maj, min, sus2, sus4, 5, 7, maj7, min7, dim, aug, add9, 2(=sus2 display "2"), 6, min6, 9, maj9, min9, 7sus4; tie-break root==bass, fewer non-triad tones, table order; 1 note → name; 2 notes → power chord if 5th else null (caller keeps previous); slash when bass≠root; spelling by key preference.
5.3 `keydetect.js`: tokenize `base.split(/[\s_\-().,\[\]]+/)`; per-token `^([A-G])(#|♯|b|♭|sharp|flat)?(m|min|minor|maj|major|M)?$` (letter and m/M case-sensitive; `Maj7`/`M7` → major); two-token forms (`E flat`, `F minor`, `Key of X`, `in X`); score: "key of"/"in" (3) > accidental or quality present (2) > bare capital letter (1; a bare `A` is dropped when any later candidate follows it, since it is usually the English article); ties between different keys → null; map Cb/Fb/E#/B#. Table §11.
5.4 `automation.js`, `prng.js`, `wav.js` as named. 100 % unit-tested with `node --test`.

---
## 6. Controller (shell) — the only place store and engine meet
`createController({store, engine, midi, recorder})`:
- `selectSong(id)`: token = prepare(song.patch) → commit(token) → setTranspose → setRouting → drone.setKey(hearIn, minor) unless same → setTempo → preload(prev,next). Double-tap safe (latest token wins; old keeps playing; UI shows "loading").
- `store.subscribe` diff → `engine.setParam` for patch/drone params of the *current* song only; entity changes ignored by engine.
- `perform`: `noteOn/off/sustain/bend/wheel/expression` from midi (with pedalInvert, velocitySens, refcounted note-ons, velocity-0 = off, 14-bit bend `(v-8192)/(v<8192?8192:8191)`, CC64 ≥ 64, CC11 expression, learned CCs with pickup, Program Change → song index when enabled), computer keyboard when enabled and focus not in input/textarea/select/range, hot-plug: on input disconnect release its notes + pedal.
- `nextSong/prevSong/panic/fadeOutAll/toggleView/transposeUp/Down` (perform-time transpose ±1 adjusts hearIn).
- Watchdog 1 s: ctx state + currentTime advancing → resume → else `statechange 'stalled'` → UI "Restart audio". `navigator.mediaDevices.ondevicechange` → statechange. Wake lock (Chrome) / powerSaveBlocker (Electron).
- Views call only `store.set(...)` for persisted state and `controller.*` for transient actions. Never `engine` directly.

---
## 7. Shell specifics
`window.rig` (preload; every method returns a Promise; errors as `{error}`):
`{ isElectron, platform, saveFileDialog(defaultName)→{path}|null, streamOpen(path)→{id}, streamWrite(id, ArrayBuffer /*transferred*/), streamPatchHeader(id, ArrayBuffer44), streamClose(id), choosePadFolder()→{path}|null, padsBaseUrl()→'/pads/<token>/', listPads()→[{name,url}], backupNow(json), onMenu(cb) }`
Chrome equivalents (feature-detect): recorder → `showSaveFilePicker` writable (document .crswap caveat; auto-stop on `pagehide`) → fallback in-memory; pads → `showDirectoryPicker` handle in IndexedDB, object URLs; wake lock.
Electron main: server.js on 8438; `setPermissionRequestHandler` + `setPermissionCheckHandler` allow `midi` (not sysex); `webPreferences {preload, contextIsolation:true, nodeIntegration:false, autoplayPolicy:'no-user-gesture-required', backgroundThrottling:false}`; `powerSaveBlocker.start('prevent-display-sleep')`; menu accelerators ⌘. ⌘E ⌘← ⌘→ ⌘R(record) only.
electron-builder: `appId com.ryan.worshiprig`, `productName "Worship Rig"`, mac `target:['dir','zip']`, `arch:['arm64']`, `hardenedRuntime:false`, `identity:null` **plus** `afterSign`/`afterPack` hook running `codesign --force --deep -s - <app>` on darwin; `category public.app-category.music`; `files:["main.js","preload.js","server.js","app/**/*","!app/js/engine/test.html","README.md"]`. Electron pinned to 44.x (verified), electron-builder latest. Scripts: `start`, `build:mac`, `serve` (= `node serve.mjs --open`), `test`.
Launcher `Start Worship Rig.command`: `cd "$(dirname "$0")" && node serve.mjs --open` with a friendly message if `node` is missing (link to nodejs.org).
Recorder: worklet `{numberOfInputs:1, numberOfOutputs:0}` on `recordTap`; Int16 chunks (~4096 frames) transferred; clamp ±1; sampleRate from ctx; provisional header at open, re-patched every 10 s and at close; filename `Rig YYYY-MM-DD HHmm.wav`; default dir `~/Music/Worship Rig/`; visible "Recording unavailable" if worklet fails (blob-URL retry first).

---
## 8. Factory songs (presets.js) — 11, stable ids, each with notes text
worship: **Sunday Pad + Piano** (salamander-piano + warm-pad, drone synth on), **Building Swell** (strings + glass-pad, wheel→pad), **Prayer Wash** (warm-pad only, big reverb, drone on), **Organ Swell** (organ gospel + warm-pad, bend morph=rotary);
keys: **Grand Piano**, **Rhodes** (ep-rhodes + soft chorus), **Felt Piano** (salamander + tone .3 + soft velocity + reverb .5);
lofi: **Lofi Rhodes** (soft-keys + lofi .6), **Dusty Piano** (salamander + lofi .5, crackle .6);
ambient: **Glass Ocean** (glass-pad + bell, delay sync 1/8d), **Sub + Shimmer** (sub-bass mono + glass-pad, drone on).
All gains set from the calibration table (§12). Every preset: modWheel → `slots.1.gain` (or the pad-like slot), expression → same, bend per notes.

---
## 9. Samples (samples-agent)
MusyngKite (**CC BY-SA 3.0** per the gleitz README — the repo's MIT file covers code only; attribution required, ShareAlike applies to the processed sample files), flats naming (`Db4`), A0..C8: `ep-rhodes`→electric_piano_1, `ep-wurli`→electric_piano_2, `vibes`→vibraphone, `celesta`→celesta, `music-box`→music_box, `nylon-guitar`→acoustic_guitar_nylon. (No GM piano — Salamander covers it.)
Salamander (CC-BY 3.0, Alexander Holm) from `sfzinstruments/SalamanderGrandPiano` raw FLAC `Samples/<Note>v<N>.flac` (sharps in filenames → rename to flats), 30 notes (minor thirds A0..C8), velocity layers **v4, v9, v14** → ffmpeg `-c:a libmp3lame -b:a 160k`, trim trailing < −60 dBFS after 8 s, fade 0.5 s; report total MB (target ≤ 45). Manifest as §3.5 with `layers:[{vel:[0,52],dir},{vel:[53,96]},{vel:[97,127]}]`, `release`, `gainTrim` (filled by calibration), `license`, `source`, `attribution`. Validator script asserts every listed file exists and decodes (ffprobe).
`LICENSES.md`: CC-BY attribution block, MIT notice, "user-imported pads never redistributed".

---
## 10. UI (ui-agent) — Perform + Edit + Settings; dark; stage-readable
**Perform:** wheel strip (effective mod-wheel value + Swell button + drone-swell indicator); song name + Hear-In key (Play-In small when transposed) + transpose −/+; prev/next + setlist strip; four colored slot faders (orange/green/blue/purple) with instrument name, wheel-position indicator, mute; drone block (12-key grid with proper names, major/minor, mode, gain, chord-follow when synth, "continues across songs"); notes card; REC + timer + meter; chord readout; MIDI LED/device; audio status + latency ms (warn > 40 ms) + **Restart audio** when stalled; Fade-out-all; Panic; Ready light (setlist preloaded); Edit button; Perform-lock. Keys: ← → songs (only when focus not in a control), ⌘E, Esc panic, ⌘R record.
**Edit:** left songs/setlists (add/dup/delete/reorder, factory browser by category, import/export); center 4 slot cards (instrument picker by group, gain/pan/octave/transpose, split mini-keyboard, sustain, mono, bendEnabled, sends, params from listInstruments), Easy Transpose (Play In / Hear In / octave), tempo + tap, wheel/expression/bend routing; right FX (Reverb/Delay/Chorus/Lofi macro + expanders/Master); bottom 61-key clickable keyboard + meter.
**Settings:** latency (lowest/balanced/safe → interactive/0.010/0.025 via restart), output device (enumerateDevices + setSinkId), mono, MIDI input, Program Change toggle, pedal invert + "press your pedal" first-run step, velocity sens, MIDI Learn table, pad folder, computer keyboard, decoded MB, backups.
First run: overlay "Click to start audio" (Chrome; Electron skips), MIDI "click Allow" hint, pedal step. Targeted DOM patching (no full re-render on song switch). Controls: styled `<input type=range>` with dB/unit labels, double-click resets, blur buttons after click (space = sustain only when nothing focused), `<link rel=icon>` present.

---
## 11. Tests (integration) — `npm test` = node:test (shared modules, store, controller w/ fake engine, wav) + Playwright (full Chromium new-headless, `--autoplay-policy=no-user-gesture-required`, `context.grantPermissions(['midi'])`, server.js on 8437)
- Real-time smoke: zero `console.error`; start; each factory song prepare/commit; noteOn 60 → RMS > −50 dBFS in 300 ms via **recorder-tap capture** (sample-exact), noteOff decays; no NaN.
- **Offline suite** (injected OfflineAudioContext, seed): sustain deferral; re-strike; mono lowest; split; transpose (sine sub-bass FFT peak, fftSize 32768, parabolic interp, 0.5 %; tritone & octave cases); gapless song switch while holding a chord (10 ms RMS windows never < −60 dBFS until key-up); lofi 0 ≡ never-created (sample-exact); lofi 1 changes centroid; delay sync; reverb size change no click; **stuck-note fuzz** (2000 random events incl. transpose/song switch/panic → voices 0, output < −90 dBFS); **click detector** (first-difference > 6× local median, HF bursts) around switches/steals/FX changes.
- Drone: setKey C→G continuous; files mode real-time with a generated **20 s** ogg/mp3 (whichever decodes) loops 30 s without a window < −60 dBFS; chord-follow `_debugTargets()` → D-F#-A pcs within 2 s.
- keydetect table (≥ 20 cases incl. "Pad - B.mp3"→B, "Bb Worship Pad"→Bb, "Ambient_Pad_-_F#m.mp3"→F#m, "Pad E flat"→Eb, "Pad 10 - G"→G, "Key of G# pad (Ab)"→Ab, "A Mighty Fortress Pad in D"→D, "Emin"→Em, "CM7 Pad"→C, "Pad_Bb_minor"→Bbm, "Deep Ambient"→null, "Pad C3"→C, "random.mp3"→null).
- midi `_inject`: running status, vel-0 off, 14-bit bend, CC64 threshold, disconnect releases, learn pickup, program change gating.
- Recorder: 1 s → valid header, sizes, 16-bit, 2 ch, non-silent, ±0.2 s; streaming via OPFS writable and via mock `window.rig`; header re-patch.
- Store: idempotent migrate, unknown fields preserved, future schema refused w/ backup, corrupt → reset w/ backup, export/import roundtrip, seedFactory once.
- Electron: `xvfb-run -a npx electron . --no-sandbox` boots, page loads from 127.0.0.1:8438, `console.error` count 0 (MIDI failure on Linux must be a warn), `/pads/...` Range → 206 with correct Content-Range, worklet loads.
- **Soak**: 20 min real-time random playing (CI-optional flag) → `_debugStats()` back to baseline, heap growth < 20 MB.
- Screenshots 1440×900 Perform/Edit/Settings.
- README gets a **manual Mac checklist** (build, launch, MIDI LED, pedal, every song, switch while holding a chord, record 30 s, unplug/replug keyboard, change output device, sleep/wake).

## 12. Calibration & audition (integration)
`tools/calibrate.mjs`: offline render C-E-G at vel 96 for 3 s per instrument, band-limited RMS 100 Hz–5 kHz → `gainTrim` so all sit at −20 dBFS RMS; write into manifest/instrument registry; calibrate drone vs a −20 dBFS reference.
`tools/audition.mjs`: 12 s clips (I–V–vi–IV, 2 s each + tail, sustain) per factory song and per synth/organ patch, stereo + mono renders; robot listener per clip (RMS −26..−16 dBFS, peak ≤ −0.3 dBFS, |DC| < .001, mono loss < 3 dB, no NaN/silence); `audition/index.html` with players + numbers. Orchestrator sends the pack to Ryan.

---
## 13. Phase 2 UI split (two agents in parallel) — component contract
**Source of truth for APIs in Phase 2 is the CODE** (app/js/store.js, controller.js, engine/*, presets.js, midi.js, recorder.js) plus CONTRACT_CHANGES.md; where SPEC §2–§7 differ from the code, follow the code.

Ownership:
- **ui-core**: app/index.html, app/styles.css, app/js/main.js (bootstrap: store → engine → controller → views; first-run overlay; view switching; toasts; keyboard shortcuts delegate to controller), app/js/views/perform.js, app/js/views/components/*.js, app/icons/*, test/phase2/ui-core/**
- **ui-edit**: app/js/views/edit.js, app/js/views/settings.js, app/styles-edit.css (linked from index.html by ui-core — ui-core adds `<link rel="stylesheet" href="./styles-edit.css">` and mount points), test/phase2/ui-edit/**

Mount points (ui-core creates in index.html): `<div id="view-perform">`, `<div id="view-edit" hidden>`, `<div id="view-settings" hidden>` (settings is a modal/panel), `<div id="toasts">`, `<div id="overlay-start">`. main.js calls `mountPerform(el, ctx)`, `mountEdit(el, ctx)`, `mountSettings(el, ctx)` where `ctx = { store, controller, engine, midi, recorder, toast(msg, kind), openSettings(), closeSettings(), setView(name) }`. Each mount returns `{ destroy() }`. Views subscribe to `store.subscribe` and `controller.onStatus` and patch DOM in place (no innerHTML re-render on song switch).

Components (ui-core, `app/js/views/components/`): every component is a function returning `{ el, set(value), destroy() }` and takes an `onChange` callback:
- `fader({ label, path, color?, min, max, curve:'lin'|'log'|'taper', unit, format(v)→string, vertical:boolean, onChange })` — styled `<input type=range>` + value label; double-click resets to default (from params.describe); keyboard accessible; emits on input (coalesced by rAF).
- `knob(...)` same API, compact horizontal variant.
- `toggle({ label, onChange })`, `segmented({ options:[{value,label}], onChange })`, `select({ options, onChange })`, `stepper({ min, max, step, onChange })`.
- `keyGrid({ onSelect(pc) })` 12 buttons with proper names via music.keyName, `set({pc, minor})` highlights current and shows names per major/minor.
- `miniKeyboard({ low, high, onRange })` split-range selector; `pianoKeyboard({ from:36, to:96, onNoteOn, onNoteOff })` 61-key clickable/draggable, `set(heldSet)` highlights.
- `meter()` stereo level meter driven by `engine.analyserL/R` (rAF), `set()` unused; `chordReadout()`; `wheelStrip({ onSwell })` shows effective wheel value + Swell button; `setlistStrip({ onSelect(id), onReorder }) .set({ songs, currentId, loadingId })`; `slotCard(...)` is ui-edit's (built from primitives).
- `toast` API lives in main.js (`ctx.toast`).
CSS: dark theme tokens in styles.css (`--bg, --panel, --text, --muted, --accent, --slot-0..3` = orange/green/blue/purple, `--danger`); large type in Perform (song name ≥ 40px, key ≥ 32px); min layout 1024×700; no external fonts. ui-edit uses the same tokens and component primitives; only edit/settings-specific styles go in styles-edit.css.
Tests: each UI agent adds a Playwright test that loads the real app (server.js on a free port), clicks the start overlay, and drives its views: selecting songs via strip/prev/next produces sound (analyser RMS), faders change engine params (engine.getParam), key grid changes drone key, settings changes persist in the store, no console.error, screenshots at 1440×900 into test/phase2/<agent>/screenshots/.
