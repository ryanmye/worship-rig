# sustain critic (2026-09-30)

Scope: CONTRACT_CHANGES "## sustain" (long piano tails, `slots.<i>.release`, `slots.<i>.pedalHold`, EQ straight in
Advanced). Baseline for every "before" number: the pre-sustain app snapshot
(`scratchpad/classic/snapA`, engine = the tree right before this change; `diff` shows only the sustain edits in
`engine/`), served by the same `server.js` and driven by the same scripts. 2-CPU Linux box, Chromium context at
44.1 kHz, suites serial.

## Verified

### 1. Memory in the real app (`engine._debugStats()`, `controller.status.memory`)

Fresh profile, `controller.selectSong`, settled (instrument upgrades done, window plan applied).

| state | before decoded / pinned MB | after decoded / pinned MB |
|---|---|---|
| Sunday Pad + Piano, library mode | 417.1 / 332.9 | 454.3 / **370.0** |
| Grand Piano, library mode (+ Rhodes neighbour) | 417.1 / 417.1 | 454.3 / 454.3 |
| Sunday Pad + Piano, My Set (large-set) | 653.1 / 332.9 | 454.3 / 370.0 |
| Grand Piano, My Set (large-set) | 653.1 / 417.1 | 454.3 / 454.3 |
| `estimatePreloadMB([song])`, Sunday / Grand / Anthem | 332.9 | **370.0** |
| `estimatePreloadMB([song])`, Upright Pad | 235.9 | 256.7 |
| gospel-stab-b3 window, both modes | 568.9 pinned | 568.9 pinned |
| Anthem current, large-set | 568.9 pinned (+ upright) | 370.0 pinned (upright left out, warmed unpinned) |
| Upright Pad current, both modes | 421.2 pinned | 442.0 pinned (upright long + clav-funk) |

The builder's 332.9 → 370.0 and the Anthem large-set change are confirmed. Upright Pad current + Anthem = 589.6 MB
was **not observed**: in the factory order Anthem is 2 away from upright-pad, and clav-funk (+1) is taken first,
so the window is 442.0 MB. Switch times (`selectSong` await) are the same before and after: 30–94 ms onto a
preloaded song, 1.2–5.9 s where the song's samples were not decoded yet (both trees).

**10-song switch loop** (anthem, gospel-stab-b3, upright-pad, clav-funk, sunday, upright-pad, anthem, music-box,
felt-piano, gospel-stab-b3), `_debugStats` every 50 ms:

| | before (library / large-set) | after (library / large-set) |
|---|---|---|
| pinned max | 568.9 / 568.9 | 568.9 / 568.9 (≤ 600 budget, ≤ 700 cap in every sample) |
| decoded after settle, max | 696.2 / 699.4 | 678.5 / 678.5 (≤ 700 cap) |
| decoded peak during a switch | 754.2 / 753.1 | **812.0 / 810.7** (807.9 on a re-run) |

L-10 (soft cap during a switch, settled under the cap) holds. See R1 for the higher transient peak.

### 2. Pedal-held chord past 18 s, no click at the (later) sample end

Grand Piano sampler, dry, chord A1 E2 A2 E3 vel 90, CC64 at 0.3 s, keys up at 1.0 s, 24 s offline render:

| t (s) | 10 | 14 | 16.5 | 17 | 18 | 19 | 19.5 | 20 | 21 |
|---|---|---|---|---|---|---|---|---|---|
| after (dBFS, stereo RMS ±0.1 s) | −38.0 | −46.4 | −48.5 | −41.7 | **−49.0** | −41.3 | −48.4 | −64.4 | silent |
| before | −38.0 | −46.4 | silent | silent | silent | silent | silent | silent | silent |

