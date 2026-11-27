# LANE: lane-fu2 (FU2 + CVD2), builder

Brief: FU2 = UI6-fu O1 option (b) (empty-library step fades only if a key / the pedal is held; else drone-off only),
O2 (Edit reserves the snapshot line's height while the song has snapshots; 0 px shift at 1280×800, 1024×700,
820×1180 touch; no-snapshot songs unchanged), O3 (bank-trial "skeptic F1–F3" deterministic; 5 full-file runs),
v6 Edit ⋯ Song overflow at 1024×700 coarse + today's Edit 1004 px wide at 820. CVD2 = UI6-cvd O1 (range-bar numbers
placed in JS, never stacked; v6 keyboard.js + today's perform.js), O5 (changed dot never covers a two-digit tab
number), O6 (muted instrument's number grey). Rules: engine untouched, flag-off purity identical, cvd Off
pixel-identical, 0 console.error / HTTP ≥ 400. Gates via tools/cloud/gates.mjs. Don't push.

Worktree /home/claude/wt-fu2, branch lane-fu2 from origin/v2-native ee5bcb9. Scratch: /home/claude/scratch/fu2.

## Checklist
- [x] 1 FU2 O1 empty-library fade only when held (+ shell tests)
- [x] 2 FU2 O2 snapshot line height reserved (both Edits) + rect tests
- [x] 3 FU2 O3 bank-trial skeptic F1–F3 deterministic (5 full-file runs)
- [x] 4 FU2 ⋯ Song overflow 1024×700 coarse (v6) + today's Edit 1004 px at 820
- [x] 5 CVD2 O1 range-bar number placement in JS (v6 keyboard.js + perform.js)
- [x] 6 CVD2 O5 changed dot vs two-digit tab number
- [x] 7 CVD2 O6 muted instrument's number grey
- [x] docs: CONTRACT_CHANGES sections, plan status
- [x] gates: shell-unit,unit,ui-v6,ui-v6-edit,ui-v6-ipad,ui-v6-bank,settings,ui-core,edit-v2, then ui-v6-themes
- [x] final report in this file

## Next step
Done: final report below; hand back.

## Findings
- 2: base shift rest→snapshot: today's Edit 22 px mouse / 50 touch; v6 6 / 37 (1280, 1024), 22 / 49 (820). Lane: 0
  everywhere (also snapshot→long-named snapshot and Own levels). Header without snapshots identical to base (52 / 48 /
  58 / 98 / 112 px). The line is one line (words before Update ellipsize), so its reserved height never depends on a
  name. Idle = `.ev2-snapidle` (visibility hidden), `hidden` = no snapshots.

- 3: root cause of bank-trial "skeptic F1–F3": Node fetch (undici) keeps the socket to the test server alive; the
  server closes idle sockets after 5 s (server.js keepAliveTimeout). "random sequences" is synchronous and held the
  loop 5–17 s, so the next boot's /api/health or /api/user-patches went out on the half-closed socket: "Could not
  read the patch packs: fetch failed" (warned, unseen), bank list empty. Reproduced 2/2 under 2 busy loops. Fix (test
  only): the random test yields per seed; the file's fetch retries once on a network TypeError (Chromium's behaviour
  on a reused keep-alive socket); boot() asserts the pack was read. Ablation under load: yield only 2/2 pass, retry
  only 2/2, neither 0/2. 5 full-file runs plain + 5 under load: 11/11 each (.probe/o3-*.txt).

- 4: v6 ⋯ Song at 1024×700: 4 px past the header on touch; with the Chart button (D33 on by default) 47 px mouse /
  74 touch. Fix ≤1100 px only: "Time" caption visually hidden (select keeps aria-label), key chip "· you play …"
  may ellipsize (shrink .1, name gives way first). 1101 touch chart on: 1 px spare. Today's Edit at 820: body
  min-width 1024 cut the right 204 px (Range column, PANIC). Fix <1024 px, only while today's Edit is the visible
  view: body min-width 0 + top-bar rules (lamps no longer overlap). Flag-off Perform keeps 1024 (tested).

