#!/usr/bin/env node
// T15: reference renders of app/js/engine/organ.js for what the golden fixtures do not exercise: legato (TrackedParam
// glides of f/2 and the percussion), bend, the rotary param (slow -> fast -> off ramps), morph (half-moon switch),
// click / drive params, a pedal-held percussion roll, the 2x-oversampled overdrive (drive > .5 at construction),
// 48 kHz. Method and format: dump-synth-extra-lib.mjs.
//   node tools/golden/vectors/dump-organ.mjs   -> tools/golden/vectors/data/organ.txt
import path from 'node:path';
import { DATA } from './lib.mjs';
import { dumpCases } from './dump-synth-extra-lib.mjs';

const CASES = [
  { name: 'gospel-roll', patch: 'gospel', sec: 0.9, win: [0.05, 0.9],
    ev: [[0.05, 'on', 60, 100], [0.1, 'on', 64, 90], [0.15, 'on', 67, 90], [0.3, 'legato', 67, 69], [0.35, 'bend', 1],
      [0.45, 'off', 60], [0.5, 'on', 72, 100], [0.7, 'off', 64]] },
  { name: 'soft-rotary', patch: 'soft-pad', sec: 1.2, win: [0.05, 1.2],
    ev: [[0.05, 'on', 55, 100], [0.05, 'on', 62, 100], [0.3, 'param', 'rotary', 'fast'], [0.6, 'morph', 1],
      [0.8, 'param', 'rotary', 'off'], [0.9, 'param', 'click', 1], [0.95, 'on', 67, 100], [1.0, 'param', 'drive', 0.4],
      [1.05, 'off', 55]] },
  { name: 'full-drive', patch: 'full', params: { drive: 0.8 }, sec: 0.7, win: [0.05, 0.7],
    ev: [[0.05, 'on', 48, 110], [0.05, 'on', 60, 110], [0.4, 'off', 48]] },
  { name: 'church-48k', patch: 'church', sr: 48000, sec: 0.8, win: [0.05, 0.8],
    ev: [[0.05, 'on', 57, 90], [0.3, 'param', 'release', 0.2], [0.4, 'off', 57]] },
];

await dumpCases(path.join(DATA, 'organ.txt'), 'organ.js reference renders', 'organ', CASES);
