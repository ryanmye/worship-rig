#!/usr/bin/env node
// Lane E5: generate real 1.x library exports for the 1.x → 2.0 migration tests (test/fixtures/library-1x/).
//
//   node tools/gen-library-1x-fixtures.mjs [--ref v1.1.0] [--ref v1.0.0] [--out test/fixtures/library-1x]
//                                          [--only rich,huge] [--headed]
//   node tools/gen-library-1x-fixtures.mjs --from <worktree> [--label v1.1.1] [--only rich]
//
// --from (D11): take the 1.x code from a worktree as it is on disk, uncommitted changes included (the unpublished
// 1.1.1 patch lives uncommitted on its branch), instead of `git archive <ref>`. The output folder is --label
// (default: v<package.json version of the worktree>), and the manifest records the worktree's HEAD and whether it was
// dirty (never its path).
//
// For each ref: `git archive <ref>` into a temp dir (no checkout), start THAT ref's server.js on a random port, open
// its web app in headless Chromium (Playwright) and build libraries through its real UI and store / controller APIs.
// Every library is written exactly as that 1.x build writes it:
//   <name>.backup.json        the text 1.x's controller.backupNow() hands to rig.backupNow (= the Electron rotation
//                             file rig-YYYYMMDD-HHMMSS.json, which main.js writes verbatim; tagged {"origin":...})
//   <name>.export.json        Settings › Export library (the real button; Playwright catches the download)
//   <name>.localstorage.json  the raw localStorage['rig.v1'] value (what a 2.0 build on the same origin loads)
// A library over 200 KB is written gzipped (<file>.json.gz). window.rig is the shape the native shell injects
// (RigLibrary.swift polyfill: isElectron:false, backupNow, latestBackup, onMenu), so backups are captured in the page.
// The v1.1.0 run also writes downgrade-v1.1.0.json: a 2.0 library (made by THIS checkout's store) offered to the 1.1
// app through Settings › Import…, "Import latest backup", and localStorage; what 1.1 does and whether it throws.
// No samples, no user data: every name and note is made up here.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const argv = process.argv.slice(2);
const many = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const fromDir = many('--from')[0] ? path.resolve(many('--from')[0]) : null;
const fromLabel = fromDir
  ? many('--label')[0] || `v${JSON.parse(fs.readFileSync(path.join(fromDir, 'package.json'), 'utf8')).version}`
  : null;
const refs = fromDir ? [fromLabel] : many('--ref').length ? many('--ref') : ['v1.1.0', 'v1.0.0'];
const out = path.resolve(repo, many('--out')[0] || 'test/fixtures/library-1x');
const only = new Set((many('--only')[0] || '').split(',').filter(Boolean));
const headed = argv.includes('--headed');
const MAX_PLAIN = 200 * 1024;