- 5: placeBadges (pure) + cvdBadges (DOM, rAF, ResizeObserver only while on, html-class MutationObserver) live in
  views/components/keys.js, not a new module: both keyboards already load keys.js, a new module would be a new
  request with cvd Off (flag-off purity compares requests). Off: nothing measured/scheduled/written. Base: ui-v6
  "CVD2 O1" fails (9 and 10 at the same x, v6 and today's); lane passes at 1280/1180/820 (v6), 1280/1024 (today).
- 6: could not reproduce the skeptic's ~45 px tabs (current tree: tabs ≥ 116 px, dot at 99–107 px, number at
  10–36). Seen instead: the dot sits over the end of the name. Fix (cvd on only): name padding-right 8 px, so the
  name's text (number included) ends before the dot. Test asserts dot ∩ name content box = ∅ at 1280 / 1024.
- 7: v6 muted bars are NOT grey in any theme (pre-existing: `.v6 .v6-kbd .v6-rbar { background: var(--c) }`
  out-ranks every `.rbar.off`; styles-v6-keyboard.css's comment says otherwise). Not fixed (it would change cvd-Off
  pixels). Badge: today's = the bar's grey (inherit) + --text; v6 = --muted + --bg (grey, ≥ 4.5:1 in all 8 themes).

- gates run 1 (tree f772e05): shell-unit, unit, ui-v6 PASS; ui-v6-edit TIMEOUT at 480 s: the old "flag flips" test
  asserted today's Edit keeps the 1024 px minimum at 820 (the quirk this lane fixes) → updated to 0px + Edit 820 wide;
  its failure cascaded (30 s timeouts). Budget 8 → 12 min in run-all (the two new files add ≈ 2.5 min).

## Open questions

## Final report (builder, lane-fu2)

**Changes**
- FU2 1 (UI6-fu O1, option b): `controller.silenceEmptyLibrary` still turns the drone off once per empty spell, but
  calls `fadeOutAll` only if a key is held (`heldCount`) or the pedal is down (`pedalDown`). With nothing held, the
  next song never starts faded.
