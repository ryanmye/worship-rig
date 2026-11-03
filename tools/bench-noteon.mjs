#!/usr/bin/env node
// Note-on cost benchmark (v11-touch): time engine.noteOn() + noteOff() on four synth slots in headless Chromium, on
// an OfflineAudioContext (nothing renders, so this is the JS + node-creation cost of the MIDI path), plus the velocity
// curve evaluation alone. Used for CONTRACT_CHANGES "## v11-touch" before/after numbers.
//
//   node tools/bench-noteon.mjs [--app <dir with js/engine/>] [--rounds 7] [--notes 2000]
//
// --app lets the same script time an older checkout's engine (e.g. `git archive <rev> app | tar -x -C /tmp/base`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const APP = path.resolve(arg('--app', path.join(here, '..', 'app')));
const ROUNDS = Number(arg('--rounds', 7));
const NOTES = Number(arg('--notes', 2000)); // stubbed-instrument rounds play 10× this
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>bench</title>');
    return;
  }
  if (p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  const full = path.normalize(path.join(APP, p));
  if (!full.startsWith(APP) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  const out = await page.evaluate(async ({ ROUNDS, NOTES }) => {
    const { AudioEngine, curveVelocity } = await import('/js/engine/index.js');
    const slot = (id, curve) => ({ instrument: { type: 'synth', id }, gain: 0.5, velocityCurve: curve,
      sends: { reverb: 0, delay: 0, chorus: 0 } });
    const P = { slots: [slot('soft-keys', 'normal'), slot('warm-pad', 'soft'), slot('bell', 'hard'),
      slot('soft-keys', 'normal')], fx: {} };
    const fresh = async (stub) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 44100 * 60, sampleRate: 44100 });
      const e = new AudioEngine({ context: ctx, seed: 7 });
      await e.start();
      const tok = await e.prepare(P);
      if (!e.commit(tok, { when: 0 })) throw new Error('commit refused');
      // stub: the instruments' own noteOn/noteOff do nothing, so what is left is the engine's MIDI path (split,
      // transpose, velocity curve, bookkeeping) — the part v11-touch changed
      if (stub) {
        for (const sc of e.slots) {
          if (!sc) continue;
          const v = { state: 'held' };
          sc.inst.noteOn = (n, v01) => {
            sink += v01;
            return v;
          };
          sc.inst.noteOff = () => {};
        }
      }
      return e;
    };
    let sink = 0;
    const touch = { shape: 0.8, min: 0.1, max: 1, top: 110 };
    const hasTouch = AudioEngine.prototype.noteOn.toString().includes('touch');
    const time = (e, n, opts) => {
      let t = 0.01;
      const t0 = performance.now();
      for (let k = 0; k < n; k++) {
        const note = 36 + (k % 48);
        e.noteOn(note, 20 + (k % 100), opts ? { when: t, ...opts } : { when: t });
        e.noteOff(note, { when: t + 0.001 });
        t += 0.002;
      }
      return ((performance.now() - t0) / n) * 1000; // µs per note-on (+ its note-off)
    };
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const res = {};
    const stub = await fresh(true);
    time(stub, NOTES); // warm-up (JIT)
    for (const [k, opts] of [['stubUs', null], ['stubTouchUs', hasTouch ? { touch } : undefined]]) {
      if (opts === undefined) continue;
      const a = [];
      for (let r = 0; r < ROUNDS; r++) a.push(time(stub, NOTES * 10, opts));
      res[k] = +med(a).toFixed(3);
    }
    const real = [];
    const realTouch = [];
    for (let r = 0; r < ROUNDS; r++) {
      real.push(time(await fresh(false), 200, null));
      if (hasTouch) realTouch.push(time(await fresh(false), 200, { touch }));
    }
    res.realUs = +med(real).toFixed(1);
    if (hasTouch) res.realTouchUs = +med(realTouch).toFixed(1);
    // the curve function alone: 1e6 evaluations of the named curves
    const N = 1e6;
    let acc = 0;
    const c0 = performance.now();
    for (let k = 0; k < N; k++) acc += curveVelocity(k & 127, k & 1 ? 'soft' : 'hard');
    res.curveNs = +(((performance.now() - c0) / N) * 1e6).toFixed(1);
    // what noteOn does per slot: before = curveVelocity(vel, cfg.velocityCurve); after = the cached compiled curve
    const scs = stub.slots.filter(Boolean);
    let per;
    if (typeof stub._slotTouch === 'function') {
      const { touchAt, LINEAR_TOUCH } = await import('/js/shared/touch-curve.js');
      per = (sc, v) => {
        const c = sc.cfg;
        return touchAt((sc.touchCfg === c ? sc.touchK : stub._slotTouch(sc, c)) || LINEAR_TOUCH, v);
      };
    } else per = (sc, v) => curveVelocity(v, sc.cfg.velocityCurve);
    const s0 = performance.now();
    for (let k = 0; k < N; k++) acc += per(scs[k & 3], k & 127);
    res.slotCurveNs = +(((performance.now() - s0) / N) * 1e6).toFixed(1);
    return { ...res, rounds: ROUNDS, notes: NOTES, check: acc > 0 && sink > 0 };
  }, { ROUNDS, NOTES });
  console.log(JSON.stringify({ app: APP, ...out }));
} finally {
  await browser.close();
  server.close();
}
