// UI v6 U3: the right sidebar (app/js/views/v6/sidebar/; native/docs/lanes/UI6-build-plan.md U3; mockup
// native/docs/design/mockups/perform-v6.html "Sidebar …" tabs). Run from run.mjs on its page (the v6 Perform is on):
// tabs, the rail, resize clamps + fold (pointer and keys), customize (hide / reorder / Starts), per-device persistence
// across a reload (localStorage, never the library), the Drone module's writes (the same store paths as today's Key &
// drone card), Lock, the Setlist module (+ Add song), Notes, iPad portrait in its own context, screenshots.
import path from 'node:path';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

const KEY = 'worship-rig.v6.sidebar';

/**
 * @param {object} x  run.mjs's helpers: {T, page, browser, origin, ev, until, tid, song, settled, hold, setSlots,
 *   SHOTS, assert}
 */
export async function sidebarTests(x) {
  const { T, page, browser, origin, ev, until, tid, song, settled, hold, setSlots, SHOTS, assert } = x;
  const prefs = () => ev(() => window.__rig.views.v6.sidebar.prefs);
  const mounted = () => ev(() => window.__rig.views.v6.sidebar.mounted);
  const isRail = () => ev(() => document.querySelector('.v6-side').classList.contains('rail'));
  const tabIds = () => ev(() => [...document.querySelectorAll('.v6-sb-tab')].map((b) => b.dataset.id));
  const sideW = () => ev(() => document.querySelector('.v6-side').getBoundingClientRect().width);
  const boardW = () => ev(() => document.querySelector('.v6-board').clientWidth);
  const clearToasts = () => ev(() => document.getElementById('toasts')?.replaceChildren());
  /** Forget this device's sidebar layout and remount the v6 Perform (it reads the layout when it mounts). */
  async function resetSidebar() {
    await ev(async () => {
      localStorage.removeItem('worship-rig.v6.sidebar');
      await window.__rig.setUiV6(false);
      await window.__rig.setUiV6(true);
    });
    await until(() => !!document.querySelector('[data-testid="v6-perform"] .v6-side'));
  }
  const rect = (sel) => ev((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2,
      cy: r.top + r.height / 2 };
  }, sel);
  /** Drag the grip by dx px (negative = wider); mid() runs while the button is still down. */
  async function dragGrip(dx, mid) {
    const g = await rect(tid('v6-sb-grip'));
    await page.mouse.move(g.cx, g.cy);
    await page.mouse.down();
    await page.mouse.move(g.cx + dx, g.cy, { steps: 8 });
    if (mid) await mid();
    await page.mouse.up();
  }
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
  let keyBefore = null; // the song's key and drone before the Drone / Lock tests, put back after them

  await T('U3 sidebar: one module at a time as tabs; the song bar’s Notes / Setlist open it there', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await resetSidebar();
    const r = await ev(() => ({
      tabs: [...document.querySelectorAll('.v6-sb-tab')].map((b) => [b.dataset.id, b.getAttribute('aria-selected')]),
      drone: !!document.querySelector('[data-testid="v6-sb-body"] [data-testid="v6-drone"]'),
      placeholder: !!document.querySelector('.v6-right.v6-slot-ph'),
      body: document.querySelector('[data-testid="v6-sb-body"]').childElementCount,
    }));
    assert.deepEqual(r, {
      tabs: [['drone', 'true'], ['setlist', 'false'], ['notes', 'false']], drone: true, placeholder: false, body: 1,
    });
    for (const id of ['setlist', 'notes', 'drone']) {
      await page.click(tid(`v6-sb-tab-${id}`));
      assert.equal(await mounted(), id);
      assert.equal(await ev(() => document.querySelector('[data-testid="v6-sb-body"]').childElementCount), 1);
    }
    // ← / → on the tablist (and they never reach the controller)
    await page.focus(tid('v6-sb-tab-drone'));
    await page.keyboard.press('ArrowRight');
    assert.equal(await mounted(), 'setlist');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await mounted(), 'drone');
    // the song bar's buttons
    await page.click(tid('v6-notes'));
    assert.equal(await mounted(), 'notes');
    await page.click(tid('v6-setlist'));
    assert.equal(await mounted(), 'setlist');
    assert.deepEqual(await ev(() => ['v6-notes', 'v6-setlist'].map((t) => document
      .querySelector(`[data-testid="${t}"]`).getAttribute('aria-pressed'))), ['false', 'true']);
    assert.equal((await prefs()).tab, 'setlist');
  });

  await T('U3 sidebar: ⟩ folds it to the icon rail (drone dot + key); ⟨ / an icon opens it there', async () => {
    const id = (await song()).id;
    await ev((sid) => window.__rig.store.set(`songs.${sid}.drone.mode`, 'synth'), id);
    const before = await ev(() => document.querySelector('.v6-stripsarea').getBoundingClientRect().width);
    await page.click(tid('v6-sb-collapse'));
    assert.equal(await isRail(), true);
    assert.equal(await mounted(), null, 'nothing is mounted while folded');
    const r = await ev(() => ({
      rail: [...document.querySelectorAll('.v6-rb[data-id]')].map((b) => b.dataset.id),
      live: document.querySelector('[data-testid="v6-rb-drone"]').classList.contains('live'),
      key: document.querySelector('[data-testid="v6-rb-drone"] .v6-rb-k').textContent,
      w: document.querySelector('.v6-side').getBoundingClientRect().width,
      strips: document.querySelector('.v6-stripsarea').getBoundingClientRect().width,
    }));
    const s = await song();
    const keyName = await ev((sg) => document.querySelector('.v6-key-t').textContent, s);
    assert.deepEqual({ ...r, strips: r.strips > before }, {
      rail: ['drone', 'setlist', 'notes'], live: true, key: keyName, w: 64, strips: true,
    });
    // the drone off: no dot, no key
    await ev((sid) => window.__rig.store.set(`songs.${sid}.drone.mode`, 'off'), id);
    await until(() => !document.querySelector('[data-testid="v6-rb-drone"]').classList.contains('live'));
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-rb-drone"] .v6-rb-k').hidden), true);
    await ev((sid) => window.__rig.store.set(`songs.${sid}.drone.mode`, 'synth'), id);
    // an icon opens on its module; ⟨ opens on the last one
    await page.click(tid('v6-rb-notes'));
    assert.deepEqual([await isRail(), await mounted()], [false, 'notes']);
    await page.click(tid('v6-sb-collapse'));
    await page.click(tid('v6-sb-open'));
    assert.deepEqual([await isRail(), await mounted()], [false, 'notes']);
    // the tab's live dot follows the drone too
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-sb-tab-drone"] .v6-live').hidden), false);
  });

  await T('U3 sidebar: drag the left edge (200 px … 62 % of the board), a drag below 200 folds; ←/→ too', async () => {
    await setSlots(5);
    await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 5);
    await page.click(tid('v6-sb-tab-drone'));
    const w0 = await sideW();
    assert.ok(near(w0, 280), `default 280 px at 1280 (${w0})`);
    await dragGrip(-120);
    assert.ok(near(await sideW(), w0 + 120), `${await sideW()}`);
    assert.ok(near((await prefs()).width, w0 + 120, 1), 'saved on release');
    // as wide as it goes: 62 % of the board; strips keep ≥ 150 px and the row scrolls with its pills
    await dragGrip(-1500);
    const bw = await boardW();
    assert.ok(near(await sideW(), Math.floor(bw * 0.62)), `${await sideW()} vs ${bw * 0.62}`);
    await page.waitForTimeout(150);
    const st = await ev(() => ({
      min: Math.min(...[...document.querySelectorAll('.v6-strip:not([hidden])')].map((s) => s.offsetWidth)),
      overflow: document.querySelector('.v6-stripsarea').classList.contains('overflow'),
      pills: !document.querySelector('[data-testid="v6-pills"]').hidden,
      scrolls: (() => {
        const r = document.querySelector('[data-testid="v6-strips"]');
        return r.scrollWidth > r.clientWidth;
      })(),
    }));
    assert.deepEqual({ ...st, min: st.min >= 149.5 }, { min: true, overflow: true, pills: true, scrolls: true },
      `narrowest strip ${st.min}`);
    // narrow: stops at 200 while dragging; past it the sidebar dims (will fold) and folds on release
    await dragGrip(2000, async () => {
      assert.ok(near(await sideW(), 200), `${await sideW()}`);
      assert.equal(await ev(() => document.querySelector('.v6-side').classList.contains('will-fold')), true);
    });
    assert.equal(await isRail(), true);
    assert.ok(near((await prefs()).width, Math.floor(bw * 0.62), 1), 'the width before the fold is kept');
    await page.click(tid('v6-sb-open'));
    assert.ok(near(await sideW(), Math.floor(bw * 0.62)), 'and comes back with ⟨');
    // keys on the focused grip: Home = 200, ← wider 16 (Shift 64), → narrower; → at 200 folds
    await page.focus(tid('v6-sb-grip'));
    await page.keyboard.press('Home');
    assert.ok(near(await sideW(), 200));
    await page.keyboard.press('ArrowLeft');
    assert.ok(near(await sideW(), 216));
    await page.keyboard.press('Shift+ArrowLeft');
    assert.ok(near(await sideW(), 280));
    assert.equal(await page.getAttribute(tid('v6-sb-grip'), 'aria-valuenow'), '280');
    await page.keyboard.press('ArrowRight');
    assert.ok(near(await sideW(), 264));
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    assert.equal(await isRail(), true);
    assert.equal(await ev(() => document.activeElement?.dataset.testid), 'v6-sb-open');
    await page.click(tid('v6-sb-open'));
    assert.ok(near(await sideW(), 200));
    // a narrow sidebar still gives every tab a 44 px target (the header wraps)
    const small = await ev(() => [...document.querySelectorAll('.v6-side button')].filter((b) => b.offsetParent)
      .map((b) => [b.dataset.testid || b.textContent.trim(), b.getBoundingClientRect()])
      .filter(([, r]) => r.width < 43.5 || r.height < 43.5).map(([n, r]) => `${n} ${r.width}x${r.height}`));
    assert.deepEqual(small, []);
    await page.keyboard.press('End');
    await page.focus(tid('v6-sb-grip'));
    await page.keyboard.press('Home');
    for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowLeft'); // 280
    assert.ok(near(await sideW(), 280));
  });

  await T('U3 sidebar: ⋯ customize hides / shows, reorders (↑ ↓ and drag), Starts; the last module stays', async () => {
    await page.click(tid('v6-sb-tab-notes'));
    await page.click(tid('v6-sb-customize'));
    await until(() => !!document.querySelector('[data-testid="v6-sb-cz"]'));
    const rows = () => ev(() => [...document.querySelectorAll('.v6-cz')].map((r) => r.dataset.id));
    assert.deepEqual(await rows(), ['drone', 'setlist', 'notes']);
    // hide Notes (the shown tab): its tab and rail icon go, the sidebar shows the first module
    await page.click(tid('v6-cz-show-notes'));
    assert.deepEqual(await tabIds(), ['drone', 'setlist']);
    assert.equal(await mounted(), 'drone');
    await page.click(tid('v6-cz-show-setlist'));
    assert.deepEqual(await tabIds(), ['drone']);
    assert.equal(await page.isDisabled(tid('v6-cz-show-drone')), true, 'the last shown module stays');
    await page.click(tid('v6-cz-show-setlist'));
    await page.click(tid('v6-cz-show-notes'));
    assert.deepEqual(await tabIds(), ['drone', 'setlist', 'notes']);
    // ↓ / ↑
    await page.click(tid('v6-cz-dn-drone'));
    assert.deepEqual(await rows(), ['setlist', 'drone', 'notes']);
    assert.deepEqual(await tabIds(), ['setlist', 'drone', 'notes']);
    assert.equal(await page.isDisabled(tid('v6-cz-up-setlist')), true);
    await page.click(tid('v6-cz-up-drone'));
    assert.deepEqual(await tabIds(), ['drone', 'setlist', 'notes']);
    // drag Notes' ⠿ above Drone
    const g = await rect(`${tid('v6-cz-notes')} .v6-cz-grip`);
    const top = await rect(tid('v6-cz-drone'));
    await page.mouse.move(g.cx, g.cy);
    await page.mouse.down();
    await page.mouse.move(g.cx, top.t + 4, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await rows(), ['notes', 'drone', 'setlist']);
    assert.deepEqual(await tabIds(), ['notes', 'drone', 'setlist']);
    assert.deepEqual((await prefs()).order, ['notes', 'drone', 'setlist']);
    // Starts
    await page.click(tid('v6-sb-starts-collapsed'));
    assert.equal((await prefs()).starts, 'collapsed');
    assert.equal(await page.getAttribute(tid('v6-sb-starts-collapsed'), 'aria-pressed'), 'true');
    // Esc closes it and does not panic
    await ev(() => {
      window.__u3panics = 0;
      window.__rig.controller.addEventListener('action', (e) => {
        if (e.detail?.type === 'panic') window.__u3panics += 1;
      });
    });
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-sb-cz"]'));
    assert.equal(await ev(() => window.__u3panics), 0);
  });

  await T('U3 sidebar: the layout is per device (localStorage), kept across a reload; Starts applies at start',
    async () => {
      await page.click(tid('v6-sb-tab-setlist'));
      await page.click(tid('v6-sb-customize'));
      await page.click(tid('v6-cz-show-notes'));
      await page.keyboard.press('Escape');
      const saved = await ev((k) => JSON.parse(localStorage.getItem(k)), KEY);
      assert.deepEqual(saved, {
        open: true, starts: 'collapsed', width: 280, tab: 'setlist', order: ['notes', 'drone', 'setlist'],
        hidden: ['notes'],
      });
      // never in the library or its export
      const lib = await ev(() => window.__rig.store.exportJSON());
      assert.ok(!/v6\.sidebar|"starts"|"hidden":\["notes"\]/.test(lib), 'not in the library export');
      assert.ok(!Object.keys(await ev(() => window.__rig.store.get().settings)).some((k) => /sidebar/i.test(k)));
      await page.reload();
      await waitRigReady(page, { timeout: 40000 });
      await until(() => !!document.querySelector('[data-testid="v6-perform"] .v6-side'), null, 20000);
      await settled();
      // Starts: Collapsed → the app starts on the rail, the rest as left
      assert.equal(await isRail(), true);
      assert.deepEqual(await ev(() => [...document.querySelectorAll('.v6-rb[data-id]')].map((b) => b.dataset.id)),
        ['drone', 'setlist']);
      await page.click(tid('v6-sb-open'));
      assert.equal(await mounted(), 'setlist');
      assert.ok(near(await sideW(), 280));
      assert.deepEqual(await tabIds(), ['drone', 'setlist']);
      // Starts: Open
      await page.click(tid('v6-sb-customize'));
      await page.click(tid('v6-sb-starts-open'));
      await page.click(tid('v6-sb-collapse'));
      await page.reload();
      await waitRigReady(page, { timeout: 40000 });
      await until(() => !!document.querySelector('[data-testid="v6-perform"] .v6-side'), null, 20000);
      await settled();
      assert.equal(await isRail(), false);
      // a garbled value falls back to the defaults
      await ev((k) => localStorage.setItem(k, '{"order":["zzz"],"hidden":["drone","setlist","notes"],"width":5}'),
        KEY);
      await ev(async () => {
        await window.__rig.setUiV6(false);
        await window.__rig.setUiV6(true);
      });
      await until(() => !!document.querySelector('[data-testid="v6-perform"] .v6-side'));
      const p = await prefs();
      assert.deepEqual({ order: p.order, hidden: p.hidden, width: p.width, tab: p.tab },
        { order: ['drone', 'setlist', 'notes'], hidden: [], width: null, tab: 'drone' });
      await resetSidebar();
    });

  await T('U3 Drone: today’s controls, the same store writes as today’s Key & drone card', async () => {
    await ev(() => window.__rig.controller.scenes?.go(null));
    await page.click(tid('v6-sb-tab-drone'));
    const id = (await song()).id;
    const was = await song();
    keyBefore = { id, f: { hearIn: was.hearIn, playIn: was.playIn, minor: was.minor, drone: was.drone } };
    await ev((sid) => {
      const { store } = window.__rig;
      store.set(`songs.${sid}.drone.mode`, 'synth');
      store.set(`songs.${sid}.minor`, false);
      // a song transposed by +2 (Play-In D, Hear-In E): the key grid keeps the transpose
      store.set(`songs.${sid}.playIn`, 2);
      store.set(`songs.${sid}.hearIn`, 4);
      if (!store.__u3set) {
        const set = store.set;
        store.__u3set = set;
        store.set = function (p, v) {
          window.__u3sets?.push(p);
          return set.call(this, p, v);
        };
      }
      window.__u3sets = [];
    }, id);
    // this song's writes (the controller may write settings meanwhile)
    const sets = async () => (await ev(() => window.__u3sets.splice(0))).filter((p) => p.startsWith(`songs.${id}.`))
      .map((p) => p.slice(`songs.${id}.`.length));
    const input = (t, delta) => ev(({ t, delta }) => {
      const inp = document.querySelector(`[data-testid="${t}"] input`);
      inp.value = String(Math.max(0, Math.min(Number(inp.max), Number(inp.value) + delta)));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, { t, delta });
    const s0 = await song();
    await page.click(tid('v6-drone-on'));
    await until(() => window.__rig.store.currentSong().drone.mode === 'off');
    await page.click(tid('v6-drone-on'));
    await until(() => window.__rig.store.currentSong().drone.mode === 'synth');
    await page.click(`${tid('v6-drone-mode')} [data-value="files"]`);
    await until(() => window.__rig.store.currentSong().drone.mode === 'files');
    await page.click(`${tid('v6-drone-mode')} [data-value="synth"]`);
    await page.click(`${tid('v6-drone-keys')} .key-btn[data-pc="7"]`);
    await until(() => window.__rig.store.currentSong().hearIn === 7);
    assert.equal((await song()).playIn, 5, 'the transpose (+2) is kept');
    await page.click(`${tid('v6-drone-quality')} [data-value="true"]`);
    await until(() => window.__rig.store.currentSong().minor === true);
    await page.click(`${tid('v6-drone-quality')} [data-value="false"]`);
    await input('v6-drone-level', -120);
    await until((g) => window.__rig.store.currentSong().drone.gain !== g, s0.drone.gain);
    await input('v6-drone-bright', 150);
    await until((g) => window.__rig.store.currentSong().drone.brightness !== g, s0.drone.brightness);
    await input('v6-drone-move', 150);
    await until((g) => window.__rig.store.currentSong().drone.movement !== g, s0.drone.movement);
    await page.click(tid('v6-drone-keep'));
    await until((k) => window.__rig.store.currentSong().drone.continueAcrossSongs !== k, s0.drone.continueAcrossSongs);
    await page.click(tid('v6-drone-follow'));
    await until((k) => window.__rig.store.currentSong().drone.chordFollow !== k, s0.drone.chordFollow);
    const written = [...new Set(await sets())];
    // today's perform.js Key & drone writes: setDroneOn / droneMode → drone.mode; setSongKey → hearIn + playIn;
    // quality → minor; droneGain / brightness / movement; cont / follow
    assert.deepEqual(written, ['drone.mode', 'hearIn', 'playIn', 'minor', 'drone.gain', 'drone.brightness',
      'drone.movement', 'drone.continueAcrossSongs', 'drone.chordFollow']);
    assert.equal(await page.isDisabled(tid('v6-drone-sustain')), true, 'Sustain: coming');
    // Follow chords is the synth's only
    await ev((sid) => window.__rig.store.set(`songs.${sid}.drone.mode`, 'files'), id);
    await until(() => document.querySelector('[data-testid="v6-drone-follow"]').hidden);
    assert.equal(await page.isVisible(tid('v6-drone-pads')), true, 'the pad-folder line shows for My Pads');
    // a playing scene takes the level as a live move (perform.js sceneLevel), not a song write
    await ev((sid) => window.__rig.store.set(`songs.${sid}.drone.mode`, 'synth'), id);
    await ev(() => window.__rig.store.set = window.__rig.store.__u3set);
  });

  await T('U3 Lock: tile + Level live, keys / Major-Minor need a hold, the rest frozen; no + Add song', async () => {
    await hold(tid('v6-lock'));
    await until(() => window.__rig.store.get().settings.performLock === true);
    await page.click(tid('v6-sb-tab-drone'));
    const r = await ev(() => {
      const q = (t) => document.querySelector(`[data-testid="${t}"]`);
      return {
        tile: q('v6-drone-on').disabled,
        level: q('v6-drone-level').querySelector('input').disabled,
        mode: [...q('v6-drone-mode').querySelectorAll('button')].every((b) => b.disabled),
        bright: q('v6-drone-bright').querySelector('input').disabled,
        move: q('v6-drone-move').querySelector('input').disabled,
        keep: q('v6-drone-keep').disabled,
        keys: [...q('v6-drone-keys').querySelectorAll('button')].some((b) => b.disabled),
        line: getComputedStyle(document.querySelector('.v6-drone-lockline')).display !== 'none',
      };
    });
    assert.deepEqual(r, { tile: false, level: false, mode: true, bright: true, move: true, keep: true, keys: false,
      line: true });
    const k0 = (await song()).hearIn;
    const pc = (k0 + 2) % 12;
    await page.click(`${tid('v6-drone-keys')} .key-btn[data-pc="${pc}"]`);
    await page.waitForTimeout(200);
    assert.equal((await song()).hearIn, k0, 'a tap does not change the key while locked');
    await hold(`${tid('v6-drone-keys')} .key-btn[data-pc="${pc}"]`);
    await until((p) => window.__rig.store.currentSong().hearIn === p, pc);
    const m0 = (await song()).minor;
    await page.click(`${tid('v6-drone-quality')} [data-value="${!m0}"]`);
    await page.waitForTimeout(200);
    assert.equal((await song()).minor, m0);
    // the tile stays live
    await page.click(tid('v6-drone-on'));
    await until(() => window.__rig.store.currentSong().drone.mode === 'off');
    await page.click(tid('v6-drone-on'));
    await until(() => window.__rig.store.currentSong().drone.mode !== 'off');
    // setlist: cueing stays live, adding is frozen
    await page.click(tid('v6-sb-tab-setlist'));
    assert.equal(await page.isDisabled(tid('v6-sl-add')), true);
    const cur = await ev(() => window.__rig.store.currentIndex());
    await page.click(tid(`v6-sl-${cur + 1}`));
    await until(() => !!window.__rig.controller.status.cue);
    await ev(() => window.__rig.controller.clearCue());
    await hold(tid('v6-lock'));
    await until(() => !window.__rig.store.get().settings.performLock);
    assert.equal(await page.isDisabled(tid('v6-sl-add')), false);
    if (keyBefore) {
      await ev(({ id, f }) => {
        for (const [k, val] of Object.entries(f)) window.__rig.store.set(`songs.${id}.${k}`, val);
      }, keyBefore);
    }
  });

  await T('U3 Setlist: list now / cued, GO names the cue; + Add song: library, Song bank, New song', async () => {
    await page.click(tid('v6-sb-tab-setlist'));
    const cur = await ev(() => window.__rig.store.currentIndex());
    assert.match(await ev((i) => document.querySelector(`[data-testid="v6-sl-${i}"]`).className, cur), /\bnow\b/);
    await page.click(tid(`v6-sl-${cur + 1}`));
    await until((i) => /cued/.test(document.querySelector(`[data-testid="v6-sl-${i}"]`)?.className || ''), cur + 1);
    const nm = await ev((i) => window.__rig.store.getSong(window.__rig.store.navIds()[i]).name, cur + 1);
    await until((n) => document.querySelector('[data-testid="v6-go"]').textContent.includes(n)
      && /^GO/.test(document.querySelector('[data-testid="v6-go"] small').textContent), nm);
    await page.click(tid(`v6-sl-${cur + 1}`)); // a tap on the cued one clears it
    await until(() => !window.__rig.controller.status.cue);
    // From my library: a library song that is not in the set
    const sid0 = (await song()).id;
    const libId = await ev(() => window.__rig.store.addSong(null, { name: 'U3 Library Only', setlistId: null }));
    const n0 = await ev(() => window.__rig.store.currentSetlist().songIds.length);
    await page.click(tid('v6-sl-add'));
    await until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
    assert.equal(await page.isDisabled(tid('v6-add-bank')), true, 'no Song bank packs here');
    await page.click(tid('v6-add-library'));
    await page.click(tid(`v6-add-lib-${libId}`));
    await until((n) => window.__rig.store.currentSetlist().songIds.length === n + 1, n0);
    assert.equal(await ev(() => window.__rig.store.currentSetlist().songIds.at(-1)), libId);
    await until((id) => !document.querySelector(`[data-testid="v6-add-lib-${id}"]`), libId);
    await page.click(tid('v6-add-back'));
    // New song: at the end, not selected (the playing sound never changes from here)
    await page.click(tid('v6-add-new'));
    await until((n) => window.__rig.store.currentSetlist().songIds.length === n + 2, n0);
    const last = await ev(() => window.__rig.store.getSong(window.__rig.store.currentSetlist().songIds.at(-1)).name);
    assert.equal(last, 'New Song');
    assert.equal((await song()).id, sid0);
    assert.equal(await ev(() => !!document.querySelector('[data-testid="v6-addsong"]')), false);
    await until((n) => !!document.querySelector(`[data-testid="v6-sl-${n + 1}"]`), n0);
    // From the Song bank: Settings opens on the bank's section (today's list until U7)
    await ev(() => window.__rig.ctx.openSettings({ section: 'bank' }));
    await until(() => document.querySelector('details.st-bank')?.open === true);
    await ev(() => window.__rig.ctx.closeSettings());
    await clearToasts();
    // tidy: the two songs go again
    await ev(({ a }) => {
      const { store } = window.__rig;
      const ids = store.currentSetlist().songIds;
      store.deleteSong(ids.at(-1));
      store.deleteSong(a);
    }, { a: libId });
  });

  await T('U3 Notes: the song’s notes, read only; arrow keys scroll them and stay out of the controller',
    async () => {
      await page.click(tid('v6-sb-tab-notes'));
      const id = (await song()).id;
      const n0 = (await song()).notes || '';
      const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: verse, chorus, bridge.`).join('\n');
      await ev(({ id, long }) => window.__rig.store.set(`songs.${id}.notes`, long), { id, long });
      await until((t) => document.querySelector('[data-testid="v6-notes-text"]').textContent === t, long);
      assert.equal(await ev(() => document.querySelector('[data-testid="v6-notes-mod"]')
        .querySelectorAll('input, textarea, [contenteditable="true"]').length), 0, 'read only, as today');
      await page.focus(tid('v6-notes-text'));
      const prevented = await ev(() => {
        const el = document.querySelector('[data-testid="v6-notes-text"]');
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        return { prevented: e.defaultPrevented, top: el.scrollTop };
      });
      assert.deepEqual({ ...prevented, top: prevented.top > 0 }, { prevented: true, top: true });
      await ev(({ id }) => window.__rig.store.set(`songs.${id}.notes`, ''), { id });
      await until(() => document.querySelector('[data-testid="v6-notes-text"]').classList.contains('empty'));
      assert.equal(await page.isDisabled('.v6-notes-chart'), true, 'Chart: coming in 2.1');
      await ev(({ id, n0 }) => window.__rig.store.set(`songs.${id}.notes`, n0), { id, n0 });
    });

  await T('U3 skeptic F1: ⟩ / ⟨ / a rail icon pressed from the keyboard keep the focus in the sidebar', async () => {
    // a keyboard press on a button that hides itself moved the focus to the page
    await resetSidebar();
    const act = () => ev(() => (document.activeElement === document.body ? 'body'
      : document.activeElement?.dataset.testid || document.activeElement?.tagName));
    await page.focus(tid('v6-sb-collapse'));
    await page.keyboard.press('Enter');
    assert.equal(await isRail(), true);
    assert.equal(await act(), 'v6-sb-open', '⟩ (Enter) → ⟨');
    await page.keyboard.press('Enter');
    assert.equal(await isRail(), false);
    assert.equal(await act(), 'v6-sb-tab-drone', '⟨ (Enter) → the open tab');
    await page.focus(tid('v6-sb-collapse'));
    await page.keyboard.press('Space');
    await page.focus(tid('v6-rb-notes'));
    await page.keyboard.press('Enter');
    assert.deepEqual([await mounted(), await act()], ['notes', 'v6-sb-tab-notes'], 'a rail icon (Enter) → its tab');
    // a pointer click does not put the focus on ⟨ (Space stays the pedal on the page)
    await page.click(tid('v6-sb-collapse'));
    await page.waitForTimeout(100);
    assert.notEqual(await act(), 'v6-sb-open');
    await page.click(tid('v6-sb-open'));
  });

  await T('U3 screenshots: 1280×800 Sanctuary, sidebar open / collapsed / wide', async () => {
    await resetSidebar();
    await ev(() => {
      const { store, controller } = window.__rig;
      controller.scenes.go(null);
      store.resetToFactory(store.currentSong().id);
    });
    await setSlots(5);
    await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 5);
    const shoot = async (name) => {
      await clearToasts();
      await ev(() => document.activeElement?.blur?.());
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, name) });
    };
    await shoot('u3-open-1280.png');
    await page.click(tid('v6-sb-tab-setlist'));
    await shoot('u3-setlist-1280.png');
    await page.click(tid('v6-sb-customize'));
    await shoot('u3-customize-1280.png');
    await page.keyboard.press('Escape');
    await page.click(tid('v6-sb-collapse'));
    await shoot('u3-collapsed-1280.png');
    await page.click(tid('v6-rb-drone'));
    await dragGrip(-1500);
    await shoot('u3-wide-1280.png');
    await resetSidebar();
  });

  await T('U3 iPad portrait 820×1180: a wide panel under the strips, no grip; folds to a row', async () => {
    const c = await browser.newContext({ viewport: { width: 820, height: 1180 } });
    const errs = [];
    try {
      await pinTheme(c, 'sanctuary');
      await c.grantPermissions([...MIDI_PERMISSIONS], { origin });
      const p = await c.newPage();
      p.on('console', (m) => {
        if (m.type() === 'error') errs.push(m.text());
      });
      p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
      p.on('response', (r) => {
        if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`);
      });
      await p.goto(`${origin}/?ui6=1`);
      await waitRigReady(p, { timeout: 40000 });
      await p.waitForFunction(() => !!window.__rig.views.v6, null, { timeout: 20000 });
      await p.waitForTimeout(800);
      const r = await p.evaluate(() => {
        const q = (s) => document.querySelector(s).getBoundingClientRect();
        const side = q('.v6-side');
        const strips = q('.v6-stripsarea');
        const left = q('.v6-left');
        const board = document.querySelector('.v6-board');
        const bs = board.getBoundingClientRect();
        return {
          portrait: window.__rig.views.v6.sidebar.portrait,
          below: side.top >= strips.bottom - 0.5,
          spans: Math.abs(side.left - left.left) < 1 && Math.abs(side.right - bs.right) < 1,
          grip: !!document.querySelector('[data-testid="v6-sb-grip"]')?.offsetParent,
          inBoard: side.bottom <= bs.bottom + 0.5,
          wide: document.querySelector('.v6-side').classList.contains('wide'),
          droneGrid: getComputedStyle(document.querySelector('.v6-drone')).display,
        };
      });
      assert.deepEqual(r, { portrait: true, below: true, spans: true, grip: false, inBoard: true, wide: true,
        droneGrid: 'grid' });
      await p.evaluate(() => document.getElementById('toasts')?.replaceChildren());
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(SHOTS, 'u3-ipad-portrait-820.png') });
      await p.click('[data-testid="v6-sb-collapse"]');
      const rail = await p.evaluate(() => document.querySelector('.v6-side').getBoundingClientRect().height);
      assert.ok(rail < 80, `the folded panel is one row (${rail} px)`);
      await p.click('[data-testid="v6-rb-setlist"]');
      assert.equal(await p.evaluate(() => window.__rig.views.v6.sidebar.mounted), 'setlist');
      assert.deepEqual(errs, []);
    } finally {
      await c.close();
    }
  });
}
