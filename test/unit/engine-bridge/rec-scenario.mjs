// The recording scenario shared by record-devhost-log.mjs (live, against rig-devhost) and native-recorder.test.mjs
// (replayed from the recorded log). Not a test file. Returns everything the NativeRecorder facade showed the app.
import { NativeRecorder } from '../../../app/js/engine-bridge/native-recorder.js';

/** A test-voice patch the core's builtin `inst.test` plays (no samples needed). */
export const TEST_PATCH = {
  slots: [{ instrument: { type: 'test', id: 'sine' }, gain: 0.5, params: { attack: 0.002, release: 0.05 } },
    null, null, null],
};

/**
 * @param {import('../../../app/js/engine-bridge/bridge-engine.js').BridgeEngine} engine
 * @param {{wait:(ms:number)=>Promise<void>, win?:object}} o
 */
export async function runRecScenario(engine, { wait, win }) {
  const rec = new NativeRecorder({ engine, win: win || { addEventListener() {}, removeEventListener() {} } });
  const out = { states: [], levels: 0, maxPeak: 0, warns: [], results: [], errors: [] };
  rec.addEventListener('state', (e) => {
    const { state, sink, filename, result } = e.detail;
    out.states.push(result ? `${state}:${result.error ? 'error' : 'ok'}` : `${state}${sink ? `:${sink}` : ''}`);
    if (state === 'recording') out.recordingFilename = filename;
  });
  rec.addEventListener('level', (e) => {
    out.levels += 1;
    out.maxPeak = Math.max(out.maxPeak, e.detail.peak);
  });
  rec.addEventListener('warn', (e) => out.warns.push(e.detail.message));
  // engine.start() also needs `get instruments` (InstrumentService, T11); record whether it worked, then drive the
  // song through the link so the scenario does not depend on wave-2 modules
  try {
    await engine.start();
    out.engineStart = 'ok';
  } catch (err) {
    out.engineStart = err.code || String(err);
  }
  await engine._req('audio', { action: 'start' });
  const { token } = await engine._req('prepare', { patch: TEST_PATCH });
  out.committed = (await engine._req('commit', { token })).committed;
  await wait(100);
  engine._link.send('play', { e: 'on', n: 69, vel: 100 });
  const r1 = await rec.start({ sink: 'opfs' }); // what controller.js passes outside Electron: ignored
  out.start1 = { ok: r1.ok, sink: r1.sink, hasPath: !!r1.path, filename: r1.filename };
  await wait(700);
  try {
    await engine._req('rec', { action: 'start' }); // a second take while one runs: native says busy
    out.errors.push('no error');
  } catch (err) {
    out.errors.push(err.code);
  }
  const busy = await rec.start();
  out.busyWhileRecording = busy.ok === false && /busy/.test(busy.error);
  await wait(700);
  out.elapsedBeforeStop = rec.elapsed;
  const res1 = await rec.stop();
  out.results.push(res1 && { sink: res1.sink, path: !!res1.path, durationSec: res1.durationSec, bytes: res1.bytes,
    dataBytes: res1.dataBytes, sampleRate: res1.sampleRate, error: res1.error || null });
  out.stopWhenIdle = await rec.stop();
  const none = await engine._req('rec', { action: 'stop' });
  out.nativeStopWhenIdle = none;
  engine._link.send('play', { e: 'off', n: 69 });
  const r2 = await rec.start({ filename: 'Custom Take.wav' });
  out.start2 = { ok: r2.ok, filename: r2.filename };
  await wait(400);
  const res2 = await rec.stop();
  out.results.push(res2 && { sink: res2.sink, filename: res2.filename, durationSec: res2.durationSec,
    error: res2.error || null });
  out.finalState = rec.state;
  rec.dispose();
  return out;
}
