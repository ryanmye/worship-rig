import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const r = await page.evaluate(async () => {
  const SR = 48000, SEC = 30;
  async function run(kind) {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR * SEC, sampleRate: SR });
    const nb = ctx.createBuffer(2, SR, SR);
    for (let c = 0; c < 2; c++) { const d = nb.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 0.2 - 0.1; }
    for (let s = 0; s < 4; s++) {
      const src = new AudioBufferSourceNode(ctx, { buffer: nb, loop: true }); src.start();
      let prev = src;
      const bq = (o) => new BiquadFilterNode(ctx, o);
      if (kind === 'none') {}
      else if (kind.startsWith('series')) {
        const n = Number(kind.slice(6));
        for (let k = 0; k < n; k++) { const b = bq({ type: 'peaking', frequency: 200 * (k + 1), gain: 0 }); prev.connect(b); prev = b; }
      } else if (kind.startsWith('dw')) { // dry/wet per band, n active of 10
        const n = Number(kind.slice(2));
        for (let k = 0; k < 10; k++) {
          const j = new GainNode(ctx); const dry = new GainNode(ctx, { gain: k < n ? 0 : 1 }); const wet = new GainNode(ctx, { gain: k < n ? 1 : 0 });
          const b = bq({ type: 'peaking', frequency: 200 * (k + 1), gain: 0 });
          prev.connect(dry).connect(j); if (k < n) prev.connect(b).connect(wet); wet.connect(j); prev = j;
        }
      } else if (kind.startsWith('ramp')) {
        const n = 5, krate = kind === 'rampk';
        for (let k = 0; k < n; k++) { const b = bq({ type: 'peaking', frequency: 200 * (k + 1), gain: 0 });
          if (krate) for (const p of [b.frequency, b.Q, b.gain, b.detune]) p.automationRate = 'k-rate';
          for (let t = 0; t < SEC; t += 0.5) b.gain.setTargetAtTime((t * 2) % 2 ? 6 : -6, t, 0.1);
          prev.connect(b); prev = b; }
      }
      prev.connect(ctx.destination);
    }
    const t0 = performance.now(); await ctx.startRendering(); return performance.now() - t0;
  }
  const out = {};
  for (const k of ['none', 'series2', 'dw0', 'dw2', 'series5', 'dw5', 'series8', 'dw8']) {
    const v = []; for (let i = 0; i < 3; i++) v.push(await run(k)); v.sort((a, b) => a - b); out[k] = Math.round(v[1]);
  }
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
