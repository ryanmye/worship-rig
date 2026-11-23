# Cloud orchestration helpers (copied from the 2026-11-22/23 Cowork session)

Starting points, not tools to run as they are. Paths at the top (scratchpad, journal directory) belong to the old
session and must be edited first. See REPICKUP §0 and §4.

- `core2.js`, `core3.js`, `macfix.js`: Workflow scripts. Each runs a builder, then a skeptic, then an integrator.
  Shared rules: `-j2`, own build dirs, never `git commit` inside agents, and a gate on fixtures, ctest and ui-core.
- `integ4.js`: the scoped re-check. Ryan's rule is "only check affected sections": scope every check by
  `git diff --stat <last gated commit>`.
- `progress.py`: a one-line progress probe over a workflow journal. It reads the run ids from `runs.txt`.
- `ckpt.sh`: checkpoint commit plus an incremental bundle, for the Mac PUSH protocol. With direct push, use
  `git push origin v2-native` instead.
- `dashboard-index.html`, `progress.json`, `checks.json`, `fixtures.json`: the progress dashboard's page and data as of
  the handoff.
