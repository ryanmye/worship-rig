# Working so a restart loses nothing (cloud box, 2026-11-27)

The cloud box restarts often. A restart kills every process (agents, test runs, servers) but keeps the disk:
worktrees, commits, logs and `/home/claude/*` survive. So everything that matters must be on disk, in small pieces.

## Rules for every builder and skeptic

1. **Commit early, commit often** on your lane branch (`lane-*`), at least after every sub-step that passes its own
   quick test. A `WIP:` commit is fine; squash nothing. Never leave more than ~20 minutes of work uncommitted.
2. **Keep `LANE.md` at the worktree root** (committed on the lane, removed by the orchestrator before merge): the
   brief in one paragraph, a checklist of steps with `[x]` / `[ ]`, the next step, findings so far (for a skeptic:
   F/O items as you find them, before fixing), and open questions. Update it with each commit. After a restart, read
   it and `git log` first and carry on from the first unchecked step.
3. **Run gates with the resumable runner**, never as one long chained command:
   `node tools/cloud/gates.mjs shell-unit,unit,ui-v6,ui-v6-edit,...` — it runs suites one at a time, records each
   result per tree in `<git-dir>/rig-gates.json`, and on a rerun skips what already passed on the same tree. Logs are
   in `<git-dir>/rig-gates/<suite>.log`. `--status` shows where things stand. Commit before running gates, so the
   tree key is stable and the results survive.
4. **Long probes write their output to files** under the worktree's `.probe/` (git-ignored by `.git/info/exclude`)
   or `/home/claude/scratch/<lane>/`, not only to the terminal.
5. **Reports:** write the final report to `native/docs/reviews/<name>.md` (skeptic) or `LANE.md` (builder) and
   commit it before handing back, so a restart during the hand-back loses nothing.

## Orchestrator

- `/home/claude/ORCH-STATE.md` (not in git) lists each running lane: worktree, branch, agent role, agent id, brief
  summary, and what to do when it reports. Update it whenever an agent starts, reports or merges.
- After a restart: read ORCH-STATE.md, resume every listed agent with SendMessage (or restart it from its `LANE.md`
  if the transcript is gone), and rerun any gate list with `gates.mjs` (it skips what passed).
- Remove `LANE.md` in the merge commit (it is lane-local state, not project docs).