/** Scenarios per ref; v1.0.0 has no scenes / keyboards / hotkeys / click, so `rich` feature-detects. */
const PLAN = {
  'v1.1.0': ['rich', 'pristine', 'empty', 'unicode', 'deleted-factory', 'huge'],
  // D11: 1.1.1 adds the deviceSettings block to backups and exports; `devices` sets all 13 device-local settings
  'v1.1.1': ['rich', 'pristine', 'devices'],
  default: ['rich', 'pristine'],
};

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.status}`);
  return r.stdout;
}

function writeFixture(dir, file, text) {
  const big = Buffer.byteLength(text) > MAX_PLAIN;
  const name = big ? `${file}.gz` : file;
  // (ids and timestamps come from the 1.x app, so a re-run never gives the same bytes; the tests read by content)
  fs.writeFileSync(path.join(dir, name), big ? zlib.gzipSync(text, { level: 9 }) : text);
  return { file: name, chars: text.length, bytes: fs.statSync(path.join(dir, name)).size };
}

// ---------------------------------------------------------------------------------------------
// page-side scenario code (runs inside the 1.x app; only its own store / controller / UI)
const SCENARIOS = {
  /** Every 1.x feature the store knows, on factory and user songs. */
  async rich(page, ui) {
    const has = await page.evaluate(() => {
      const s = window.__rig.store;
      return { scenes: !!window.__rig.controller.scenes, keyboards: typeof s.setKeyboard === 'function',
        click: typeof s.setClick === 'function' };
    });
    const ids = await page.evaluate(() => {
      const s = window.__rig.store;
      const st = s.get();
      const order = st.songOrder.slice();
      const f = (i) => order[i];
      // a factory song edited (level, tempo, notes), others untouched
      const edited = f(0);
      s.set(`songs.${edited}.patch.slots.0.gain`, 1.1);
      s.set(`songs.${edited}.tempo`, 72);
      s.set(`songs.${edited}.notes`, 'Capo 2 on the acoustic.\nTag the bridge twice.');
      // two factory songs deleted (one of the 1.0 set, one of the since:2 additions at the end)
      const deleted = [order[3], order[order.length - 1]];
      deleted.forEach((id) => s.deleteSong(id));
      // a user song from blank, every slot field 1.x has
      const u = s.addSong(null, { name: 'Grace Overflows (Live)' });
      s.selectSongId(u);
      // the paths the Edit view writes (SPEC §4 grammar + song.* + slot aliases) on the current song
      const w = (p, v) => {
        if (!s.set(p, v)) throw new Error(`1.x refused ${p}=${JSON.stringify(v)}`);
      };
      const opt = (p, v) => s.set(p, v); // rows an older 1.x build may not have
      const extras = {};
      w('song.playIn', 5);
      w('song.hearIn', 3);
      w('song.transposeOctave', -1);
      w('song.minor', true);
      w('song.tempo', 68);
      w('song.notes', 'Intro: pad only, 4 bars.\nV1 → piano in.\n"Bridge" \\ build ×2');
      w('slots.0.gain', 0.9);
      w('slots.0.pan', -0.2);
      w('slots.0.octave', 1);
      w('slots.0.transpose', -2);
      w('slots.0.lowNote', 36);
      w('slots.0.highNote', 96);
      w('slots.0.sends.reverb', 0.42);
      w('slots.0.sends.delay', 0.2);
      w('slots.0.sends.chorus', 0.1);
      extras.velocityCurve = opt('slots.0.velocityCurve', 'soft');
      extras.bendEnabled = opt('slots.0.bendEnabled', false);
      extras.width = opt('slots.0.width', 0.6);
      extras.eqLow = opt('slots.0.eq.low', -2);
      extras.eqHigh = opt('slots.0.eq.high', 1.5);
      extras.eqB2 = opt('slots.0.eq.b2.on', true) && opt('slots.0.eq.b2.hz', 450)
        && opt('slots.0.eq.b2.db', 2.5) && opt('slots.0.eq.b2.q', 1.4);
      extras.eqB7 = opt('slots.0.eq.b7.on', true) && opt('slots.0.eq.b7.type', 'notch')
        && opt('slots.0.eq.b7.hz', 3100);
      extras.release = opt('slots.0.release', 1.8);
      extras.pedalHold = opt('slots.0.pedalHold', 6);
      extras.touch = opt('slots.0.touch.shape', 1.6) && opt('slots.0.touch.top', 110);
      extras.sustain = opt('slots.1.sustain', 'natural');
      w('slots.1.gain', 0.55);
      // slot 2: a My Samples instrument (user-samples reference; the pack itself is not here)
      // (a blank song's slots 2 and 3 are empty: 'slots.<i>' creates one, as Edit's "Add sound" does)
      w('slots.2', { instrument: { type: 'sampler', id: 'user:my-grand' } });
      w('slots.2.gain', 0.7);
      // slot 3: a mono bass, muted
      w('slots.3', { instrument: { type: 'synth', id: 'warm-pad' } });
      w('slots.3.instrument', { type: 'synth', id: 'sub-bass' });
      extras.mono = opt('slots.1.mono', 'highest');
      w('slots.3.highNote', 52);
      w('slots.3.muted', true);
      // song fx / master / drone / wheels
      w('fx.reverb.size', 0.8);
      w('fx.delay.sync', '1/8d');
      w('fx.delay.pingpong', true);
      w('master.volume', 0.9);
      extras.fxEq = opt('fx.eq.low', 2) && opt('fx.eq.mid', -1) && opt('fx.eq.high', 1);
      extras.fxComp = opt('fx.comp.amount', 0.4);
      extras.lofi = opt('fx.lofi.amount', 0.25);
      w('song.drone.mode', 'synth');
      w('drone.gain', 0.35);
      w('drone.brightness', 0.6);
      extras.chordFollow = opt('song.drone.chordFollow', true);
      extras.modWheel = opt('song.patch.modWheel.target', 'drone.gain');
      extras.timeSig = opt('song.timeSig', '6/8');
      // a duplicate, then a different instrument on it
      const dup = s.duplicateSong(u);
      s.set(`songs.${dup}.patch.slots.0.instrument`, { type: 'organ', id: 'gospel' });
      // a song made from a factory song (template)
      const tpl = s.addSong(st.songs[f(1)], { name: 'Way Maker (my keys)' });
      s.set(`songs.${tpl}.playIn`, 2);
      // unknown fields (a newer 1.x build / a hand edit): song, slot, setlist, settings, meta
      s.update((d) => {
        d.songs[u].ccli = '7654321';
        d.songs[u].patch.slots[0].futureKnob = { a: 1 };
        d.settings.performChips = 2;
        d.settings.someFutureSetting = { on: true, list: [1, 2] };
        d.meta.note = 'unknown meta field';
      });
      // setlists
      const sunday = s.addSetlist('Sunday AM', [u, edited, dup, tpl, f(2)]);
      const youth = s.addSetlist('Youth Night', [tpl, u, f(5)]);
      s.update((d) => {
        d.setlists[youth].color = 'teal'; // unknown setlist field
      });
      s.moveSong(sunday, 0, 2);
      s.setCurrentSetlist(sunday);
      s.selectSongId(u);
      // settings that are library content
      s.set('settings.latency', 'balanced');
      s.set('settings.velocitySens', 'hard');
      s.set('settings.computerKeyboard', false);
      s.set('settings.monoOutput', true);
      s.set('settings.menuBarSetlistId', youth);
      s.setMidiLearn('master.volume', { cc: 7, channel: 0 });
      s.setMidiLearn('nextSong', { note: 60, channel: null });
      s.setMidiLearn('slots.1.gain', { cc: 11, channel: 2 });
      s.setMidiLearn('swell', { cc: 4, channel: null });
      extras.sceneLearn = s.setMidiLearn('nextScene', { cc: 80, channel: 0 });
      // device-local settings (1.x never exports these: security S3 / Q7): set so the fixture shows they stay behind
      s.set('settings.midiInputId', 'input-0x1f2e');
      s.set('settings.midiInputName', 'Stage Piano MIDI Out');
      s.set('settings.outputDeviceId', 'dev-0xabc');
      s.set('settings.padFolder', { kind: 'fsa', name: 'Pads' });
      s.set('settings.menuBarMode', true);
      extras.audioSleep = s.set('settings.audioSleepSec', 120);
      extras.updateCheck = s.set('settings.updateCheck', false);
      extras.hotkeys = s.set('settings.hotkeys', { on: true, keys: { nextSong: 'Control+Alt+Command+]', panic: 'F13' } });
      extras.midiClockOut = s.set('settings.midiClockOut', 'IAC Driver Bus 1');
      extras.dynamicRange = s.set('settings.dynamicRange', 1.4);
      return { edited, deleted, u, dup, tpl, sunday, youth, extras };
    });
    if (has.keyboards) {
      await page.evaluate(() => {
        const s = window.__rig.store;
        s.setKeyboard('Stage Piano MIDI Out', { touch: { shape: 1.4, min: 0.05, max: 1, top: 118 }, remember: true });
        s.setKeyboard('Computer keyboard', { touch: { shape: 0.8, min: 0.2, max: 0.9, top: 127 } });
      });
    }
    if (has.click) await page.evaluate(() => window.__rig.store.setClick({ level: 0.5, countIn: 1, after: 'quiet', output: 'aux' }));
    // the real Settings UI: Program Change, pedal polarity and a theme are clicked, not set
    await ui.settings(async () => {
      await ui.toggleOn('programChange');
      await ui.toggleOn('pedalInvert');
      const theme = page.locator('.st-theme[data-theme-id="studio"]');
      if (await theme.count()) await theme.first().click();
    });
    if (has.scenes) {
      // scenes through the controller (what Perform's "Save scene" calls): the user song must be playing
      await ui.playing(ids.u);
      const ok = await page.evaluate(async (u) => {
        const s = window.__rig.store;
        const c = window.__rig.controller;
        s.set('slots.0.gain', 0.5);
        s.set('slots.1.gain', 0.9);
        const a = c.scenes.save(0);
        // scene 0 now plays: Perform's faders move the scene (scenes.adjust), then "Save scene" makes scene 2
        c.scenes.adjust('slots.0.gain', 1.0);
        c.scenes.adjust('drone.gain', 0.1);
        const b = c.scenes.save(1);
        return { a, b, n: (s.get().songs[u].scenes || []).length };
      }, ids.u);
      if (!ok.a || !ok.b || ok.n !== 2) throw new Error(`scenes not saved: ${JSON.stringify(ok)}`);
    }
    return { ...ids, has };
  },

  /**
   * D11: every 1.x device-local setting, an Electron pad folder (a made-up path outside any home folder) and one user
   * song (so a backup is written). Only 1.1.1 writes these into its files.
   */
  async devices(page) {
    return page.evaluate(() => {
      const s = window.__rig.store;
      const u = s.addSong(null, { name: 'Device test song' });
      s.selectSongId(u);
      const w = (p, v) => {
        if (!s.set(p, v)) throw new Error(`1.x refused ${p}=${JSON.stringify(v)}`);
      };
      w('settings.midiInputId', 'input-0x1f2e');
      w('settings.midiInputName', 'Stage Piano MIDI Out');
      w('settings.outputDeviceId', 'dev-0xabc');
      w('settings.padFolder', { kind: 'electron', path: '/Volumes/Rig/Pads' });
      w('settings.menuBarMode', true);
      w('settings.lowResource', true);
      w('settings.audioSleepSec', 300);
      w('settings.updateCheck', false);
      w('settings.hotkeys', { on: true, keys: { nextSong: 'Control+Alt+Command+]', panic: 'F13' } });
      w('settings.midiClockOut', 'IAC Driver Bus 1');
      w('settings.dynamicRange', 1.6);
      s.setKeyboard('Stage Piano MIDI Out', { touch: { shape: 1.4, min: 0.05, max: 1, top: 118 }, remember: true });
      s.setKeyboard('Computer keyboard', { touch: { shape: 0.8, min: 0.2, max: 0.9, top: 127 } });
      s.setClick({ level: 0.5, countIn: 1, after: 'quiet', output: 'aux' });
      s.set('settings.pedalInvert', true); // library content, for contrast
      return { u, install: typeof s.installId === 'function' ? s.installId() : null };
    });
  },

  /** An untouched factory seed: 1.x writes no backup of it (round2-shell #2), only an export exists. */
  async pristine(page) {
    return page.evaluate(() => ({ pristine: window.__rig.store.pristine }));
  },

  /** Every song and setlist deleted. */
  async empty(page) {
    return page.evaluate(() => {
      const s = window.__rig.store;
      for (const id of s.get().songOrder.slice()) s.deleteSong(id);
      for (const id of s.get().setlistOrder.slice()) s.deleteSetlist(id);
      return { songs: s.get().songOrder.length, setlists: s.get().setlistOrder.length };
    });
  },

  /** Names and notes outside ASCII: astral emoji, ZWJ, RTL, combining marks, CJK, quotes, U+2028. */
  async unicode(page) {
    return page.evaluate(() => {
      const s = window.__rig.store;
      const names = [
        '恩典之路 Grace Road',
        'Señor, ten piedad — Kyrie',
        'שִׁיר חָדָשׁ (New Song)',
        '👨‍👩‍👧 Family 🎹🎸 Worship',
        'Ẓ̌a̧l̈g̃o̊ "quotes" \\ back\\slash',
        'Песнь хвалы',
      ];
      const ids = names.map((n, i) => {
        const id = s.addSong(null, { name: n });
        s.set(`songs.${id}.notes`, `${n}\nline separator\ttab ${'🎶'.repeat(i + 1)}`);
        return id;
      });
      const sl = s.addSetlist('主日 Sunday ☀️', ids.slice().reverse());
      s.addSetlist('Ünïcödé Ⅱ', [ids[1], ids[3]]);
      s.setCurrentSetlist(sl);
      if (typeof s.setKeyboard === 'function') s.setKeyboard('Ro­land FP-30X ☃', { remember: true });
      return { ids };
    });
  },

  /** Factory songs deleted (incl. the current one and since:2 ones), the library reordered, one reset to factory. */
  async 'deleted-factory'(page) {
    return page.evaluate(() => {
      const s = window.__rig.store;
      const st = s.get();
      const order = st.songOrder.slice();
      const kill = [order[0], order[2], order[7], order[order.length - 1], order[order.length - 3]];
      const killedFactoryIds = kill.map((id) => st.songs[id].factoryId);
      s.selectSongId(order[0]);
      kill.forEach((id) => s.deleteSong(id));
      s.set('songOrder', s.get().songOrder.slice().reverse());
      const ed = s.get().songOrder[0];
      s.set(`songs.${ed}.patch.slots.0.gain`, 0.3);
      s.resetToFactory(ed);
      s.set(`songs.${s.get().songOrder[1]}.name`, 'Renamed factory song');
      return { killedFactoryIds };
    });
  },

  /** Near the 2 M-character library cap (security S2): ~190 songs with long notes. */
  async huge(page) {
    return page.evaluate(() => {
      const s = window.__rig.store;
      const base = s.get().songs[s.get().songOrder[1]];
      const para = (i) => `Song ${i}: verse, pre-chorus, chorus; turnaround on the 4. Pad swells under the bridge, `
        + `piano drops out for the last chorus, then a tag. Key change up a step at the end of chorus ${i % 7}. `;
      const target = 1940000;
      let i = 0;
      const sl = s.addSetlist('Archive', []);
      while (s.exportJSON({ pretty: false }).length < target - 12000 && i < 400) {
        const id = s.addSong(base, { name: `Archive song ${String(i + 1).padStart(3, '0')}`, setlistId: i < 60 ? sl : null });
        s.set(`songs.${id}.notes`, para(i).repeat(Math.ceil(9000 / para(i).length)).slice(0, 9000));
        s.set(`songs.${id}.tempo`, 60 + (i % 80));
        i++;
      }
      // fill up to the target with one shorter note
      const left = target - s.exportJSON({ pretty: false }).length;
      if (left > 2000) {
        const id = s.addSong(base, { name: 'Last archive song', setlistId: null });
        s.set(`songs.${id}.notes`, para(999).repeat(80).slice(0, Math.max(0, left - 2500)));
      }
      return { added: i, chars: s.exportJSON({ pretty: false }).length };
    });
  },
};

// ---------------------------------------------------------------------------------------------
async function runRef(ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rig-${ref}-`));
  let commit;
  let source;
  if (fromDir) {
    // D11: the worktree as it is on disk (its uncommitted patch included); only the files a ref would give
    commit = sh('git', ['-C', fromDir, 'rev-parse', 'HEAD']).trim();
    const dirty = sh('git', ['-C', fromDir, 'status', '--porcelain', '--', 'app', 'server.js', 'package.json']).trim();
    source = { kind: 'worktree', head: commit, uncommitted: dirty ? dirty.split('\n').map((l) => l.trim()) : [] };
    sh('bash', ['-c', `tar -C "${fromDir}" -c app server.js package.json docs | tar -x -C "${tmp}"`]);
  } else {
    commit = sh('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`]).trim();
    source = { kind: 'git archive', ref };
    sh('bash', ['-c', `git -C "${repo}" archive "${ref}" app server.js package.json docs | tar -x -C "${tmp}"`]);
  }
  const require = createRequire(import.meta.url);
  const { createServer } = require(path.join(tmp, 'server.js'));
  const server = createServer({ appDir: path.join(tmp, 'app'), port: 0, reuse: false, docsDir: path.join(tmp, 'docs') });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  const dir = path.join(out, ref);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { ref, commit, source, generator: 'tools/gen-library-1x-fixtures.mjs', origin, scenarios: {} };
  const scenarios = (PLAN[ref] || PLAN.default).filter((n) => !only.size || only.has(n));
  try {
    for (const name of scenarios) {
      const t0 = Date.now();
      const r = await runScenario(browser, origin, name);
      const files = {};
      if (r.backup !== null) files.backup = writeFixture(dir, `${name}.backup.json`, r.backup);
      files.export = writeFixture(dir, `${name}.export.json`, r.exported);
      files.localstorage = writeFixture(dir, `${name}.localstorage.json`, r.local);
      const lib = JSON.parse(r.local);
      manifest.scenarios[name] = {
        files, songs: lib.songOrder.length, setlists: lib.setlistOrder.length, pristine: r.pristine,
        backupWritten: r.backup !== null, consoleErrors: r.errors, detail: r.detail,
      };
      console.log(`  ${ref} ${name}: ${lib.songOrder.length} songs, ${lib.setlistOrder.length} setlists, `
        + `${Object.values(files).map((f) => `${f.file} ${f.bytes} B`).join(', ')} (${Date.now() - t0} ms)`);
    }
    if (ref === 'v1.1.0' && (!only.size || only.has('downgrade'))) {
      const report = await downgrade(browser, origin, dir);
      fs.writeFileSync(path.join(dir, 'downgrade-v1.1.0.json'), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`  ${ref} downgrade: ${JSON.stringify(report.summary)}`);
    }
  } finally {
    await browser.close();
    await server.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const mf = path.join(dir, 'manifest.json');
  const prev = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
  if (prev && only.size) manifest.scenarios = { ...prev.scenarios, ...manifest.scenarios };
  fs.writeFileSync(mf, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** window.rig as the native shell injects it (RigLibrary.swift), recording every backup; latestBackup is settable. */
const RIG_STUB = () => {
  const menu = [];
  window.__gen = { backups: [], latest: null };
  window.__rigShell = { menu: (id) => menu.slice().forEach((cb) => cb(id)), menuReady: () => menu.length > 0 };
  window.rig = {
    isElectron: false,
    platform: 'darwin',
    backupNow: async (json, kind) => {
      window.__gen.backups.push({ json: typeof json === 'string' ? json : JSON.stringify(json), kind: kind || 'library' });
      return { path: `/backups/rig-${window.__gen.backups.length}.json` };
    },
    latestBackup: async () => window.__gen.latest || { error: 'no backup found' },
    onMenu: (cb) => {
      menu.push(cb);
      return () => menu.splice(menu.indexOf(cb), 1);
    },
  };
};

async function openApp(browser, origin, { init } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(['midi'], { origin });
  await context.addInitScript(RIG_STUB);
  if (init) await context.addInitScript(init.fn, init.arg);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => !!(window.__rig && window.__rig.ready), null, { timeout: 60000 });
  await page.evaluate(() => window.__rig.ready);
  const ui = {
    async settings(fn) {
      await page.click('#btn-settings');
      await page.waitForSelector('#view-settings.open', { timeout: 15000 });
      await fn();
      await page.locator('#view-settings .st-close').first().click();
      await page.waitForFunction(() => !document.querySelector('#view-settings.open'), null, { timeout: 10000 });
    },
    async toggleOn(key) {
      const b = page.locator(`[data-bind="settings.${key}"]`).first();
      if (!(await b.count())) throw new Error(`no Settings toggle for ${key}`);
      await b.scrollIntoViewIfNeeded();
      const on = async () => (await b.getAttribute('aria-pressed')) === 'true' || (await b.getAttribute('aria-checked')) === 'true';
      if (!(await on())) await b.click();
      if (!(await on()) || !(await page.evaluate((k) => window.__rig.store.get().settings[k], key))) {
        throw new Error(`Settings toggle ${key} did not turn on`);
      }
    },
    async playing(id) {
      const overlay = await page.$('#overlay-start:not([hidden])');
      if (overlay) await overlay.click();
      await page.evaluate((i) => window.__rig.store.selectSongId(i), id);
      await page.waitForFunction((i) => {
        const st = window.__rig.controller.status;
        return st.songId === i && !st.loading;
      }, id, { timeout: 90000, polling: 100 });
    },
    async exportViaSettings() {
      let text = null;
      await ui.settings(async () => {
        const btn = page.locator('.st-export').first();
        await btn.scrollIntoViewIfNeeded();
        // D11 skeptic DS4: 1.1.1 writes the device block into an export only with this toggle on (the move to 2.0
        // on another computer); the fixtures are that file. 1.1.0 / 1.0.0 have no such toggle.
        const dev = page.getByTestId('export-device');
        if (await dev.count()) {
          const on = async (a) => (await dev.getAttribute(a)) === 'true';
          if (!(await on('aria-pressed')) && !(await on('aria-checked'))) await dev.click();
        }
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), btn.click()]);
        text = fs.readFileSync(await dl.path(), 'utf8');
      });
      return text;
    },
  };
  return { context, page, errors, ui };
}

