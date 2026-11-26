# fix-enter: skeptic review

**Verdict: VERIFIED.** `keyEl(e)` changes the outcome only where the old code was wrong. No defect found, no code changed.
One gap: main.js's dialog-Enter guard change has no test that depends on it (see Findings).

## Gate (worktree wt-fixenter, uncommitted on 6a911cf, run one suite at a time)
- edit-v2, all 13 files (incl. integration-enter 5/5, integration, widths): PASS
- shell unit / browser / electron (xvfb-run): PASS (the new cue-go test and fixenter-keys included)
- `run-all --only unit`: 670 pass, 0 fail
- settings: PASS. ui-core: 78/78.
- Zero console.error in every suite (the "zero console.error" assertions pass).

## Fails without the fix (copy in /tmp, only controller.js reverted to HEAD)
- cue-go "fixenter" test: FAIL. integration-enter: tests 2 (Perform blur-on-Enter field) and 5 (edit-v2 harness, view
  'perform') FAIL; tests 1, 3, 4 pass.
- Tests 3 (Settings) and 4 (Edit in the real app) pass without the fix. That confirms the builder's claim: both are
  already gated by `body.settings-open` / `settings.view === 'edit'`.
- Reverting only main.js: all 5 still pass. The main.js hunk is not covered by any test (below).

## Key paths (new `test/phase1/shell/fixenter-keys.test.mjs`, 6 tests; pass with the fix, 5 of 6 fail without it)
The events have a real target while `activeElement` is body, which is the blur-on-Enter state.
- Space, arrows, Shift+arrows, ArrowUp, letters with a text-field target: not prevented, no engine calls, no song change.
- Button target: Enter, NumpadEnter, Space and ArrowRight stay the button's. Before, a button that detached itself on
  Enter (a dialog closing) reached GO with activeElement=body. That is now fixed too.
- Target body or documentElement: falls back to `activeElement`, so a focused field still wins.
- Nothing focused: Space sustains, ArrowRight steps, Esc sends allNotesOff, Enter GOes. All unchanged.
- Esc: panic is unchanged. Esc from a text field stays the field's (inText returns first), as before.
- Cmd+Arrow from a field target no longer switches song. Before, it read activeElement=body and did.
- Enter on a setlist chip (S7): the chip's own click handler GOes a cued chip. The target is the chip, so the document
  listener never double-GOes. `fakeDoc` dispatches on the doc (target without tagName), so the existing tests still
  take the fallback.
- IME composition Enter (keyCode 229, isComposing): from a field target it never GOes. The controller has no explicit
  `isComposing` check. It relies on the field target being a text control. That is the same as before, not a regression.
- `contenteditable`: covered by the cue-go test (`isContentEditable` div target).
- Global hotkeys (Electron menu / ⌘ combos): the mod branch uses `el` only for the inText / onButton gates. Unchanged.

## Real-app impact claim: confirmed
- Edit: `settings.view === 'edit'` makes `enterGoes()` false (test 4 passes without the fix).
- Settings: `body.settings-open` blocks it (test 3 passes without the fix).
- Perform: no text field commits by blurring on Enter. The only inputs are fader / readout ranges (they blur on
  pointerup only) and the notes div (tabindex, not editable).
- Hidden chart view's import dialog (`views/chart/import.js`, only with `settings.chartView === true`): has a
  textarea, a select, a number input (tempo) and checkboxes. None blur on Enter, and its keydown handler only traps
  Tab. Enter there was already safe, because focus stayed on the control. Only the panel harness and any future
  Perform field of that kind were exposed.

## Findings
1. main.js guard (`fromControl`): not exercised by any test. It is harmless. When a dialog is open, no control has
   focus and the target is a non-body element, Enter is no longer preventDefaulted. Nothing in the app has a default
   action there. No fix made. A Playwright test would need a form inside a Perform dialog, and none exists today.
2. `keyEl` treats any element target as authoritative. In a browser, keydown targets the focused element or body, so
   this only differs when focus moved during dispatch. That is the intended case.
