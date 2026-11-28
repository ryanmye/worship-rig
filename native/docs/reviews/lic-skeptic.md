# lic-skeptic: light review of lane-lic (PolyForm Noncommercial relicense, D38)

Lane `lane-lic`, worktree `/home/claude/wt-lic`, reviewed at 97c7861 (base origin/v2-native daabbf2). Reviewer fixes:
0f5cdef, ca07544. Not legal advice: licence questions below are questions for Ryan, not conclusions.

**Verdict: MERGE** (after the two small fixes below, already committed on the lane).

## Checks

1. **LICENSE text: verbatim.** Line 1 `Required Notice: Copyright Ryan Ye (https://github.com/ryanmye)`, line 2 blank,
   then the licence. Lines 3–end are byte-identical (sha256 c0ea4a89…fabbe5, 4563 bytes) to
   `PolyForm-Noncommercial-1.0.0.md` from a fresh `git clone --depth 1 --branch 1.0.0
   https://github.com/polyformproject/polyform-licenses`, and word-identical (684 words, `diff` empty after collapsing
   whitespace and Markdown markers) to SPDX `license-list-data` `text/PolyForm-Noncommercial-1.0.0.txt` (fresh
   sparse clone). WebFetch of polyformproject.org/licenses/noncommercial/1.0.0 loads the same licence. No word
   differences. The Required Notice format matches the licence's own example (`> Required Notice: Copyright
   Yoyodyne, Inc. (http://example.com)`).
2. **No GPL / "open source" claim for 2.0.** `git grep -I -i -E '\b(L|A)?GPL|open[- ]source|free software|GNU
   General'` over the tree (minus node_modules, LICENSE-1.x.md, golden data, design shots, vendored third_party
   licence texts, LANE.md and the historical CONTRACT_CHANGES / DECISIONS / reviews / SETUP_REVIEW / WAVE0B_REVIEW)
   leaves only: statements that 1.x is GPL (README, LICENSES.md, CONTRIBUTING, release notes, site, CLAUDE.md; all
   correct), "no GPL/LGPL/AGPL deps" rules (CLAUDE.md, REPICKUP, ARCHITECTURE §6, CONTRIBUTING), the js_tanh LGPL
   question (LICENSES.md), the Windows plan's ASIO research (marked superseded), Arm/LLVM licence texts, and
   `tools/exs/layout.mjs` calling third-party RE projects open source (true, unrelated). `app/`, `native/apple`
   (project.yml, Swift, plists) name no code licence at all. Site meta/og/lede no longer say "open source".
3. **SPDX / packaging.** package.json and the lockfile root say `PolyForm-Noncommercial-1.0.0`, which is the SPDX id
   (the SPDX text file is named exactly that); both files parse. `node test/integration/build-lint.mjs --keep` on
   Linux (xvfb): **45/45 passed, 1 skipped** (the ≤ 480 MB .app size check needs a Mac). The kept app.asar contains
   `/LICENSE` (first line = the Required Notice), `/LICENSES.md`, `/README.md`; the packaged app boots with zero
   console.error. Log: `/home/claude/scratch/lic-skeptic/build-lint.log`.
4. **Public docs.** README, site, release notes, LICENSES.md, CONTRIBUTING.md, LICENSE-1.x.md agree: 2.0+ is
   PolyForm NC 1.0.0, "free, and source-available for noncommercial use", commercial use not allowed, 1.x stays
   GPL-3.0-only. No "open source" claim. The Musyng Kite heading and its CC BY-SA 3.0 attribution / ShareAlike text
   are unchanged; the site's `LICENSES.md#musyng-kite-soundfont-samples-cc-by-sa-30` anchor still matches the heading
   `## Musyng Kite soundfont samples (CC BY-SA 3.0)`. Every third-party licence file the new "Third-party code"
   table names exists. Links: polyformproject.org loads (WebFetch); `blob/v1.1.1/LICENSE` exists on GitHub (`gh api`,
   blob f288702 = the GPL text); gnu.org and `blob/main/*` could not be fetched from this box (proxy), but `main`
   links resolve to 2.0 files once v2-native is merged into `main`, which is also when pages.yml deploys the site
   (it deploys from `main` only). **F1 (fixed, 0f5cdef):** LICENSE-1.x.md sent readers to "the `LICENSE` file on
   `main`" for the GPL text, and README / LICENSES.md / CONTRIBUTING described 1.x as "`main`". Once 2.0 is merged
   into `main` at release (MAC_CHECK) that link would show the PolyForm text and "main stays GPL" would be false.
   Now: link to `blob/v1.1.1/LICENSE`, and "releases up to and including v1.1.1". Also rewrapped its 191-char line.
   - **Church use vs the licence text.** PolyForm NC names "charitable organization" (Noncommercial Organizations)
     and "religious observance" (Personal Uses), plus "Any noncommercial purpose is a permitted purpose". It does
     **not** name "religious institution" or "church". README, site and release notes say "use by churches,
     charities and schools", which is D38's own wording (Ryan). Not changed; see Q1.
5. **Windows plan vs D38.** NEXT-PLATFORMS-windows.md (summary, §2.2 banner, phase table, audio plan item 3, open
   question 2) and NEXT-PLATFORMS.md agree with D38 as on origin: WASAPI for Windows 2.0, ASIO kept as a drop-in
   backend behind the same interface if a real-PC test with Ryan's interface needs it, and shipping it then needs
   Steinberg's proprietary licence signed by Ryan, because the SDK's GPLv3 option can't go into a PolyForm app.
   **F3 (fixed, ca07544):** one note still said the SDK LICENSE.txt check was "moot for 2.0: no ASIO"; now it says
   the GPLv3 option is moot and ASIO later means the proprietary licence.
6. **Style.** **F2 (fixed, ca07544):** three edited prose paragraphs ran past 120 characters (Windows §2.2
   "Compatibility" bullet, the Store note, NEXT-PLATFORMS's open-questions bullet); rewrapped. Remaining long added
   lines are Markdown table rows and the site's `<meta>`/lede lines, matching their neighbours (the site already had
   63 lines over 120). CLAUDE.md's new bullet is accurate; not touched.
7. **Gates / scope.** `git diff --stat origin/v2-native..HEAD -- app native/core/src` is empty.
   `node tools/cloud/gates.mjs unit,shell-unit` on ca07544 (tree clean): unit PASS 24 s, shell-unit PASS 30 s. No
   test in `test/` covers `docs/site`, so no site suite was run. This report is a docs-only commit on top.

## Agreeing with the builder

The bundled-licence audit in LANE.md is plausible and I found no GPL code in `app/` or `native/`
(`grep -rIl -i 'GNU (Lesser )?General|GPL'` over native/core/src, third_party, native/apple, app/js hits only the
Arm/LLVM licence texts' GPLv2 compatibility clauses and an identifier containing "gPl"). I did not re-verify each
row of the audit table.

## Questions for Ryan (not legal advice)

1. **Churches.** The licence covers churches clearly when they are charitable organizations or the use is a
   noncommercial purpose, but it never says "church". The docs promise "use by churches". Are you happy with that
   wording as your stated intent, or do you want a one-line explicit grant (e.g. "the licensor also treats use by a
   church or other religious organization in its services as a permitted purpose") in README/LICENSE-adjacent text?
   A lawyer could say whether that belongs beside the licence or not.
2. **"Every other contribution was generated by AI coding assistants"** (LICENSE-1.x.md, CONTRIBUTING.md). This is
   honest, but it is a public statement that most of the code is AI-generated, and how far copyright covers
   AI-generated code is unsettled. Do you want it said publicly, and in these words?
3. **js_tanh.cpp** (builder's Q1): is glibc's 1997 Shimizu change to `s_expm1.c` LGPL? If unsure, re-derive those
   lines or keep that file under LGPL terms.
4. **Notices in the native .app** (builder's Q2): the Mac/iPad bundle carries no LICENSE / LICENSES.md /
   third-party notices (pre-existing). BSD/MIT/Apache want notices with binaries; PolyForm wants the licence text or
   URL plus the Required Notice with every copy. The release notes and site inside the bundle carry the URL and
   notice, which may be enough for PolyForm but not for the third-party notices. Add them before 2.0 ships?
5. **CONTRIBUTING point 3** is a plain-language relicensing grant, not a lawyer-drafted CLA. Fine for now (no
   outside contributors)?

## For the main session's memory (source: D38 on origin and LANE.md, not new from Ryan)

Nothing new; D38 already records that `ilomacht` is Ryan's account.
