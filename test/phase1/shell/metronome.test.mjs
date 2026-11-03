// v11-metronome: song.timeSig + settings.click + settings.midiClockOut in the store, and the controller's click wiring
// (start with the count-in, song switch = new bar, settings → engine, MIDI clock sink, Revert) against a fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { migrate } from '../../../app/js/store.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

/** The fake engine plus the click API (state kept like the real Metronome). */
function clickEngine() {
  const e = fakeEngine();
  const rec = (name) => (...args) => e.calls.push([name, ...args]);
  e.click = { running: false };
  e.clickStart = (o) => {
    e.calls.push(['clickStart', o]);
    e.click.running = true;
    e.dispatchEvent(new CustomEvent('click', { detail: { running: true, counting: (o && o.countIn) > 0 } }));
    return { t0: 0.06, downbeat: 2 };
  };
  e.clickStop = () => {
    e.calls.push(['clickStop']);
    const was = e.click.running;
    e.click.running = false;
    e.dispatchEvent(new CustomEvent('click', { detail: { running: false, counting: false } }));
    return was;
  };
  e.clickState = () => ({ running: e.click.running });
  e.setTimeSig = rec('setTimeSig');
  // like a 2-channel output: outputs 3–4 are not there, so the routing in effect stays 'main'
  e.setClick = (cfg) => (e.calls.push(['setClick', cfg]), { output: 'main', auxAvailable: false });
  e.setClockSink = rec('setClockSink');
  e.clickOutputs = () => ({ aux: false, channels: 2 });
  return e;
}

async function setup(store = makeStore()) {
  const engine = clickEngine();
  const ctl = createController({ store, engine, midi: null, recorder: null, doc: fakeDoc(), nav: null,
    win: new EventTarget(), rig: null, timers: fakeTimers(), now: () => 0 });
  store.seedFactory();
  await ctl.start();
  await tick();
  return { store, engine, ctl };
}

test('store: song.timeSig is optional and validated; settings.click / midiClockOut absent until set', () => {
  const store = makeStore();
  store.seedFactory();
  const id = store.get().songOrder[0];
  assert.equal('timeSig' in store.getSong(id), false);
  assert.equal('click' in store.get().settings, false);
  assert.equal('midiClockOut' in store.get().settings, false);
  assert.equal(store.set(`songs.${id}.timeSig`, '6/8'), true);
  assert.equal(store.getSong(id).timeSig, '6/8');
  assert.equal(store.set(`songs.${id}.timeSig`, '7/4'), false); // not offered
  assert.equal(store.set(`songs.${id}.timeSig`, null), true);
  assert.equal('timeSig' in store.getSong(id), false);
  assert.equal(store.setClick({ level: 2, countIn: 2, junk: 1 }), true);
  assert.deepEqual(store.get().settings.click, { level: 1, countIn: 2, junk: 1 });
  assert.equal(store.setClick({ level: null, countIn: null, junk: null }), true);
  assert.equal('click' in store.get().settings, false); // emptied = absent
  assert.equal(store.set('settings.click', 'loud'), false);
  assert.equal(store.set('settings.midiClockOut', 'IAC Driver Bus 1'), true);
  assert.equal(store.set('settings.midiClockOut', 42), false);
  assert.equal(store.set('settings.midiClockOut', null), true);
  assert.equal('midiClockOut' in store.get().settings, false);
  // migrate keeps a valid timeSig / click, drops bad ones, and is idempotent
  const raw = JSON.parse(store.exportJSON({ pretty: false }));
  raw.songs[id].timeSig = '3/4';
  const other = store.get().songOrder[1];
  raw.songs[other].timeSig = '9/8';
  raw.settings.click = { countIn: 1, output: 'ch9' };
  const a = migrate(raw);
  assert.equal(a.songs[id].timeSig, '3/4');
  assert.equal('timeSig' in a.songs[other], false);
  assert.deepEqual(a.settings.click, { countIn: 1 });
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(a))), a);
});