- FU2 2 (O2): `song-header.js` / `.css`: while the shown song has a snapshot, both Edits keep the snapshot line's room
  (`.ev2-snapres`). The idle line is `.ev2-snapidle` (visibility hidden), `hidden` = no snapshots. The line is one
  line; the words before Update ellipsize. Rig shift on a snapshot change: was 22/50 px (today's, mouse/touch) and
  6/37 (v6; 22/49 at 820), now 0. Headers without snapshots unchanged.
- FU2 3 (O3): root cause in the test: Node fetch's keep-alive socket plus server keepAliveTimeout 5 s, with the
  synchronous "random sequences" test (5–17 s) in between. The next boot's /api/health or /api/user-patches failed
  ("fetch failed", silently warned), so the bank list was empty. Fix in bank-trial.test.mjs only: yield per seed;
  retry once on a network TypeError (Chromium's behaviour); boot asserts the pack was read.
- FU2 4: v6 Edit header ≤ 1100 px: the "Time" caption is visually hidden, and the key chip's "· you play" may
  ellipsize. The ⋯ Song button stays inside the header (it was 4 px out on touch; with Chart on, 47 px mouse / 74 px
  touch). Today's Edit < 1024 px, while visible: body min-width 0 plus top-bar lamp rules, so Edit is 820 wide at
  820. The flag-off Perform keeps 1024.
- CVD2 5 (UI6-cvd O1): `components/keys.js` `placeBadges` (pure) + `cvdBadges` (rAF, ResizeObserver only while on,
  html-class observer) write `--cvd-x`; CSS `left: var(--cvd-x, <old clamp>)`. They are wired into v6 keyboard.js
  (not Edit › Range) and today's perform.js. Off: nothing measured or written. The code is in keys.js because a new
  module would be a new request with the flag off (purity).
- CVD2 6 (O5): with cvd on, `.v6e-rt-name` has 8 px right padding, so the name and number end before the changed dot.
- CVD2 7 (O6): a muted number is grey. Today's: the bar's grey (inherit) + `--text`. v6: `--muted` + `--bg`.
- Docs: CONTRACT_CHANGES "## FU2 …" and "## CVD2 …"; plan entries marked Built (skeptic pending).

**Tests added / changed**
- shell: `empty-silence` (+2 tests "UI6-fu O1 (b)", older ones hold a key where they meant the fade);
  `bank-trial` (O3 fix + the "UI6-er O1" Back now expects drone-off only).
- unit: `test/unit/shell/cvd-badges.test.mjs` (5).
- ui-v6-edit: `snapres.tests.mjs` (0 px shift, both Edits, 3 sizes; it fails on the base);
  `layout-fu2.tests.mjs` (⋯ inside the header at 1024/1101/1180/1280 × mouse/touch × chart on/off; today's Edit at
  820); `snapline.tests.mjs` (idle-line semantics); run.mjs "flag flips" now expects today's Edit to fit 820
  (min-width 0px), where it used to assert the old 1024 px minimum.
- ui-v6: `cvd2.tests.mjs` (O1 v6 at 1280/1180/820 + after a range write; O1/O6 today's keyboard, flag off; O5 16 tabs
  at 1280/1024; O6 in 8 themes). O1 fails on the base ("9" and "10" at the same x).
- ui-core scenes (snapline idle + rig top unchanged; "UI6-er O1" holds a key); ui-v6-bank polish2 (faded false).
- run-all: ui-v6-edit budget 8 → 12 min (the first gate run timed out at 480 s after the flag-flip failure cascaded).
- O3 proof: 5 full-file runs plain + 5 under 2 busy loops, each 11/11. Ablation under load: yield only 2/2, retry
  only 2/2, neither 0/2 (.probe/o3-*.txt).

**Gates** (tools/cloud/gates.mjs, tree 76850e7, PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw,
UI6_PURITY_BASE=origin/v2-native)

| suite | result |
|---|---|
| shell-unit | PASS 418/418 |
| unit | PASS 694 pass, 0 fail, 12 skip |
| ui-v6 | PASS 94/94; flag-off purity identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| ui-v6-edit | PASS 47/47; flag-off purity identical (Edit too) |
| ui-v6-ipad | PASS 29/29 |
| ui-v6-bank | PASS 23/23 |
| settings | PASS 115/115 (app, fixture, mac, bridge, v6) |
| ui-core | PASS 95/95 on rerun; the first run had 94/95: "next / prev buttons step through the setlist and play" (note at −80.7 dBFS within 500 ms; audio timing at load avg 8–12; code not touched by the lane) |
| edit-v2 | PASS 117 pass, 0 fail |
| ui-v6-themes | PASS 30/30 clean (0 text / rings / bounds / errors), 2359 s |

0 console.error / HTTP ≥ 400 in every browser suite (each suite's own check, plus the new tests' own contexts).
`app/js/engine/` is untouched (`git diff origin/v2-native --stat -- app/js/engine` is empty).

**Risks**
- O2 changes the header at rest for songs that have snapshots (+22 px mouse / +50 px touch in today's Edit; +6 /
  +37 in v6), even when no snapshot plays. The line is now always one line: at narrow widths a long snapshot name
  ellipsizes (full text in the title).
- FU2 4: ≤ 1100 px the v6 "Time" caption is gone and "· you play C" can be cut. Today's Edit < 1024 px now shows a
  narrower top bar (meter hidden, ready words may cut). The 1101-px touch + chart case has only 1 px spare.
- CVD2: the badge widths in placeBadges are constants (14 / 20 px; measured 18.7 for two digits). With more numbers
  than room (all 16 on one octave), a badge may sit off its bar, though never on another badge. A MutationObserver on
  html's class now exists for every keyboard, even with cvd Off (nothing else runs).
- O3: the retry in the test models Chromium; a real network failure would still fail on the second try.

**Not verified**
- A real iPad, the Mac app (Electron), WebKit layout, real fingers or a MIDI footswitch (touch was Playwright
  hasTouch).
- The Electron / Mac suites, chart, migration-1x and themes (phase2) were not run.
- Screen-reader speech for the idle `role=status` line.
- The review's ~45 px Edit tabs (O5) did not reproduce on this tree (tabs ≥ 116 px). The fix covers the dot over the
  name end.

**Findings for the orchestrator / Ryan**
- v6 muted range bars keep their lamp colour in all 8 themes: `.v6 .v6-kbd .v6-rbar { background: var(--c) }`
  out-ranks every `.rbar.off`, contrary to styles-v6-keyboard.css's own comment. Left as is (fixing it changes
  cvd-Off pixels); the muted number is grey regardless.
- ui-core "next / prev … play" audio-timing assertion flaked once under load.

**Lane tip:** see `git log -1` on lane-fu2 (this report's commit, after 76850e7 where every gate passed; LANE.md only
changed since). Not pushed.

## Skeptic (lane-fu2)

Rebased onto origin/v2-native cae9f84 (C-SHIP). Conflicts: styles-v6-edit.css (one ≤1100 px media query: C-SHIP's
`display:none` Time caption + 6 px gaps + chart padding, and FU2's key-chip ellipsis; FU2's visually-hidden caption
rule dropped as a duplicate), CONTRACT_CHANGES (both sections kept), UI6-build-plan (CAP + CVD2 kept).
Scratch / probes: /home/claude/scratch/fu2-sk, .probe/.

### Checklist
- [x] 0 rebase onto origin/v2-native, conflicts resolved
- [x] 1 empty-library: fade only when held (key / pedal / MIDI), drone off once, next song not faded, F1 holds
- [x] 2 snapshot line reserved height: 0 px shift (3 sizes, both Edits), no-snapshot unchanged, ellipsis, role=status
- [x] 3 bank-trial root cause; app boot path on one transient fetch failure
- [ ] 4 layout: v6 Edit ≤1100 with chart + FU2; today's Edit ≤1024 only while visible; purity
- [ ] 5 CVD2: placeBadges overlap (16 instruments, identical / one octave / clipped), Off writes nothing, observer
      leaks, tab dot vs 2-digit number, muted grey ≥ 4.5:1 in 8 themes, v6 muted bar colour (O-item + screenshot)
- [ ] gates (gates.mjs): shell-unit,unit,chart,ui-v6,ui-v6-edit,ui-v6-ipad,ui-v6-bank,settings,ui-core,edit-v2,
      ui-v6-themes
- [ ] review doc native/docs/reviews/UI6-fu2.md

### Next step
4 done with F1 (commit), then 5 (CVD2).

### Findings (as found)
- 1 OK (.probe/probe-a.json, real web engine, flag off + v6): nothing held / a key played and released → empty:
  drone off, faded false, fadeGain 1; restore previous library → drone synth sounding, not faded; Next → same. A key
  held through the delete → faded (chip on), and it stays faded through restore + Next until a note: option (b)'s
  accepted residue.
- 2 OK: rig top 0 px shift over 3 footswitch steps (controller.scenes.next) at 1280/1024/820-touch, both Edits; idle
  line absent from the AX tree (CDP getFullAXTree; renames while idle add nothing), playing = one role=status;
  no-snapshot Edit identical to base (rect hash) except the intended today's 820 width and v6 ≤1100 header rules
  (.probe/bare-headers.txt). Names are capped at 40 chars by the store, so the line fits at 820 without ellipsis.
- 3 OK, no app defect: Node fetch with a same-process server blocked 6.5 s past keepAliveTimeout 5 s fails 3/6;
  Chromium (the app) 0/6 under the same server block (.probe/ka-probe3.txt). Fix is test-only (bank-trial).
- 4 F1 (defect, fixing): ≤1100 px the key chip shrank in proportion with the name, so "· you play C" lost the
  played key itself at every width up to 1100 (1100 mouse: name 151 px, chip cut 4 px). Fix: name flex-shrink
  1000 (gives way first, to 6ch), v6 chip text split into words + key, words go first. Test fails first
  (.probe/f1-before.log), passes after (.probe/f1-after.log). Today's Edit min-width: 0 only while Edit shows <1024
  (Perform 1024, Settings over Edit 0) — .probe/probe-layout.json.
