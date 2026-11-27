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
- [ ] 3 FU2 O3 bank-trial skeptic F1–F3 deterministic (5 full-file runs)
- [ ] 4 FU2 ⋯ Song overflow 1024×700 coarse (v6) + today's Edit 1004 px at 820
- [ ] 5 CVD2 O1 range-bar number placement in JS (v6 keyboard.js + perform.js)
- [ ] 6 CVD2 O5 changed dot vs two-digit tab number
- [ ] 7 CVD2 O6 muted instrument's number grey
- [ ] docs: CONTRACT_CHANGES sections, plan status
- [ ] gates: shell-unit,unit,ui-v6,ui-v6-edit,ui-v6-ipad,ui-v6-bank,settings,ui-core,edit-v2, then ui-v6-themes
- [ ] final report in this file

## Next step
3 (bank-trial O3). Browser tests for 1 (ui-core scenes, ui-v6-bank polish2) and 2's ui-core edit updated, not yet
run (gates will). Probe for 2: /home/claude/scratch/fu2/snapshift.mjs (+ summ.py), results base-shift.json /
lane-shift.json.

## Findings
- 2: base shift rest→snapshot: today's Edit 22 px mouse / 50 touch; v6 6 / 37 (1280, 1024), 22 / 49 (820). Lane: 0
  everywhere (also snapshot→long-named snapshot and Own levels). Header without snapshots identical to base (52 / 48 /
  58 / 98 / 112 px). The line is one line (words before Update ellipsize), so its reserved height never depends on a
  name. Idle = `.ev2-snapidle` (visibility hidden), `hidden` = no snapshots.

## Open questions