test('controller: Click starts with settings.click (count-in, count-in only), toggles off, needs a tempo', async () => {
  const { store, engine, ctl } = await setup();
  const id = store.currentSong().id;
  store.set(`songs.${id}.tempo`, null);
  await tick();
  assert.equal(ctl.status.click.available, false);
  assert.equal(ctl.toggleClick(), false); // no tempo: nothing starts
  assert.equal(engine.of('clickStart').length, 0);
  store.set(`songs.${id}.tempo`, 84);
  await tick();
  assert.equal(ctl.status.click.available, true);
  store.setClick({ countIn: 2, after: 'quiet' });
  await tick();
  assert.equal(ctl.toggleClick(), true);
  assert.deepEqual(engine.of('clickStart').at(-1)[1], { countIn: 2, quietAfter: true });
  assert.equal(ctl.status.click.on, true);
  assert.equal(ctl.status.click.counting, true);
  assert.equal(ctl.toggleClick(), false);
  assert.equal(engine.of('clickStop').length, 1);
  assert.equal(ctl.status.click.on, false);
  ctl.dispose();
});

test('controller: song switch → setTimeSig(newBar) after the tempo, never a stop; same-song edits keep the bar',
  async () => {
  const { store, engine, ctl } = await setup();
  const [a, b] = store.get().songOrder;
  store.set(`songs.${a}.tempo`, 90);
  store.set(`songs.${b}.tempo`, 120);
  store.set(`songs.${b}.timeSig`, '3/4');
  await ctl.selectSong(a);
  ctl.startClick();
  engine.clear();
  await ctl.selectSong(b);
  const names = engine.names();
  assert.ok(names.indexOf('setTempo') < names.indexOf('setTimeSig'), names.join(','));
  assert.deepEqual(engine.of('setTimeSig').at(-1).slice(1), ['3/4', { newBar: true }]);
  assert.equal(engine.of('clickStop').length, 0); // the click keeps running across the switch
  engine.clear();
  store.set(`songs.${b}.tempo`, 126); // Tap: tempo only
  await tick();
  assert.equal(engine.of('setTimeSig').length, 0);
  assert.deepEqual(engine.of('setTempo').at(-1).slice(1), [126]);
  store.set(`songs.${b}.timeSig`, '6/8'); // a new meter on the same song starts a new bar
  await tick();
  assert.deepEqual(engine.of('setTimeSig').at(-1).slice(1), ['6/8', { newBar: true }]);
  ctl.dispose();
});

test('controller: settings.click → engine.setClick; midiClockOut attaches / detaches the clock sink', async () => {
  const { store, engine, ctl } = await setup();
  engine.clear();
  store.setClick({ level: 0.25, record: true, output: 'aux' });
  await tick();
  assert.deepEqual(engine.of('setClick').at(-1)[1], { level: 0.25, record: true, output: 'aux' });
  assert.equal(ctl.status.click.output, 'main'); // what the engine could do (no outputs 3–4 here)
  store.set('settings.midiClockOut', 'IAC Driver Bus 1');
  await tick();
  assert.equal(typeof engine.of('setClockSink').at(-1)[1], 'function');
  assert.equal(ctl.status.click.midiClock, 'IAC Driver Bus 1');
  assert.equal(ctl.status.click.midiClockConnected, false); // no MIDI access in this test
  store.set('settings.midiClockOut', null);
  await tick();
  assert.equal(engine.of('setClockSink').at(-1)[1], null);
  ctl.dispose();
});

test('controller: Revert takes a changed time signature back to absent (4/4)', async () => {
  const { store, ctl } = await setup();
  const id = store.currentSong().id;
  store.set(`songs.${id}.timeSig`, '3/4');
  await tick();
  assert.equal(ctl.revertSong(), true);
  assert.equal('timeSig' in store.getSong(id), false);
  ctl.dispose();
});