async function runScenario(browser, origin, name) {
  const { context, page, errors, ui } = await openApp(browser, origin);
  try {
    const detail = await SCENARIOS[name](page, ui);
    // wait for the debounced save: localStorage holds exactly the store's state
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('rig.v1');
      return raw && JSON.stringify(JSON.parse(raw)) === JSON.stringify(window.__rig.store.get());
    }, null, { timeout: 15000, polling: 100 });
    const backup = await page.evaluate(async () => {
      const before = window.__gen.backups.length;
      await window.__rig.controller.backupNow();
      return window.__gen.backups.length > before ? window.__gen.backups.at(-1).json : null;
    });
    const exported = await ui.exportViaSettings();
    const local = await page.evaluate(() => localStorage.getItem('rig.v1'));
    const pristine = await page.evaluate(() => window.__rig.store.pristine);
    return { backup, exported, local, pristine, detail, errors: errors.slice() };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------
// downgrade: a 2.0 library offered to 1.1
async function downgrade(browser, origin, dir) {
  const store2 = await import(path.join(repo, 'app/js/store.js'));
  const richBackup = fs.readFileSync(path.join(dir, 'rich.backup.json'), 'utf8');
  const s2 = store2.createStore({ storage: store2.memoryStorage(), autoFlush: false, warn: () => {} });
  const r = s2.importJSON(richBackup, { replace: true });
  if (!r.ok) throw new Error(`2.0 could not import the 1.1 rich backup: ${r.error}`);
  // 2.0-only content: a 6-slot song, Program Change → cue, a chart
  const six = s2.addSong(null, { name: 'Six-slot song (2.0)' });
  s2.selectSongId(six);
  s2.addSlot(six);
  s2.addSlot(six);
  s2.set('settings.programChangeAction', 'cue');
  const chart = s2.setChart(six, { format: 'plain', text: 'G  C  D\nla la la', name: 'test chart' });
  if (!chart.ok || s2.getSong(six).patch.slots.length !== 6) throw new Error('2.0 library setup failed');
  const v2 = s2.exportJSON({ pretty: true });
  const v2Compact = s2.exportJSON({ pretty: false });
  s2.dispose();
  const report = { from: 'this checkout (schema 2): the 1.1 rich backup imported (replace), plus a 6-slot song, '
    + 'programChangeAction "cue" and a chart', cases: {} };

  // (a) Settings › Import… (merge) with the 2.0 file
  {
    const { context, page, errors } = await openApp(browser, origin);
    const before = await page.evaluate(() => JSON.stringify(window.__rig.store.get()));
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings.open');
    const tmpFile = path.join(os.tmpdir(), 'rig-2.0-library.json');
    fs.writeFileSync(tmpFile, v2);
    await page.setInputFiles('input[type=file][aria-label="Import library file"]', tmpFile);
    const toast = await page.waitForFunction(() => {
      const t = [...document.querySelectorAll('#toasts > *')].map((e) => e.textContent.trim());
      return t.find((x) => /Imported|newer|could not|not a Worship/i.test(x)) || null;
    }, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    const after = await page.evaluate(() => JSON.stringify(window.__rig.store.get()));
    report.cases.settingsImport = { toast, libraryUnchanged: before === after, errors: errors.slice() };
    fs.rmSync(tmpFile);
    await context.close();
  }
  // (b) "Import latest backup" (replace) with a 2.0 backup as the newest file
  {
    const { context, page, errors } = await openApp(browser, origin);
    const before = await page.evaluate(() => JSON.stringify(window.__rig.store.get()));
    const res = await page.evaluate(async (text) => {
      window.__gen.latest = { path: '/backups/rig-20261125-120000.json', origin: 'rig://app', savedAt: Date.now(), text };
      return window.__rig.controller.importLatestBackup();
    }, `{"origin":"rig://app",${v2Compact.slice(1)}`);
    const after = await page.evaluate(() => JSON.stringify(window.__rig.store.get()));
    report.cases.importLatestBackup = { result: res, libraryUnchanged: before === after, errors: errors.slice() };
    await context.close();
  }
  // (c) a schema-2 library already in localStorage (same origin): 1.1 boots, keeps a copy, starts fresh
  {
    const { context, page, errors } = await openApp(browser, origin, {
      init: { fn: (t) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('rig.v1', t); sessionStorage.setItem('seeded', '1'); } }, arg: v2Compact },
    });
    const st = await page.evaluate(() => {
      const s = window.__rig.store;
      const li = s.loadInfo;
      const kept = li.backupKey ? localStorage.getItem(li.backupKey) : null;
      return { status: li.status, backupKey: li.backupKey ? 'rig.v1.backup-<ts>' : null, songs: s.get().songOrder.length,
        keptCopyBytes: kept ? kept.length : 0, keptIsSchema2: kept ? JSON.parse(kept).schema === 2 : false };
    });
    report.cases.localStorageSchema2 = { ...st, errors: errors.slice() };
    await context.close();
  }
  // (d) the same 2.0 file with "schema": 2 → 1 by hand: what the 1.1 store keeps and drops
  {
    const { context, page, errors } = await openApp(browser, origin);
    const res = await page.evaluate((text) => {
      const s = window.__rig.store;
      const r = s.importJSON(text, { replace: true });
      const st = s.get();
      const six = Object.values(st.songs).find((x) => x.name === 'Six-slot song (2.0)');
      return { ok: r.ok, error: r.error || null, sixSlotSongSlots: six ? six.patch.slots.length : null,
        chartKept: six ? 'chart' in six : null, programChangeAction: st.settings.programChangeAction ?? null };
    }, v2.replace('"schema": 2', '"schema": 1'));
    report.cases.schemaEditedTo1 = { ...res, errors: errors.slice() };
    await context.close();
  }
  report.summary = Object.fromEntries(Object.entries(report.cases).map(([k, v]) => [k, {
    crashed: v.errors.some((e) => e.startsWith('pageerror')), changed: v.libraryUnchanged === false,
  }]));
  return report;
}

for (const ref of refs) {
  console.log(`== ${ref}`);
  await runRef(ref);
}
console.log(`fixtures in ${path.relative(repo, out)}`);
