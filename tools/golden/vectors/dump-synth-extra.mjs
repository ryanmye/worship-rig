#!/usr/bin/env node
// T15: reference renders of app/js/engine/synth-extra.js for what the golden fixtures do not exercise: legato
// (glidePitched incl. the PWM period glide), pitch bend, every IMPL[*].apply param, morph, the steal fade, allOff,
// fadeOutVoice, the slot of a stereo filter envelope, 48 kHz. Method and format: dump-synth-extra-lib.mjs.
//   node tools/golden/vectors/dump-synth-extra.mjs   -> tools/golden/vectors/data/synth-extra.txt
import path from 'node:path';
import { DATA } from './lib.mjs';
import { dumpCases } from './dump-synth-extra-lib.mjs';

const CASES = [
  { name: '808-legato', patch: '808-sub', sec: 0.9, win: [0.05, 0.9],
    ev: [[0.05, 'on', 36, 100], [0.3, 'legato', 36, 43], [0.4, 'param', 'drive', 0.9], [0.5, 'morph', 0.5],
      [0.55, 'bend', -2], [0.7, 'off', 43]] },
  { name: 'pluck-params', patch: 'pluck', sec: 0.9, win: [0.05, 0.9],
    ev: [[0.05, 'on', 60, 100], [0.06, 'on', 72, 70], [0.2, 'param', 'cutoff', 2500], [0.25, 'param', 'square', 1],
      [0.3, 'param', 'resonance', 0.8], [0.35, 'param', 'decay', 2], [0.45, 'morph', 1], [0.5, 'legato', 72, 67],
      [0.6, 'off', 60]] },
  { name: 'pluck-steal', patch: 'pluck', sec: 0.7, win: [0, 0.7], cap: 4,
    ev: [...Array.from({ length: 7 }, (_, i) => [0.02 + i * 0.03, 'on', 55 + i * 2, 80 + i * 5]),
      [0.3, 'fade', 61, 0.05], [0.45, 'allOff']] },
  { name: 'bass-params', patch: 'synth-bass', sec: 0.8, win: [0.05, 0.8],
    ev: [[0.05, 'on', 36, 110], [0.2, 'param', 'cutoff', 900], [0.25, 'param', 'square', 0.1],
      [0.3, 'param', 'resonance', 0.7], [0.35, 'legato', 36, 31], [0.45, 'morph', 0.6], [0.6, 'off', 31]] },
  { name: 'poly-params', patch: 'poly-stab', sec: 0.8, win: [0.05, 0.8],
    ev: [[0.05, 'on', 60, 100], [0.05, 'on', 64, 90], [0.25, 'param', 'resonance', 0.9],
      [0.3, 'param', 'detune', 25], [0.35, 'param', 'cutoff', 2000], [0.4, 'morph', 0.8], [0.45, 'bend', 1],
      [0.6, 'off', 60]] },
  { name: 'brass-vib', patch: 'analog-brass', params: { vibDelay: 0.1 }, sec: 0.9, win: [0.05, 0.9],
    ev: [[0.05, 'on', 62, 100], [0.3, 'param', 'vibRate', 7], [0.32, 'param', 'vibDepth', 20],
      [0.35, 'param', 'envAmount', 1], [0.4, 'param', 'detune', 20], [0.45, 'morph', 1], [0.5, 'param', 'cutoff', 1500],
      [0.6, 'off', 62]] },
  { name: 'lead-pwm', patch: 'square-lead', params: { vibDelay: 0.05, pwm: 0.4 }, sec: 0.8, win: [0.05, 0.8],
    ev: [[0.05, 'on', 67, 100], [0.2, 'param', 'pwm', 0.9], [0.25, 'legato', 67, 74], [0.35, 'param', 'sub', 0.9],
      [0.4, 'morph', 0.5], [0.45, 'param', 'vibRate', 7], [0.5, 'param', 'vibDepth', 30], [0.6, 'off', 74]] },
  { name: 'juno-pwm', patch: 'juno-pad', params: { attack: 0.05 }, sec: 0.9, win: [0.05, 0.9],
    ev: [[0.05, 'on', 57, 100], [0.05, 'on', 64, 90], [0.25, 'param', 'pwmRate', 3], [0.3, 'param', 'pwmDepth', 1],
      [0.35, 'param', 'chorus', 1], [0.4, 'param', 'chorusRate', 1.5], [0.45, 'legato', 64, 62],
      [0.5, 'param', 'resonance', 0.6], [0.55, 'param', 'sub', 0.8], [0.6, 'morph', 1], [0.7, 'off', 57]] },
  { name: 'juno-48k', patch: 'juno-pad', sr: 48000, params: { attack: 0.05 }, sec: 0.6, win: [0.05, 0.6],
    ev: [[0.05, 'on', 48, 100], [0.3, 'off', 48]] },
  { name: 'supersaw-width', patch: 'supersaw-pad', params: { attack: 0.05 }, sec: 0.8, win: [0.05, 0.8],
    ev: [[0.05, 'on', 60, 100], [0.25, 'param', 'width', 1], [0.3, 'param', 'detune', 40], [0.35, 'param', 'sub', 0.9],
      [0.4, 'param', 'resonance', 0.5], [0.45, 'morph', 1], [0.5, 'param', 'cutoff', 6000], [0.6, 'off', 60]] },
  { name: 'shimmer-bloom', patch: 'shimmer-pad', params: { attack: 0.05, bloomTime: 0.4, release: 0.5 }, sec: 0.9,
    win: [0.05, 0.9],
    ev: [[0.05, 'on', 60, 100], [0.2, 'param', 'tremRate', 3], [0.25, 'param', 'tremDepth', 0.9],
      [0.3, 'param', 'octave', 0.9], [0.3, 'off', 60], [0.35, 'param', 'detune', 15], [0.4, 'morph', 0.5],
      [0.45, 'on', 67, 90], [0.5, 'param', 'cutoff', 3000]] },
];

await dumpCases(path.join(DATA, 'synth-extra.txt'), 'synth-extra.js reference renders', 'synth', CASES);
