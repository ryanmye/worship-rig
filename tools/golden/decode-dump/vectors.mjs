#!/usr/bin/env node
// processSample vectors (T06): written by dump.mjs next to the decode dumps (<out>/proc/*.wav + manifest `proc` rows:
// 6 files x variants `def` (the set's own decodeOpts) and `cap` ({maxSec 1.5, maxMonoLossDb}) so the cap fade, the
// mono-loss limiter and dual-mono collapse are all covered). This entry point just runs the dumper.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r = spawnSync(process.execPath, [fileURLToPath(new URL('./dump.mjs', import.meta.url)), ...process.argv.slice(2)],
  { stdio: 'inherit' });
process.exit(r.status ?? 1);
