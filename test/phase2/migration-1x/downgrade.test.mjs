// Lane E5, the downgrade story: a 2.0 library offered to the real 1.1 store (`git archive v1.1.0 app/js`, no
// checkout). Skipped, with the reason, when the v1.1.0 tag is not in this clone. The in-app version of the same
// check (1.1's Settings › Import…, "Import latest backup" and localStorage, watching for page errors) is recorded by
// tools/gen-library-1x-fixtures.mjs in test/fixtures/library-1x/v1.1.0/downgrade-v1.1.0.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as S2 from '../../../app/js/store.js';
import { ROOT, FIX, fixture, jsonDiff, plain, tmpDir } from './lib.mjs';

const REF = 'v1.1.0';
const has = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', `${REF}^{commit}`]).status === 0;
let dir = null;
let S1 = null;
before(async () => {
  if (!has) return;
  dir = tmpDir('v11');
  const r = spawnSync('bash', ['-c', `git -C "${ROOT}" archive ${REF} app/js | tar -x -C "${dir}"`]);
  assert.equal(r.status, 0, String(r.stderr));
  S1 = await import(path.join(dir, 'app/js/store.js'));
});
after(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
const skip = has ? false : `tag ${REF} not in this clone (git fetch origin tag ${REF})`;

let n = 0;
const opts = (S, extra = {}) => ({
  storage: S.memoryStorage(), idGen: (p) => `${p}-d${++n}`, requestIdle: null, warn: () => {}, autoFlush: false, ...extra,
});
/** A 2.0 library: the 1.1 rich backup imported, plus 2.0-only content (6 slots, PC → cue, a chart, 2.0 settings). */
function library20() {
  const s = S2.createStore(opts(S2));
  assert.equal(s.importJSON(fixture(REF, 'rich.backup.json'), { replace: true }).ok, true);
  const six = s.addSong(null, { name: 'Six-slot song (2.0)' });
  s.addSlot(six, { instrument: { type: 'synth', id: 'warm-pad' } });
  s.addSlot(six, { instrument: { type: 'synth', id: 'glass-pad' } });
  assert.equal(s.getSong(six).patch.slots.length, 6);
  s.set('settings.programChangeAction', 'cue');
  s.set('settings.polyphony', 128);
  assert.equal(s.setChart(six, { format: 'plain', text: 'G  C  D\nla la la' }).ok, true);
  const out = { store: s, six, pretty: s.exportJSON(), compact: s.exportJSON({ pretty: false }), state: plain(s.get()) };
  return out;
}

test('1.1 refuses a 2.0 file (Settings › Import… and "Import latest backup") without throwing or changing anything', { skip }, () => {
  const v2 = library20();
  const s1 = S1.createStore(opts(S1));
  const before1 = plain(s1.get());
  for (const o of [{}, { replace: true }]) {
    for (const text of [v2.pretty, `{"origin":"rig://app",${v2.compact.slice(1)}`]) {
      const r = s1.importJSON(text, o);
      assert.deepEqual(r, { ok: false, error: 'This file was made by a newer version of Worship Rig.' });
    }
  }
  assert.deepEqual(plain(s1.get()), before1);
});

test('1.1 opening an origin whose localStorage holds a 2.0 library: future-schema, the 2.0 text kept, a fresh seed', { skip }, () => {
  const v2 = library20();
  const storage = S1.memoryStorage({ [S1.STORAGE_KEY]: v2.compact });
  const s1 = S1.createStore(opts(S1, { storage }));
  assert.equal(s1.loadInfo.status, 'future-schema');
  assert.ok(storage.getItem(s1.loadInfo.backupKey) === v2.compact, 'byte for byte, under rig.v1.backup-<ts>');
  assert.equal(s1.get().schema, 1);
  assert.ok(s1.get().songOrder.length > 0, 'factory seed');
});

test('2.0 Chrome first loads a 1.x library: a copy of the 1.x text stays for a downgrade', { skip }, () => {
  const text = fixture(REF, 'rich.localstorage.json');
  const storage = S2.memoryStorage({ [S2.STORAGE_KEY]: text });
  const s2 = S2.createStore(opts(S2, { storage, debounceMs: 0, now: () => 1000 }));
  const key = s2.loadInfo.migrationBackupKey;
  s2.set('song.tempo', 101);
  s2.dispose();
  // what 1.1 then sees on that origin: the schema-2 library is unreadable to it, the 1.x copy is still there
  const s1 = S1.createStore(opts(S1, { storage, now: () => 2000 })); // (a later launch: another backup key)
  assert.equal(s1.loadInfo.status, 'future-schema');
  assert.ok(storage.getItem(key) === text, 'the 1.x library, intact, for a manual restore');
  const restored = S1.createStore(opts(S1, { storage: S1.memoryStorage({ [S1.STORAGE_KEY]: storage.getItem(key) }) }));
  assert.equal(restored.loadInfo.status, 'ok');
  assert.deepEqual(plain(restored.get()), JSON.parse(text));
});

test('a 2.0 file with "schema" edited to 1: what 1.1 keeps and what it drops', { skip }, () => {
  const v2 = library20();
  const s1 = S1.createStore(opts(S1));
  const r = s1.importJSON(v2.pretty.replace('"schema": 2', '"schema": 1'), { replace: true });
  assert.equal(r.ok, true);
  const got = plain(s1.get());
  const drops = jsonDiff(v2.state, got).filter((d) => !d.startsWith('schema:')
    && !/^(app|kind|exportedAt):/.test(d)); // 1.1 keeps the envelope in its state (2.0 no longer does, E5)
  // slots 5 and 6 of the 6-slot song are cut (1.x has exactly 4); 2.0's device-local settings were never exported
  const six = v2.six;
  const songDrops = drops.filter((d) => !d.startsWith('settings.'));
  assert.deepEqual(songDrops.map((d) => d.split(':')[0]), [`songs.${six}.patch.slots.4`, `songs.${six}.patch.slots.5`]);
  assert.ok(songDrops.every((d) => / -> undefined$/.test(d)), songDrops.join('\n'));
  const DEVICE = new Set(S2.DEVICE_LOCAL_SETTINGS);
  const settingDrops = drops.filter((d) => d.startsWith('settings.')).map((d) => d.split(/[.:]/)[1]);
  assert.ok(settingDrops.every((k) => DEVICE.has(k)), `only device-local settings differ: ${settingDrops}`);
  // 2.0-only fields ride along as unknown fields (1.x ignores them): the chart, programChangeAction ('cue' → 1.x
  // jumps, its only behaviour); everything 1.x knows is unchanged
  const s = got.songs[six];
  assert.equal(s.chart.text, 'G  C  D\nla la la');
  assert.equal(got.settings.programChangeAction, 'cue');
  for (const id of v2.state.songOrder.filter((x) => x !== six)) assert.deepEqual(got.songs[id], v2.state.songs[id]);
});

test('the recorded in-app downgrade run (1.1 UI): no page errors, the library untouched, schema-2 refused', () => {
  const rep = JSON.parse(fs.readFileSync(path.join(FIX, REF, 'downgrade-v1.1.0.json'), 'utf8'));
  for (const [k, v] of Object.entries(rep.cases)) {
    assert.deepEqual(v.errors.filter((e) => e.startsWith('pageerror')), [], k);
  }
  assert.match(rep.cases.settingsImport.toast, /newer version/);
  assert.equal(rep.cases.settingsImport.libraryUnchanged, true);
  assert.equal(rep.cases.importLatestBackup.libraryUnchanged, true);
  assert.equal(rep.cases.localStorageSchema2.status, 'future-schema');
  assert.equal(rep.cases.localStorageSchema2.keptIsSchema2, true);
  assert.equal(rep.cases.schemaEditedTo1.sixSlotSongSlots, 4);
});
