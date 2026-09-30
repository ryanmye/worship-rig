# S1 GitHub Support request — draft (ready to send)

**Submit at:** https://support.github.com/contact
**Category to pick:** "Report abuse or spam" is wrong — choose **"Sensitive data removal"** (under Support ›
"I need help with something else" › the "sensitive data" flow), which routes to the team that purges cached
blobs/views for objects still reachable by SHA after a history rewrite. If that exact label isn't shown, pick
"Business, Legal, or Content" and select the sensitive-data-removal option there.

**Repo:** `ryanmye/worship-rig` (public)

---

## Request text

Subject: Purge unreachable objects still served by SHA — tools/exs/fixtures/real/*.exs

Hello,

I maintain the public repository `ryanmye/worship-rig`. On 2026-09-30 at approximately 00:15 UTC I rewrote the
repository's history with `git filter-repo` to remove a folder that was committed by mistake, and force-pushed the
rewritten history to `main`. I'm asking GitHub to run garbage collection on the repository (or otherwise purge
cached blobs/views) so the removed objects are no longer servable by their old commit or blob SHAs.

**What was removed:** `tools/exs/fixtures/real/` — six Apple GarageBand/Logic `.exs` instrument definition files
(sampler instrument metadata only, no audio), roughly 946 KB total. These are Apple-licensed content that should
never have been committed to a public repo.

**Why this matters:** although the files are gone from the current history and from `main`, they are still
reachable via the pre-rewrite commit SHAs — for example
`https://raw.githubusercontent.com/ryanmye/worship-rig/ab07706d1ae86e9b9490305385f1d0ee54f74863/tools/exs/fixtures/real/Grand%20Piano.exs`
still returns HTTP 200. I'd like these objects fully purged from GitHub's caches/CDN so they can no longer be
fetched by anyone who has (or guesses) the old SHA.

**Old commit SHAs that touched the removed path** (from the pre-rewrite mirror, `git log --all -- tools/exs/fixtures/real`):
- `31bf4cad0a33cf674366d8a6d990c398f8e10a90` — the rewrite commit itself, "security(S1): move Apple .exs fixtures out of the repo (RIG_EXS_FIXTURES)"
- `ab07706d1ae86e9b9490305385f1d0ee54f74863` — "baseline: cloud snapshot 2026-09-28" (the commit that introduced the files; still serves the files live, confirmed above)

**Blob SHAs of the six removed files** (`git rev-list --all --objects -- tools/exs/fixtures/real`, filtered to blobs):
- `64c7ae367e377f814b44146f88b99fcf2c394fb0` — Flea Market Wurli.exs
- `335c4b1347d23c71bcd1fb411b8c8ba84c0a78bf` — Grand Piano.exs
- `8684e9dc5bf51480decd131ee0597b982b0710e9` — Lullaby Vibes.exs
- `897a2c01d52f6e1e4e2f151270b453a5bed34160` — Steinway Grand Piano 2.exs
- `efaa2e6656bb7ffe17fb3212428e71984c72d876` — Steinway Piano 2.exs
- `786c087045e88148284a7f579ea130afad6bd632` — Yamaha Grand Piano.exs

**Forks:** the repository has zero forks (`gh repo view ryanmye/worship-rig --json forkCount` → `{"forkCount":0}`),
so there should be no other copies of this history to worry about.

Please let me know if you need anything else from me (repo owner confirmation, additional SHAs, etc.) to process
this. Thank you for your help.

---

## Verification notes (for my own record, not part of the submitted text)

- Pre-rewrite mirror used to collect SHAs: `~/Projects/worship-rig-transfer/repo-backup-20260930T001318Z.git`
- Commits touching the path: `git -C <mirror> log --all --format=%H -- tools/exs/fixtures/real` → 2 commits (listed above).
- Blobs touching the path: `git -C <mirror> rev-list --all --objects -- tools/exs/fixtures/real`, then each hash
  checked with `git cat-file -t` → 6 blobs, all type `blob` (matches the "six files" fact).
- Raw URL check: `ab07706d1ae86e9b9490305385f1d0ee54f74863` → HTTP 200 (file still served). The rewrite commit itself,
  `31bf4cad...`, returns 404 as expected (that commit's tree no longer contains the path).
- Fork count: `gh repo view ryanmye/worship-rig --json forkCount` → `{"forkCount":0}`.
