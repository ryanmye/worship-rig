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
- [ ] gates: shell-unit,unit,ui-v6,ui-v6-edit,ui-v6-ipad,ui-v6-bank,settings,ui-core,edit-v2, then ui-v6-themes
- [ ] final report in this file

## Next step
gates (in order; rerun the same command after a restart: gates.mjs skips what passed).

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
