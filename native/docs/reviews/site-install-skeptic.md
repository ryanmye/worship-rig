# site-install skeptic: Mac install steps on the 2.0 site (2026-11-27)

Scope: `docs/site/index.html` + `style.css` at `ea74f95` (c4f4087's 2.0 install section, ea74f95's PolyForm
wording). Light check. Fix commit: `8febb02`.

**Verdict: MERGE.** The steps are right for macOS 15+; macOS 14 needed two wording fixes (done). Links give 1.x
users a working download today. No GPL / "open source" claim for 2.0.

## 1. macOS steps vs Apple

Sources: Apple Mac User Guide mh40617 ("Open an app by overriding security settings", also the 15.0 edition of
mh40616), Apple support 102445 ("Safely open apps on your Mac"), Apple Platform Security guide "Gatekeeper and
runtime protection", Apple Developer news "Updates to runtime protection in macOS Sequoia", Eclectic Light
"Living with(out) notarization" (2024-10-01), iBoysoft (third party, for the alert's buttons).

| Claim on the page | Status |
|---|---|
| macOS 15+: right-click › Open no longer gets past Gatekeeper | Verified (Apple Developer news: Control-click override removed in Sequoia) |
| Path System Settings › Privacy & Security › Security › Open Anyway | Verified (mh40617) |
| Button shows only after a blocked attempt, for about an hour | Verified (mh40617: "about an hour") |
| Sequoia alert buttons Done / Move to Trash | Third-party only (iBoysoft); Apple's pages don't name them |
| Second box: click Open Anyway again, then password | Verified for 15 by Eclectic Light; Apple says "Open" on the reappearing warning (102445) and "login password, then OK" (mh40617). Wording is fine either way |
| "Allow applications from" / "App Store & Known Developers" | Verified for current macOS (Platform Security guide). 102445 (Sonoma-era wording) says "App Store and identified developers": **F1, fixed** (both names now given) |
| "App Store" only → "won't offer Open Anyway at all" | Stronger than Apple; 102445 only says macOS won't open non-App Store apps. **F2, fixed** (softened to "may not get Open Anyway") |
| macOS 14 (supported minimum 14.5): page only said what 15 can't do | **F3, fixed**: Sonoma users told to right-click › Open › Open (works on 14; matches release-notes-2.0 line 281); step 1's "Done" now notes 14's buttons differ |
| `xattr -dr com.apple.quarantine "/Applications/Worship Rig.app"` | Correct: `-d` delete, `-r` recursive, combined flags OK, path quoted for the space; app name matches the dmg (`package-release.sh` checks `$mnt/Worship Rig.app`). Same line as README:501 |

## 2. Download links (1.1.1 is "latest")

`GET repos/ryanmye/worship-rig/releases/latest` → `v1.1.1` with `Worship-Rig-arm64.dmg`, `-arm64.zip`, `-x64.dmg`,
`-x64.zip`, starter library. `releases/latest/download/Worship-Rig-arm64.dmg` → 302 to
`releases/download/v1.1.1/Worship-Rig-arm64.dmg` (checked with curl). `releases/tag/v1.1.1` → 200 (Intel link has the
x64 dmg). 2.0's `package-release.sh` emits the same name, so the button switches to 2.0 once 2.0 is "latest".
No mismatch for 1.x users.

- **O1 (fixed in MAC_CHECK step 8.1):** step 8.1 already covers the window between merge and release, but not 2.0
  published as a **pre-release** (U9 item 3): then "latest" stays 1.1.1 indefinitely and the 2.0 page's button
  serves 1.1.1. Minimal fix: in that case pin both "Download for Mac" hrefs to
  `releases/download/v2.0.0/Worship-Rig-arm64.dmg` in the same push. Not done on the site now (it would 404 until
  the release exists).
- O2 (no action): `blob/main/LICENSE-1.x.md`, `native/...` links 404 today because they exist only on `v2-native`;
  they resolve once v2-native is merged to main (which is when pages.yml deploys this page).

## 3. HTML, no-JS, 375 / 1280 px

- Tag balance (python html.parser, void-aware): nothing left open, no mismatched closes.
- Playwright, `javaScriptEnabled: false`, served by `python -m http.server`: no console errors, no HTTP ≥ 400, no
  horizontal overflow at 375 or 1280 (`scrollWidth == innerWidth`, no element in `#install` past the edge); the
  `<details class="fix">` opens on click with JS off and its `<pre>` wraps (scrollWidth == clientWidth).
- Looked at the screenshots: readable at both widths. At 1280 `#install` is one of three columns (~340 px), so it
  reads like the phone layout; fine. O3 (no action): the xattr line soft-wraps at the space in
  `Worship Rig.app`; copy-paste is unaffected, only someone retyping it could be misled.

## 4. Licence wording

Only mentions of GPL are for 1.x (credits, footer). 2.0 is "source-available for noncommercial use" / PolyForm
Noncommercial 1.0.0; no "open source" anywhere in `docs/site/`.

## Unverified

- Sequoia first alert's button names (Done / Move to Trash): third-party source only.
- macOS 14's exact alert text and buttons for an ad-hoc-signed download: not found on Apple's pages; the page now
  avoids naming them.
- Whether a standard (non-admin) account needs an administrator's name and password for Open Anyway (one
  commenter says so; Apple says "login password").
- Whether "App Store" only really hides Open Anyway (Apple only says such apps won't open).
- The "does not have permission to open (null)" message as a symptom of quarantine: not checked against Apple.
- polyformproject.org link: the proxy refused the host, so its status wasn't checked.