Sample ends (A1 at 20.10 s, E2 = D#2 repitched at 18.97 s, A2 at 15.96 s, E3 at 14.35 s): the 2 ms
second-difference energy is at most 3.1 dB over its ±200 ms neighbourhood, at −93 dBFS; the worst spike over 12–24 s
is that same 3.1 dB. No click. Every Salamander (90) and upright (69) buffer at `maxSec` 30: none capped, 20.0 s
longest, last sample ≤ −92 dBFS, peak of the last 5 ms ≤ −83 dBFS (the download scripts' 0.5 s fade is in the
files).

### 3. Round trip and identity

- Real app, Edit › Keys › Advanced: `store.set` 2.5 / 12 → engine `getParam` and `slots[0].cfg` 2.5 / 12 → UI
  "2.5 s" / "Fades" "12 s", sentence "Rings 2.5 s after you lift the pedal. With the pedal down it fades after 12 s
  (over 3.0 s).", Advanced summary "· Release 2.5 s · Pedal hold 12 s"; `null` → fields removed, engine null /
  'natural', UI back to "0.8 s" / "Natural". Keyboard Home on Pedal hold → 2 (store, engine), End → removed.
- Offline identity, all 19 factory songs, 8 s of chords / pedal / re-strike / key-ups, pre-sustain engine vs this
  one, fields absent and fields explicitly `null` / `'natural'`: max |diff| ≤ 6.8e-6 for 16 songs (each at its own
  pre-vs-pre floor); lofi-rhodes, dusty-piano and 80s-ballad 1.3–3.6e-5, inside their pre-vs-pre floor of
  2.5–5.4e-5 (Chromium run-to-run noise of those graphs). Before the F1 fix the four Salamander songs were at
  3.2–3.4e-5 against a 0.5–1.7e-6 floor.

### 4–5. Advanced row, EQ

- One click on the Advanced summary mounts the EQ (`.eqk` present after 112–128 ms, `_debug.tone().mounted`), one
  click closes it (`.eqk` count 0, destroyed = created). 5 more open/close pairs: created 6, destroyed 6, 0 `.eqk`.
- No layout shift at 1280×800 or 1024×700: the Tone block, the Sustain row, the sentence (one line, 16 px, in all
  states incl. the longest) and the footer line keep their positions at mount, after 1.5 s, and after set / unset.
- `tools/themes/shoot.mjs --theme classic --only edit,eq` writes `edit-tone-eq.png` with the EQ (0 errors);
  themes `--only coverage --theme ember` walks `ember:edit-tone-eq` (1.6 % unmatched, 0 dead classes, 2/2).

## Fixed here

- **F1 mono-loss stats (sampler.js `processSample` / `limitMonoLoss`).** The Salamander `maxMonoLossDb` mid/side
  factors were measured over the whole decoded buffer, so a 20 s variant got slightly different factors than the
  16 s one and every current-song Salamander note moved by up to 3.4e-5 from the first sample on. The factors are
  now measured on what the legacy cap keeps (its 1 s fade weighed in when the buffer runs past it).
  `limitMonoLoss(L, R, capDb, {statsLen, fadeLen})` (optional arg; exported). The legacy variant is bit-identical
  to before; the long variant equals it bit for bit up to the legacy fade (11 truncated v9 samples, 2 with an active
  fix; engine `offline.sustainVariants`).
- **F2 reference leak (sampler.js `_upgrade`).** An instrument disposed while a long-variant decode was in flight
  (switching away from a piano song during its ~3 s upgrade, or its retire) got the buffer referenced after
  `dispose()` had released it: unevictable for the page's life (reproduced: 1 buffer, 4 MB, per occurrence). Now
  released. Test: `offline.sustainVariants` (fails with `refsAfterDispose: 1` without the fix).

## Remaining (not fixed)

- **R1 transient decoded peak +55 MB.** A switch onto a piano song decodes the long variants of the truncated
  samples (Salamander: 33 samples, ≈ 197 MB of decodes, the neighbour window held only the legacy copies) while the
  old window is still pinned, so the peak during a switch went 754 → 808–812 MB against the 700 MB cap. The L-10
  note says the overshoot happens while `retiring > 0`; every peak here (before and after) had `retiring === 0`: it
  is the new song's referenced buffers plus the old pins, before the controller's window replace. Options: (a) have
  `_upgrade` wait for the new window's `setPins` (the engine knows when `preload(…, {pin:'replace'})` for the
  committed patch ran); (b) accept and correct the L-10 wording. The Mac soak's max decoded column is the check.
- **R2 duplicate first decode.** `KEYS_MAX_SEC` also applies to the short factory piano / ep / keys sets
  (Rhodes, Wurli, clav, harpsichord, …). Before a URL's natural length is known, the long key and the legacy key
  are separate `inflight` entries, so a neighbour preload and the current instrument can decode the same file twice
  at first load (the second result is dropped when the key collapses). CPU only, first load only; not measured.
  Fix sketch: in `acquire`, when a long key's `meta` is unknown and `inflight` has the URL, await it and recompute.
- **R3 Release (pedal up) vs Ring-out.** Two sliders in one panel set the same release stage; once Release is set
  it silently wins at key-up. "(pedal up)" also governs a plain key-up with no pedal. Wording / overlap is Ryan's
  call; kept within the two-control rule.
- The builder's 589.6 MB (Upright Pad + Anthem) figure in "## sustain" is not a window the app builds (see 1).
