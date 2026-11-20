# Settings restructure + 2.0 Sound options: skeptic review

Tree: `v2-native` at `bf7fd8a` (+ this review's edits). Playwright ran on the builder's scratch mapping of Chromium
1194 → the installed 1243 (`/opt/pw-browsers` only has 1243; nothing installed). Base for comparisons: `e3e8d64`
(the DECISIONS commit), extracted with `git archive` into the scratchpad.

## Verdict

**VERIFIED.** The gate holds, measured here: `node test/phase2/settings/run.mjs` 78/78 twice (once inside run-all,
once after the last fix); `node test/run-all.mjs --fast` 11/12 with the only failure (`eq` L-21, "1100 @system%:
every cell's text fits") reproduced on `e3e8d64`, so it predates this task. Zero console errors in every mode.
Four small defects were fixed in owned files (below); the open items are hand-offs or low-severity notes.

## Measured

| check | result |
|---|---|
| settings suite | 78/78 (app 25, fixture 26, mac 22, bridge 5), x2 |
| run-all --fast | unit 510 pass · engine 99/99 · instruments 143/143 · synth-extra 153/153 · shell 250 · ui-core 82 · edit-v2 105 · settings 78/78 · eq 27/28 (pre-existing) · mini 14/14 · themes 58/58 · chrome-fallback 17/17 |
| eq L-21 on `e3e8d64` | same failure, same assertion: pre-existing |
| lost controls (inventory of every `data-bind`, `data-testid`, row label, button and select, old vs new; Chrome app and the fake-rig Mac fixture) | none. Only the label "Output device" → "Output" and the `.st-col` class went away |
| category map / Advanced contents | match the report (Chrome: Menu bar in Look; Mac: Menu bar + Updates switch in Mac, update line in About) |
| deep links (20 names incl. 1.x `pads`, `appearance`, `backups`, `midi`, aliases, unknown) | right category; unknown keeps the current/last one |
| narrow layout | dialog 760 px at 820 wide → strip; 964 at 1024 and 1040 at 1180 → sidebar; no sideways scroll inside Settings (the page's own 1024 px minimum predates this) |
| rapid buffer picks on the bridge mock (256 then 512, 0–60 ms apart) | both restarts sent, engine ends on 512 = stored |
| Electron / soak suites (skipped by --fast) | none selects Settings DOM (grep), so the skip hides nothing here |

Code read: store (refuse, never clamp; `null` resets; device-local, so not exported and kept on replace-import),
controller (`engineTakesSound2` needs all three setters, so the web engine sends nothing; secondary windows guarded;
start-up sends the buffer with `audio start`, then polyphony and the limit), bridge (`'off'` → 0 on the wire, 0 →
`'off'` back; `audioconfig` only on change). Matches ENGINE_CONTRACT `config` / `audio` / `state` rows.

## Fixed in this review (owned files)

1. **Focus lost to `<body>`** (a11y, medium): `open({section})` while Settings is open, to a section with nothing
   focusable (About, Diagnostics), hid the panel holding the focused control and left focus on `<body>`.
   `revealSection` now focuses that category's tab when focus has left the dialog. Test: deep-link test, Look →
   `diagnostics` while open.
2. **`aria-orientation` stayed `vertical`** in the narrow tab strip (a11y, low). `syncOrientation()` sets it from
   the computed layout on open and on window resize. Tests: narrow-layout test asserts `horizontal` at 820/700/390 and
   `vertical` at 1440/1024.
3. **`voice-limit` deep link** landed on "Voices and buffer" while the control lives in Sound › Advanced (left
   closed). The row now carries `data-section="voice-limit"` (alias `voicelimit`), so the link opens Advanced and
   focuses the choice. Test added to the deep-link test.
4. Comment on `advanced()` said the disclosure is "closed each open"; it is closed at mount and then stays as the
   viewer left it. Comment corrected.

## Open items

1. **Restart requests during a restart are dropped** (low; not reproduced). `controller.restartAudio()` returns at
   `if (restarting)`. The bridge records a new buffer size synchronously, so a pick made before the restart request
   goes out is carried; a pick that lands after it leaves the engine at the previous size until the next restart
   (the line then reads "Device gave …"). The mock answers instantly, so 0–60 ms gaps did not show it; a real
   device reopen may. Same behaviour for latency since 1.x. Change: `let restartAgain = false;` and
   `if (restarting) { restartAgain = true; return false; }` at the top; after the `ok` branch,
   `if (restartAgain) { restartAgain = false; return restartAudio(opts); }`. Touches 1.x latency restarts, so it needs
   shell + ui-core reruns.
2. **Contract**: `native/contract/engine-api.json` `methods` does not list `setPolyphony` / `setVoiceLimit` /
   `setBufferFrames`; `test/unit/engine-bridge/surface.test.mjs` allow-lists them instead (builder's item 1). Owner:
   the contract (native/**).
3. **mock-native** does not report `bufferFrames` in `audio` replies or `state` events (task A). The granted-size line
   is covered only by an injected `state` event in `sound2.mjs`.
4. Nit: `renderSound2` reads `engine.ctx.sampleRate` from the view (a property read, like `_debugStats`), with 48000
   as fallback; the controller status could carry it instead.
5. `test/phase2/themes/coverage-*.json`: timestamp-only changes, already in a checkpoint commit; revert if unwanted.
