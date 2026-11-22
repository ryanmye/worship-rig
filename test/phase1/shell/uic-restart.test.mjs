// UIC (UIB review O4): controller.restartAudio kept `restarting` set only until the engine restart resolved, then
// awaited resumeRecording(part) (the split take) with the flag already clear. A request in that window started a
// second restart (stopping the take that was being resumed) instead of being queued as restartAgain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

async function setup(recorder) {
  const store = makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = createController({
    store, engine, midi, recorder, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: { isElectron: true, onMenu: () => () => {} }, timers: fakeTimers(), now: () => 0, locks: null,
    heartbeat: false, indexedDB: null,
  });
  await ctl.start();
  return { engine, ctl };
}

test('UIC O4: a restart asked for while the split take resumes is queued, not started alongside', async () => {
  const log = [];
  let releaseStart = null;
  const rec = new EventTarget();
  rec.isRecording = true;
  rec.stop = async () => (log.push('stop'), (rec.isRecording = false), { path: '/Music/Worship Rig/Rig 1.wav' });
  rec.start = () => {
    log.push('start');
    // the first resume waits until the test lets it go; later ones finish at once
    if (log.filter((x) => x === 'start').length === 1) {
      return new Promise((r) => (releaseStart = () => {
        rec.isRecording = true;
        r({ ok: true, path: '/Music/Worship Rig/Rig 1 2.wav' });
      }));
    }
    rec.isRecording = true;
    return Promise.resolve({ ok: true, path: '/Music/Worship Rig/Rig 1 3.wav' });
  };
  const { engine, ctl } = await setup(rec);
  engine.clear();
  const first = ctl.restartAudio();
  for (let i = 0; i < 20 && !releaseStart; i++) await tick();
  assert.ok(releaseStart, 'the first restart reached resumeRecording');
  assert.equal(engine.of('restart').length, 1);
  // the window: engine restarted, take not resumed yet
  const second = ctl.restartAudio();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(engine.of('restart').length, 1, 'no second engine restart while the take resumes');
  assert.deepEqual(log, ['stop', 'start'], 'the resuming take is not stopped by a second restart');
  releaseStart();
  assert.equal(await first, true);
  assert.equal(await second, true, 'the queued request resolves with its follow-up run');
  assert.equal(engine.of('restart').length, 2, 'the queued request ran once, after the resume');
  assert.deepEqual(log, ['stop', 'start', 'stop', 'start']);
  assert.equal(ctl.status.audio === 'restarting', false);
});
