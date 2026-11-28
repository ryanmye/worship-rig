# Lane LIC (builder): relicense v2-native to PolyForm Noncommercial 1.0.0 (D38)

Brief: relicense the 2.0 line (`v2-native`) from GPL-3.0-only to PolyForm Noncommercial 1.0.0 per DECISIONS D38:
LICENSE (verbatim PolyForm NC text + Required Notice), a 1.x GPL note, every licence statement (package.json, README,
site, release notes, app strings, Info.plist, CONTRIBUTING.md new, LICENSES.md intro), a bundled third-party licence
audit, the Windows plan's ASIO lines, CLAUDE.md/rules docs. Light lane: only `node tools/cloud/gates.mjs
unit,shell-unit` at the end. Don't push. Based on origin/v2-native daabbf2.

## Steps
- [x] 1. ~~Clean-room rewrite of cf6e15f~~ CANCELLED: coordinator relayed Ryan's confirmation that GitHub "ilomacht"
  is his own account (D38 on origin, 9ac004f). The draft rewrite was never committed; `test/port-preflight.mjs`,
  `test/run-all.mjs`, `test/phase1/shell/run.mjs` and `reviews/v11-local-findings.md` are byte-identical to
  origin/v2-native. (Before the cancel, a call-site grep printed 3 lines of the original file; moot now.)
  Copyright holders of v2-native: Ryan Ye (GitHub accounts ryanmye and ilomacht) plus AI-generated contributions
  made at his direction (recorded in CONTRIBUTING.md and LICENSE-1.x.md).
- [x] 2. LICENSE (PolyForm NC 1.0.0 verbatim) + LICENSE-1.x.md
- [x] 3. Licence statements (package.json + lockfile, README, site, release notes, LICENSES.md, CONTRIBUTING.md new);
  app/ and Info.plist needed nothing (see report)
- [x] 4. Bundled third-party licence audit; Windows plan ASIO lines
- [x] 5. CLAUDE.md / rules docs
- [x] 6. Gates unit,shell-unit; final report here

## Final report

### Files changed (vs origin/v2-native daabbf2)
- `LICENSE`: GPL-3.0 text → `Required Notice: Copyright Ryan Ye (https://github.com/ryanmye)`, blank line, then the
  PolyForm Noncommercial 1.0.0 text byte for byte (source below).
- `LICENSE-1.x.md` (new): 1.x (up to v1.1.1, `main`) stays GPL-3.0-only; links main's LICENSE and gnu.org; names the
  copyright holder (Ryan Ye: ryanmye + ilomacht; the rest AI-generated at his direction).
- `CONTRIBUTING.md` (new): contributions are PolyForm NC; contributor agrees the maintainer may relicense / grant
  other licences (e.g. commercial); contributor keeps copyright; no GPL/LGPL/AGPL third-party code; current
  copyright holders as above.
- `package.json`: `"license": "PolyForm-Noncommercial-1.0.0"`; `LICENSE` added to electron-builder `files`.
  `package-lock.json` root `"license"` (was a stale `"UNLICENSED"`) → same SPDX id.
- `README.md`: Licenses section → "free and source-available for noncommercial use", PolyForm NC 1.0.0 + SPDX id,
  commercial use not allowed, 1.x stays GPL v3 (LICENSE-1.x.md); CONTRIBUTING.md in the developer docs list.
- `docs/site/index.html`: meta/og descriptions and the lede "Free and open source" → "Free, and source-available for
  noncommercial use"; footer licence link → PolyForm Noncommercial 1.0.0 (2.0; 1.x: GPL v3 → LICENSE-1.x.md); Credits
  gets a code-licence paragraph with the Required Notice.
- `docs/release-notes-2.0.md`: new `### Licence` section before "Known gaps" (nothing changes for personal/church
  use; commercial use not allowed; 1.x stays GPL; sounds/fonts unchanged) + the Required Notice on its own line.
- `LICENSES.md`: retitled "Licences"; intro separates code licence (2.0 PolyForm / 1.x GPL) from asset licences;
  sample sections unchanged (Musyng Kite CC BY-SA attribution, ShareAlike paragraph and the
  `#musyng-kite-soundfont-samples-cc-by-sa-30` anchor intact); new "Third-party code" table + js_tanh note.
- Rules docs: `CLAUDE.md` (new bullet: D38 code licence, permissive deps only, CONTRIBUTING), `native/docs/REPICKUP.md`
  (GPL-3 rule → D38), `native/docs/ARCHITECTURE.md` §6 (GPL-compatible → permissive; faad2 ruled out),
  `native/core/third_party/README.md`, `native/devhost/third_party/miniaudio/README.md`, `BACKLOG.md` (App Store GPL
  note).
- Windows: `native/docs/lanes/NEXT-PLATFORMS-windows.md` (summary bullet, D38 banner in §2.2, audio plan item 3,
  phase-3 row, open question 2 answered, licence-fit row incl. Qt LGPL/GPL no longer fitting, Store note, SignPath
  likely needs an OSI licence [U]) and `NEXT-PLATFORMS.md`: Windows 2.0 is WASAPI only; ASIO is a drop-in backend
  behind the same interface if a real-PC test needs it, and shipping it needs Ryan to sign Steinberg's proprietary
  licence (the SDK's GPLv3 option doesn't fit). Follows D38's later note (daabbf2).
- Not changed: `app/` names neither GPL nor "open source" (Settings › About shows version/port/paths only);
  `native/apple/project.yml` Info.plist has no copyright string (no `NSHumanReadableCopyright`). Historical reviews
  and logs (`.cloud-outbox/status.md`, SETUP_REVIEW, WAVE0B_REVIEW, reviews/v11-todo.md, patches/*.diff) left as
  written.

### Licence text source
WebFetch of https://polyformproject.org/licenses/noncommercial/1.0.0/ only returns a summary (the fetch model won't
reproduce text verbatim); the official `.txt` URL it points to is blocked by the box's proxy (403). LICENSE therefore
uses the official PolyForm repo's tagged copy,
`raw.githubusercontent.com/polyformproject/polyform-licenses/1.0.0/PolyForm-Noncommercial-1.0.0.md` (4563 bytes,
sha256 c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5), identical word for word to SPDX
license-list-data `text/PolyForm-Noncommercial-1.0.0.txt` (which differs only in line wrapping). Ryan may want to
diff it once against the website's .txt.

### Bundled-licence audit (2.0 Mac/iPad app = RigCore + Swift shell + `app/` + `docs/`)
| Item | Where | Licence | OK under PolyForm NC? |
|---|---|---|---|
| Chromium Web Audio ports | native/core/src/dsp etc. | BSD-3-Clause | yes (keep notice) |
| V8 ieee754 fdlibm, V8 sinh/cosh | third_party/v8_ieee754, src/num | BSD-3 + Sun notice | yes |
| LLVM libc math subset | src/num/llvm_libc | Apache-2.0 WITH LLVM-exception | yes (keep notice) |
| Arm optimized-routines pow | src/num/js_pow* | MIT OR Apache-2.0 WITH LLVM-exception | yes |
| glibc __tanh_fma/__expm1_fma | src/num/js_tanh.cpp | Sun notice; 1997 Shimizu change: see below | **open question** |
| pffft (marton78) | third_party/pffft | BSD-like (FFTPACK/UCAR) | yes |
| dr_mp3, dr_wav | third_party/dr_libs | Unlicense or MIT-0 | yes |
| yyjson | third_party/yyjson | MIT | yes |
| doctest | third_party/doctest | MIT | tests only, not shipped |
| miniaudio | native/devhost/third_party | Unlicense or MIT-0 | dev host only (Windows later: fine) |
| Swift shell, C audio/MIDI glue | native/apple/Sources | own code | yes |
| Apple SDK frameworks | system | Apple SDK terms | yes (not redistributed) |
| Salamander Grand Piano | app/samples/salamander-piano | CC BY 3.0 | yes (attribution) |
| VSCO 2 CE upright | app/samples/upright-piano | CC0 1.0 | yes |
| Musyng Kite, 21 instruments | app/samples/* | CC BY-SA 3.0 | yes: samples stay BY-SA as a separate work; code isn't an adaptation of them |
| 7 theme fonts | app/fonts | OFL 1.1 (no RFN) | yes |
| Theme textures/SVGs (grain.png, paper.png, lancets, mark) | app/themes, app/assets | own (project commits; no third-party source recorded) [U] | yes |
| EXS format table | tools/exs/layout.mjs (Electron build only) | own code; offsets from open-source RE projects (exs2sfz.py, ConvertWithMoss, exs24-parser) per its header | format facts, no code copied per header [U: not compared] |
| Electron/Chromium runtime | node_modules/electron (Electron build only) | MIT + Chromium notices (LGPL ffmpeg as a dynamic lib) | yes as shipped; not in the native 2.0 app |

No GPL code anywhere in app/ or native/. The only LGPL question is js_tanh.cpp.

### Uncertain / for Ryan
1. **js_tanh.cpp (glibc expm1).** glibc 2.39 `s_expm1.c` = Sun fdlibm file + "Modified by Naohiko Shimizu/Tokai
   University, Japan 1997/08/25" (split R1/R2/R3 polynomial evaluation), which the port reproduces because the bits
   depend on it. Fetched the 2.39 file (bminor/glibc mirror): no licence statement besides the Sun notice; glibc's
   `LICENSES` lists Sun fdlibm files under the Sun notice. WAVE0B_REVIEW had called the change LGPL-2.1+. My reading:
   low risk; my inference, not legal advice. To settle it: re-derive those ~6 lines or keep that file under LGPL
   terms. Recorded in LICENSES.md.
2. **Notices in the shipped native bundle (pre-existing gap).** project.yml bundles only `app/` and `docs/`, so the
   .app carries no `LICENSE`, `LICENSES.md` or third-party licence texts (BSD-3/MIT/Apache want notices in binary
   distributions; CC BY attribution belongs in-app). The PolyForm URL + Required Notice do reach the bundle through
   `docs/release-notes-2.0.md` and `docs/site/index.html`. Suggested follow-up (needs a Mac build, not done here): add
   `../../LICENSE`, `../../LICENSES.md` and a generated third-party notices file to both targets' resources + a
   `package-release.sh` check. Electron `files` now includes LICENSE (build-lint not run in this light lane).
3. Site/README links use `blob/main/LICENSE` and `blob/main/LICENSE-1.x.md`: correct once v2-native is merged into
   main at release (MAC_CHECK step 1); until then main's LICENSE is still GPL.
4. CONTRIBUTING's relicensing grant (point 3) is plain-language, not a lawyer-drafted CLA (D38: "not legal advice").
5. For memory/orchestrator: Ryan confirmed GitHub account `ilomacht` is his own (coordinator relay, 2026-11-28; D38
   on origin 9ac004f).

### Gates
`node tools/cloud/gates.mjs unit,shell-unit` on 1bbd9c5 (tree 1bbd9c5d37e4, clean): unit PASS 23 s,
shell-unit PASS 28 s. Also PASS on the pre-rebase tree baa8095. No browser suites (light lane).
