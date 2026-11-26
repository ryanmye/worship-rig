// UI v6 U5b: the second half of the v6 Edit (app/js/views/v6/edit/catpanel.js, drone.js, effects.js, master.js,
// chooser.js, bottom.js; native/docs/lanes/UI6-build-plan.md "U5b"; mockup native/docs/design/mockups/edit.html
// "Effects · Space", "Effects · Sends", "Drone", "Master · …", "Change instrument"). Run from run.mjs on its page
// (the v6 Edit is on):
//   - Drone / Effects / Master write today's addresses (data-bind union compared with today's panels, captured with
//     the flag off by run.mjs, plus real writes of the reused sidebar Drone module and the preset choices);
//   - every category's dot = "changed since the song began" against the Revert snapshot (Sound / Tone EQ / Touch /
//     Advanced too), live moves (levels, ON) never dot, the rig tabs follow, Revert clears;
//   - the v6 Perform's bottom row in Edit (Revert / Fade out / PANIC / Lock, range bars), its own test ids (no
//     duplicate outside U5a's stage strip), mounted only while Edit shows;
//   - the instrument chooser (kinds from the engine's list, playing now, search, select, Use + Undo, Cancel / Esc write
//     nothing, what is kept, an empty place, Remove, Perform's Change);
//   - U5a's small open items O3–O6; the fit at 1024 × 700 and 820 × 1180; screenshots (UI6E5B_SHOTS or
//     /home/claude/design-out/u5b).
import path from 'node:path';
import fs from 'node:fs';

const DESIGN_OUT = '/home/claude/design-out/u5b';

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, song, settled, setSlots, toEdit, writesOf, assert,
 *   todayShared:() => object, HERE}
 */
export async function u5bTests(x) {
  const { T, page, ev, until, tid, song, setSlots, toEdit, writesOf, assert } = x;
  const SHOTS = process.env.UI6E5B_SHOTS ? path.resolve(process.env.UI6E5B_SHOTS)
    : fs.existsSync(path.dirname(DESIGN_OUT)) ? DESIGN_OUT : path.join(x.HERE, 'screenshots');
  fs.mkdirSync(SHOTS, { recursive: true });
  const select = async (b) => {
    await ev((id) => window.__rig.views.edit.editState.select(id), b);
    await until((id) => !!document.querySelector(`.v6e-host[data-panel="${id}"] [data-testid="v6e-${id}"]`)
      || (id.startsWith('slot:') && !!document.querySelector('[data-testid="v6e-inst"]')), b);
  };
  const cat = async (kind, c) => {
    await page.click(tid(`v6e-${kind}-cat-${c}`));
    await until(({ k, cc }) => document.querySelector(`[data-testid="v6e-${k}-ccont"]`)?.dataset.cat === cc,
      { k: kind, cc: c });
  };
  const dotsOf = (kind) => ev((k) => Object.fromEntries([...document.querySelectorAll(
    `[data-testid="v6e-${k}-cnav"] .v6e-cn`)].map((b) => [b.dataset.cat, !b.querySelector('.v6e-cd').hidden])),
  kind);
  const instDots = () => ev(() => Object.fromEntries([...document.querySelectorAll('[data-testid="v6e-cnav"] .v6e-cn')]
    .map((b) => [b.dataset.cat, !b.querySelector('.v6e-cd').hidden])));
  const tabDot = (b) => ev((id) => !document.querySelector(`.v6e-rt[data-block="${id}"] .v6e-rt-cd`).hidden, b);
  const clearToasts = () => ev(() => document.getElementById('toasts')?.replaceChildren());
  /** A fresh Revert snapshot: v6 Perform takes it when the view comes back from Edit. */
  const freshBaseline = async () => {
    await ev(() => window.__rig.ctx.setView('edit'));
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await toEdit();
  };
  const setStore = (pairs) => ev((p) => {
    const { store } = window.__rig;
    const id = store.currentSong().id;
    for (const [k, v] of p) store.set(`songs.${id}.${k}`, v);
  }, pairs);
  /** Drag a word slider (lib.js wordSlider: a range input 0..1000) inside `sel` to `pos`. */
  const slide = (sel, pos) => ev(({ s, p }) => {
    const i = document.querySelector(s);
    i.value = String(p);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, { s: sel, p: pos });
  const binds = (kind) => ev((k) => [...new Set([...document.querySelectorAll(`[data-testid="v6e-${k}"] [data-bind]`)]
    .map((e) => e.dataset.bind))].sort(), kind);

  await setSlots(3);
  await toEdit();

  // ---------------------------------------------------------------- paths
  await T('U5b Drone / Effects / Master write today’s addresses (data-bind union vs today’s panels; real writes)',
    async () => {
      const today = x.todayShared();
      assert.ok(today.drone?.length && today.effects?.length && today.master?.length, JSON.stringify(today));
      const cats = { drone: ['sound', 'pads', 'behave'], effects: ['space', 'echo', 'chorus', 'sends'],
        master: ['vol', 'tape', 'meq', 'glue', 'wheels'] };
      const union = {};
      for (const [kind, list] of Object.entries(cats)) {
        await select(kind);
        const u = new Set();
        for (const c of list) {
          await cat(kind, c);
          for (const b of await binds(kind)) u.add(b);
        }
        union[kind] = [...u].sort();
      }
      // the Drone module (views/v6/sidebar/drone.js, D15) writes through store.set: real writes
      await select('drone');
      await cat('drone', 'sound');
      const mod = await writesOf(async () => {
        await ev(() => {
          const set = (sel, v) => {
            const i = document.querySelector(sel);
            i.value = String(v);
            i.dispatchEvent(new Event('input', { bubbles: true }));
            i.dispatchEvent(new Event('change', { bubbles: true }));
          };
          set('[data-testid="v6e-drone-level"] input', 600);
          set('[data-testid="v6e-drone-bright"] input', 700);
          set('[data-testid="v6e-drone-move"] input', 200);
        });
        await page.waitForTimeout(100);
        await page.click('[data-testid="v6e-drone-mode"] .seg[data-value="files"]');
        await page.click('[data-testid="v6e-drone-mode"] .seg[data-value="synth"]');
        await page.click('[data-testid="v6e-drone-keys"] .key-btn[data-pc="2"]');
        await page.click('[data-testid="v6e-drone-quality"] .seg[data-value="true"]');
        await page.click('[data-testid="v6e-drone-quality"] .seg[data-value="false"]');
        await page.click('[data-testid="v6e-drone-keys"] .key-btn[data-pc="0"]');
        await page.click(tid('v6e-drone-on'));
        await page.click(tid('v6e-drone-on'));
      });
      const modPaths = new Set(mod);
      for (const p of ['drone.gain', 'drone.brightness', 'drone.movement', 'drone.mode', 'hearIn', 'playIn', 'minor']) {
        assert.ok(modPaths.has(p), `module wrote ${p}: ${mod}`);
      }
      // every address today's panel binds is bound (or, for the module, written) by the v6 panel; nothing else
      const rel = (a) => a.replace(/^song\./, '');
      for (const kind of ['drone', 'effects', 'master']) {
        const have = new Set([...union[kind], ...(kind === 'drone' ? [...modPaths].map((p) => p) : [])].map(rel));
        const missing = today[kind].map(rel).filter((a) => !have.has(a)
          // today's Effects shows four instrument chips at least (slots 3+ empty); the v6 table shows the song's 3
          && !/^slots\.(3|[4-9]|1\d)\.sends\./.test(a));
        assert.deepEqual(missing, [], `${kind}: today binds ${missing.join(', ')}`);
        const todaySet = new Set(today[kind].map(rel));
        const extra = union[kind].map(rel).filter((a) => !todaySet.has(a));
        assert.deepEqual(extra, [], `${kind}: v6 binds more than today: ${extra.join(', ')}`);
      }
      // real writes: Space room / Echo choice → today's preset paths; a Sends cell → the strip chip's path
      await select('effects');
      await cat('effects', 'space');
      const w1 = await writesOf(() => page.click(tid('v6e-fx-space-hall')));
      assert.ok(w1.length && w1.every((p) => /^fx\.reverb\./.test(p)), `Space: ${w1}`);
      await cat('effects', 'echo');
      const w2 = await writesOf(() => page.click(tid('v6e-fx-echo-dotted')));
      assert.ok(w2.length && w2.every((p) => /^fx\.delay\./.test(p)), `Echo: ${w2}`);
      await cat('effects', 'sends');
      const w3 = await writesOf(() => slide('[data-testid="v6e-fx-send-reverb-1"] input', 400));
      assert.deepEqual(w3, ['slots.1.sends.reverb']);
      const w4 = await writesOf(() => slide('[data-testid="v6e-fx-send-delay-2"] input', 250));
      assert.deepEqual(w4, ['slots.2.sends.delay']);
      const s = await song();
      assert.equal(Math.round(s.patch.slots[1].sends.reverb * 100), 40);
      // the strip's Space chip writes the very same path (views/v6/strip.js v.setSlot(i, 'sends.reverb'))
      await select('master');
      await cat('master', 'wheels');
      const w5 = await writesOf(() => page.selectOption(`${tid('v6e-master-bend')} select`, 'none').catch(async () => {
        await ev(() => {
          const sel = document.querySelector('[data-testid="v6e-master-bend"] select')
            || document.querySelector('[data-testid="v6e-master-bend"]');
          sel.value = 'none';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }));
      assert.deepEqual(w5, ['song.patch.bend.mode']);
      // D15: the wheel targets name instruments, never Keys / Pad / Extra / Bass
      const opts = await ev(() => [...document.querySelectorAll('[data-testid="v6e-master-modWheel-target"] option')]
        .map((o) => o.textContent));
      assert.ok(opts.length > 3 && !opts.some((o) => /^(Keys|Pad|Extra|Bass) level/.test(o)), opts.join(' | '));
      console.log(`      binds: drone ${union.drone.length} (+ module ${modPaths.size} written), effects `
        + `${union.effects.length}, master ${union.master.length}; today ${today.drone.length} / `
        + `${today.effects.length} / ${today.master.length}`);
    });

  // ---------------------------------------------------------------- dots
  await T('U5b dots: every category = changed since the song began (Sound / Tone EQ / Touch / Advanced too; live '
    + 'moves never); rig tabs follow; Revert clears', async () => {
    await ev(() => {
      const { store } = window.__rig;
      window.__rig.ctx.setView('perform');
      store.resetToFactory(store.currentSong().id);
    });
    await setSlots(3);
    await freshBaseline();
    await select('slot:0');
    const none = { sound: false, eq: false, range: false, touch: false, sustain: false, sends: false, adv: false };
    await until(() => [...document.querySelectorAll('.v6e-cn .v6e-cd')].every((d) => d.hidden));
    // live moves: level and ON → no category dot, no tab dot (as today)
    await setStore([['patch.slots.0.gain', 0.3], ['patch.slots.0.muted', true]]);
    await page.waitForTimeout(150);
    assert.deepEqual(await instDots(), none);
    assert.equal(await tabDot('slot:0'), false);
    await setStore([['patch.slots.0.muted', false]]);
    const steps = [
      ['eq', [['patch.slots.0.eq.b1.db', 4]]],
      ['touch', [['patch.slots.0.velocityCurve', 'hard']]],
      ['adv', [['patch.slots.0.pan', -0.4]]],
      ['sustain', [['patch.slots.0.release', 2.5]]],
    ];
    for (const [c, pairs] of steps) {
      await setStore(pairs);
      await until((cc) => !document.querySelector(`[data-testid="v6e-cat-${cc}"] .v6e-cd`).hidden, c);
    }
    // Sound: one of the instrument's smart sliders (the first Sound slider, as the player moves it)
    await page.click(tid('v6e-cat-sound'));
    await until(() => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === 'sound');
    await slide('[data-testid="v6e-ccont"] .ev2-ws-input', 120);
    await until(() => !document.querySelector('[data-testid="v6e-cat-sound"] .v6e-cd').hidden);
    assert.deepEqual(await instDots(), { ...none, sound: true, eq: true, touch: true, adv: true, sustain: true });
    assert.equal(await tabDot('slot:0'), true);
    // a value set back to the start clears its dot (Touch)
    await setStore([['patch.slots.0.velocityCurve', 'normal']]);
    await until(() => document.querySelector('[data-testid="v6e-cat-touch"] .v6e-cd').hidden);

    // Drone: Key & sound / My Pads / Behaviour; its Level and ON tile are live moves
    await select('drone');
    await setStore([['drone.gain', 0.2], ['drone.mode', 'off']]);
    await page.waitForTimeout(150);
    assert.deepEqual(await dotsOf('drone'), { sound: false, pads: false, behave: false });
    assert.equal(await tabDot('drone'), false);
    await ev(() => {
      const { store, ctx } = window.__rig;
      const b = ctx.getBaseline().drone;
      const id = store.currentSong().id;
      store.set(`songs.${id}.drone.mode`, b.mode === 'off' ? 'synth' : b.mode);
      store.set(`songs.${id}.drone.brightness`, (b.brightness ?? 0.5) > 0.5 ? 0.1 : 0.95);
      store.set(`songs.${id}.drone.fade`, (b.fade ?? 4) === 12 ? 6 : 12);
      store.set(`songs.${id}.drone.minorUsesRelativeMajorFile`, !b.minorUsesRelativeMajorFile);
    });
    await until(() => [...document.querySelectorAll('[data-testid="v6e-drone-cnav"] .v6e-cd')].every((d) => !d.hidden));
    assert.equal(await tabDot('drone'), true);

    // Effects: Space / Echo / Chorus / Sends
    await select('effects');
    assert.deepEqual(await dotsOf('effects'), { space: false, echo: false, chorus: false, sends: false });
    await setStore([['patch.fx.reverb.size', 0.12], ['patch.fx.delay.feedback', 0.7], ['patch.fx.chorus.depth', 0.9],
      ['patch.slots.2.sends.delay', 0.8]]);
    await until(() => [...document.querySelectorAll('[data-testid="v6e-effects-cnav"] .v6e-cd')]
      .every((d) => !d.hidden));
    assert.equal(await tabDot('effects'), true);

    // Master: Tape / Master EQ / Glue / Wheels; the master volume is a live move (the top bar's fader)
    await select('master');
    await setStore([['patch.fx.master.volume', 1.2]]);
    await page.waitForTimeout(150);
    assert.deepEqual(await dotsOf('master'), { vol: false, tape: false, meq: false, glue: false, wheels: false });
    await setStore([['patch.fx.lofi.amount', 0.5], ['patch.fx.eq.low', 3], ['patch.fx.comp.amount', 0.6],
      ['patch.swell.seconds', 20]]);
    await until(() => [...document.querySelectorAll('[data-testid="v6e-master-cnav"] .v6e-cd')]
      .filter((d) => !d.hidden).length === 4);
    assert.equal(await tabDot('master'), true);

    // Revert (the Edit bottom row's, held) puts the song back: every dot goes
    await clearToasts();
    const rv = await ev(() => {
      const r = document.querySelector('[data-testid="v6e-revert"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(rv.x, rv.y);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await until(() => [...document.querySelectorAll('.v6e-rt .v6e-rt-cd')].every((d) => d.hidden)
      && [...document.querySelectorAll('[data-testid="v6e-master-cnav"] .v6e-cd')].every((d) => d.hidden));
    const s = await song();
    assert.equal(s.patch.fx.lofi.amount, 0);
    assert.equal(s.patch.slots[0].pan || 0, 0);
  });

  // ---------------------------------------------------------------- bottom row
  await T('U5b bottom row: the v6 Perform’s (range bars, Revert / Fade out / PANIC / Lock) in Edit, own test ids, '
    + 'mounted only while Edit shows', async () => {
    await select('slot:0');
    const r = await ev(() => {
      const ids = new Map();
      for (const e of document.querySelectorAll('[data-testid]')) {
        ids.set(e.dataset.testid, (ids.get(e.dataset.testid) || 0) + 1);
      }
      const stage = new Set([...document.querySelectorAll('[data-testid="v6e-stage"] [data-testid]')]
        .map((e) => e.dataset.testid));
      return {
        row: !!document.querySelector('#view-edit [data-testid="v6e-bottom"].v6-bottom'),
        parts: ['v6e-kbd', 'v6e-piano', 'v6e-revert', 'v6e-fade', 'v6e-panic', 'v6e-lock']
          .filter((t) => !document.querySelector(`#view-edit [data-testid="${t}"]`)),
        todayRow: !!document.querySelector('#view-edit .ev2-kb'),
        perform: !!document.querySelector('#view-perform [data-testid="v6-bottom"]'),
        // U5a's stage strip keeps Perform's strip test ids (scoped by v6e-stage in the tests): the only duplicates
        dups: [...ids].filter(([k, n]) => n > 1 && !stage.has(k)).map(([k]) => k),
        stageDups: [...ids].filter(([k, n]) => n > 1 && stage.has(k)).length,
        ids: (() => {
          const m = new Map();
          for (const e of document.querySelectorAll('[id]')) m.set(e.id, (m.get(e.id) || 0) + 1);
          return [...m].filter(([, n]) => n > 1).map(([k]) => k);
        })(),
        bars: document.querySelectorAll('#view-edit [data-testid^="v6e-kbd-bar-"]').length,
        live: document.querySelectorAll('[data-testid="v6e-kbd"] .v6-rh:not([aria-disabled="true"])').length,
      };
    });
    const s = await song();
    assert.deepEqual(r, { ...r, row: true, parts: [], todayRow: false, perform: true, dups: [], ids: [],
      bars: s.patch.slots.filter(Boolean).length, live: 0 }, JSON.stringify(r));
    // PANIC and Fade out: the controller's actions
    const acts = await ev(async () => {
      const out = [];
      const on = (e) => out.push(e.detail?.type);
      window.__rig.controller.addEventListener('action', on);
      document.querySelector('[data-testid="v6e-fade"]').click();
      document.querySelector('[data-testid="v6e-panic"]').click();
      await new Promise((res) => setTimeout(res, 100));
      window.__rig.controller.removeEventListener('action', on);
      return out;
    });
    assert.ok(acts.includes('fadeOutAll') && acts.includes('panic'), acts.join());
    // the keys play through controller.perform (as Perform's)
    await ev(() => {
      const p = window.__rig.controller.perform;
      window.__u5bOn = [];
      window.__u5bOrig = p.noteOn;
      p.noteOn = (n, v) => {
        window.__u5bOn.push(n);
        return window.__u5bOrig.call(p, n, v);
      };
    });
    const k = await ev(() => {
      const r2 = document.querySelector('#view-edit [data-testid="v6e-piano"] .pkey[data-note="60"]')
        .getBoundingClientRect();
      return { x: r2.left + r2.width / 2, y: r2.bottom - 8 };
    });
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.up();
    const played = await ev(() => {
      window.__rig.controller.perform.noteOn = window.__u5bOrig;
      return window.__u5bOn;
    });
    assert.deepEqual(played, [60]);
    // Revert: disabled with nothing changed; a change lights it with a count
    await freshBaseline();
    assert.equal(await ev(() => document.querySelector('[data-testid="v6e-revert"]').disabled
      || document.querySelector('[data-testid="v6e-revert"]').getAttribute('aria-disabled') === 'true'), true);
    await setStore([['patch.slots.0.octave', 1]]);
    await until(() => document.querySelector('[data-testid="v6e-revert"]').dataset.count === '1');
    await setStore([['patch.slots.0.octave', 0]]);
    // Lock: back to Perform, locked (Perform lock freezes Edit)
    await page.click(tid('v6e-lock'));
    await until(() => document.body.dataset.view === 'perform' && window.__rig.store.get().settings.performLock);
    // leaving Edit dropped Edit's row; Perform's is there
    assert.equal(await ev(() => document.querySelectorAll('#view-edit [data-testid="v6e-bottom"]').length), 0);
    await ev(() => window.__rig.store.set('settings.performLock', false));
    await toEdit();
    await until(() => !!document.querySelector('#view-edit [data-testid="v6e-bottom"]'));
  });

  // ---------------------------------------------------------------- the chooser
  await T('U5b chooser: kinds from the engine’s list, playing now, search, select + Use (keeps level, sends, range, '
    + 'Sustain) with Undo; Cancel / Esc write nothing; empty place; Remove; Perform’s Change', async () => {
    await setSlots(3);
    await select('slot:0');
    await setStore([['patch.slots.0.instrument', { type: 'sampler', id: 'salamander-piano' }],
      ['patch.slots.0.gain', 0.42], ['patch.slots.0.sends.reverb', 0.33], ['patch.slots.0.sends.delay', 0.21],
      ['patch.slots.0.lowNote', 40], ['patch.slots.0.highNote', 90], ['patch.slots.0.sustain', false],
      ['patch.slots.0.release', 1.5]]);
    await page.click(tid('v6e-change'));
    await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
    const r = await ev(() => {
      const dlg = document.querySelector('[data-testid="v6e-chooser"]');
      const list = window.__rig.engine.listInstruments().filter((it) => !it.hidden && it.ref.id !== 'drone-osc');
      return {
        role: dlg.getAttribute('role'), modal: dlg.getAttribute('aria-modal'),
        kinds: [...dlg.querySelectorAll('.v6e-ch-cat')].map((b) => b.dataset.kind),
        counts: [...dlg.querySelectorAll('.v6e-ch-cat small')].reduce((a, b) => a + Number(b.textContent), 0),
        total: list.length,
        groups: [...new Set(list.map((it) => it.group))],
        cur: dlg.querySelector('.v6e-ch-tile.cur')?.dataset.value,
        now: dlg.querySelector('.v6e-ch-tile.cur .v6e-ch-now')?.textContent,
        focus: document.activeElement?.dataset?.value || null,
        use: dlg.querySelector('[data-testid="v6e-ch-use"]').disabled,
        keep: dlg.querySelector('[data-testid="v6e-ch-keep"]').textContent,
        play: dlg.querySelectorAll('.v6e-ch-tile .v6e-ch-pv, [aria-label^="Preview"]').length,
      };
    });
    console.log(`      kinds: ${r.kinds.join(' · ')} (${r.total} sounds; engine groups: ${r.groups.join(', ')})`);
    assert.equal(r.role, 'dialog');
    assert.equal(r.modal, 'true');
    assert.equal(r.counts, r.total, 'every sound is under one kind');
    assert.ok(r.kinds.length >= 5 && r.kinds.includes('Pianos'), r.kinds.join());
    assert.equal(r.cur, 'sampler:salamander-piano');
    assert.equal(r.now, 'playing now');
    assert.equal(r.focus, 'sampler:salamander-piano');
    assert.equal(r.use, true, 'Use is off until another sound is chosen');
    assert.match(r.keep, /Keeps its level, Space and Echo, range and Sustain/);
    assert.equal(r.play, 0, 'no preview (none exists today)');
    // search
    await page.fill(tid('v6e-ch-search'), 'pad');
    const found = await ev(() => [...document.querySelectorAll('[data-testid="v6e-chooser"] .v6e-ch-tile b')]
      .map((b) => b.textContent));
    assert.ok(found.length >= 1 && found.every((n) => /pad/i.test(n)), found.join());
    await page.fill(tid('v6e-ch-search'), '');
    // choose one, then Cancel: nothing written
    const w0 = await writesOf(async () => {
      await x.chooserPick('synth:warm-pad');
      assert.equal(await page.textContent(tid('v6e-ch-use')), 'Use Warm Pad');
      await page.click(tid('v6e-ch-cancel'));
      await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    });
    assert.deepEqual(w0, []);
    assert.equal(await ev(() => document.activeElement?.dataset?.testid), 'v6e-change', 'focus back on the opener');
    // Esc: nothing written
    const w1 = await writesOf(async () => {
      await page.click(tid('v6e-change'));
      await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
      await x.chooserPick('synth:warm-pad');
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    });
    assert.deepEqual(w1, []);
    // a tap on the dim backdrop is Cancel too
    await page.click(tid('v6e-change'));
    await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
    // (skeptic UI6-U5b F1: the backdrop covers Edit's body, not the whole view: tap its own left edge)
    const bk = await ev(() => {
      const r = document.querySelector('[data-testid="v6e-chooser-back"]').getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    });
    await page.mouse.click(bk.x, bk.y);
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    // Use: only slots.0.instrument; what the note says is kept is kept; the instrument's own params start fresh
    await clearToasts();
    const w2 = await writesOf(() => x.changeInstrument('synth:warm-pad'));
    assert.deepEqual(w2, ['slots.0.instrument']);
    const sl = (await song()).patch.slots[0];
    assert.deepEqual([sl.instrument.id, sl.gain, sl.sends.reverb, sl.sends.delay, sl.lowNote, sl.highNote, sl.sustain,
      sl.release], ['warm-pad', 0.42, 0.33, 0.21, 40, 90, false, 1.5]);
    // the 8 s Undo puts the piano back
    await until(() => [...document.querySelectorAll('#toasts button')].some((b) => /undo/i.test(b.textContent)));
    await ev(() => [...document.querySelectorAll('#toasts button')].find((b) => /undo/i.test(b.textContent)).click());
    await until(() => window.__rig.store.currentSong().patch.slots[0].instrument.id === 'salamander-piano');
    // keyboard: Enter on a chosen tile uses it
    await page.click(tid('v6e-change'));
    await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
    await x.chooserPick('synth:sub-bass');
    await ev(() => document.querySelector('[data-testid="v6e-chooser"] .v6e-ch-tile[data-value="synth:sub-bass"]')
      .focus());
    await page.keyboard.press('Enter');
    await until(() => window.__rig.store.currentSong().patch.slots[0].instrument.id === 'sub-bass');
    await setStore([['patch.slots.0.instrument', { type: 'sampler', id: 'salamander-piano' }]]);
    // an empty place: "Choose a sound", Use fills it with the usual settings (defaultSlot, today's write)
    const n0 = (await song()).patch.slots.length;
    await page.click(tid('v6e-add'));
    await until((n) => !!document.querySelector('[data-testid="v6e-chooser"]')
      && window.__rig.views.edit.editState.selected === `slot:${n}`, n0);
    assert.match(await page.textContent('.v6e-ch-title'), /Choose a sound/);
    assert.equal(await ev(() => !!document.querySelector('[data-testid="v6e-ch-remove"]')), false);
    const w3 = await writesOf(async () => {
      await x.chooserPick('synth:glass-pad');
      await page.click(tid('v6e-ch-use'));
    });
    assert.deepEqual(w3, [`slots.${n0}`]);
    assert.equal((await song()).patch.slots[n0].instrument.id, 'glass-pad');
    // Remove this sound… from the chooser: today's confirm, then the place is empty (Undo)
    await page.click(tid('v6e-change'));
    await page.click(tid('v6e-ch-remove'));
    await page.click('.v6e-confirm .v6e-remove');
    await until((n) => window.__rig.store.currentSong().patch.slots[n] === null, n0);
    await setSlots(3);
    // Perform's strip Change opens the chooser on that instrument in Edit
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await page.click(tid('v6-change-1'));
    await until(() => document.body.dataset.view === 'edit' && !!document.querySelector('[data-testid="v6e-chooser"]')
      && window.__rig.views.edit.editState.selected === 'slot:1');
    assert.match(await page.textContent('.v6e-ch-sub'), /2nd instrument/);
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    await clearToasts();
  });

  // ---------------------------------------------------------------- U5a open items
  await T('U5b small items: O3 rig tablist holds only tabs; O4 Touch › Feel is a word; O5 ‹ / › when the tabs '
    + 'scroll; O6 Song bank… only with bank songs', async () => {
    await select('slot:0');
    // O3: the tablist's children are tabs; + Add and the separator are outside it, still between the instruments and
    // Drone (layout order) and the tablist is exposed with its tabs (display: contents keeps the role)
    const o3 = await ev(() => {
      const tl = document.querySelector('[data-testid="v6e-rtablist"]');
      const add = document.querySelector('[data-testid="v6e-add"]');
      const last = [...tl.querySelectorAll('.v6e-rt[data-block^="slot:"]')].pop();
      const drone = tl.querySelector('.v6e-rt[data-block="drone"]');
      return {
        role: tl.getAttribute('role'),
        kids: [...tl.children].every((c) => c.getAttribute('role') === 'tab'),
        addIn: tl.contains(add),
        order: last.getBoundingClientRect().right <= add.getBoundingClientRect().left
          && add.getBoundingClientRect().right <= drone.getBoundingClientRect().left,
      };
    });
    assert.deepEqual(o3, { role: 'tablist', kids: true, addIn: false, order: true });
    const cdp = await page.context().newCDPSession(page);
    try {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const tablists = nodes.filter((n) => n.role?.value === 'tablist' && /Your rig/.test(n.name?.value || ''));
      assert.equal(tablists.length, 1, 'the rig tablist is in the accessibility tree');
      const kids = (tablists[0].childIds || []).map((id) => nodes.find((n) => n.nodeId === id)?.role?.value);
      assert.ok(kids.length >= 6 && kids.every((k) => k === 'tab'), kids.join());
    } finally {
      await cdp.detach();
    }
    // O4
    await page.click(tid('v6e-cat-touch'));
    await setStore([['patch.slots.0.velocityCurve', 'custom']]);
    await until(() => !!document.querySelector('.v6e-own:not([hidden]) .ev2-ws'));
    const feel = await ev(() => {
      const ws = [...document.querySelectorAll('.v6e-own .ev2-ws')].find((w) => /Feel/.test(w.textContent));
      return { word: ws.querySelector('.ev2-ws-word').textContent, num: ws.querySelector('.ev2-ws-num').textContent };
    });
    assert.ok(/^[A-Za-z]/.test(feel.word) && !/\d/.test(feel.num), JSON.stringify(feel));
    await setStore([['patch.slots.0.velocityCurve', 'normal']]);
    // O5: 16 instruments at 1024 px: › shows; scrolled to the end, ‹ shows and › hides
    await page.setViewportSize({ width: 1024, height: 700 });
    try {
      await ev(() => {
        const { store } = window.__rig;
        const id = store.currentSong().id;
        while (store.currentSong().patch.slots.length < 16) store.addSlot(id);
      });
      await until(() => document.querySelectorAll('.v6e-rt[data-block^="slot:"]').length === 16);
      await ev(() => {
        document.querySelector('[data-testid="v6e-rtabs"]').scrollLeft = 0;
      });
      await until(() => !document.querySelector('[data-testid="v6e-rmore-r"]').hidden
        && document.querySelector('[data-testid="v6e-rmore-l"]').hidden);
      await ev(() => {
        const t = document.querySelector('[data-testid="v6e-rtabs"]');
        t.scrollLeft = t.scrollWidth;
      });
      await until(() => document.querySelector('[data-testid="v6e-rmore-r"]').hidden
        && !document.querySelector('[data-testid="v6e-rmore-l"]').hidden);
      await page.click(tid('v6e-rmore-l'));
      await until(() => !document.querySelector('[data-testid="v6e-rmore-r"]').hidden);
    } finally {
      await setSlots(3);
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await until(() => document.querySelector('[data-testid="v6e-rmore-r"]').hidden
      && document.querySelector('[data-testid="v6e-rmore-l"]').hidden);
    // O6: this server has no patch packs, so no Song bank songs: the button is hidden
    const o6 = await ev(() => {
      const p = window.__rig.controller.patchPacks?.();
      return { bank: p ? p.bankSongs : null, hidden: document.querySelector('[data-testid="v6e-bank"]').hidden };
    });
    assert.deepEqual(o6, { bank: 0, hidden: true });
    // with bank songs (a stubbed patch-pack read + the controller's 'user-patches' event) it shows
    const shown = await ev(() => {
      const c = window.__rig.controller;
      const orig = c.patchPacks;
      c.patchPacks = () => ({ ...orig.call(c), enabled: true, bankSongs: 2 });
      c.dispatchEvent(new CustomEvent('user-patches', { detail: {} }));
      const on = !document.querySelector('[data-testid="v6e-bank"]').hidden;
      c.patchPacks = orig;
      c.dispatchEvent(new CustomEvent('user-patches', { detail: {} }));
      return { on, off: document.querySelector('[data-testid="v6e-bank"]').hidden };
    });
    assert.deepEqual(shown, { on: true, off: true });
  });

  // ---------------------------------------------------------------- fit + screenshots
  await T('U5b fit: no sideways scroll in any Drone / Effects / Master category or the chooser at 1280×800, '
    + '1024×700 and 820×1180; every category row in sight', async () => {
    const all = { drone: ['sound', 'pads', 'behave'], effects: ['space', 'echo', 'chorus', 'sends'],
      master: ['vol', 'tape', 'meq', 'glue', 'wheels'] };
    for (const [w, hgt] of [[1280, 800], [1024, 700], [820, 1180]]) {
      await page.setViewportSize({ width: w, height: hgt });
      try {
        for (const [kind, cats] of Object.entries(all)) {
          await select(kind);
          for (const c of cats) {
            await cat(kind, c);
            await page.waitForTimeout(60);
            const r = await ev((k) => {
              // the containers do not scroll sideways (as U5a's check), and nothing in the pane reaches past it
              const panel = document.querySelector(`[data-testid="v6e-${k}"]`);
              const cont = panel.querySelector('.v6e-ccont');
              const right = cont.getBoundingClientRect().right;
              const over = [...document.querySelectorAll('.v6-edit, .v6e-main'), panel, cont,
                panel.querySelector('.v6e-pane')].filter((e) => e.scrollWidth > e.clientWidth + 1)
                .map((e) => `${e.className} +${e.scrollWidth - e.clientWidth}`)
                .concat([...cont.querySelectorAll('button, input, select, .ev2-ws, .v6e-sendrow')]
                  .filter((e) => e.offsetParent && e.getBoundingClientRect().right > right + 1)
                  .map((e) => `${e.className || e.tagName} past the pane`));
              const nav = document.querySelector(`[data-testid="v6e-${k}-cnav"]`).getBoundingClientRect();
              const rows = [...document.querySelectorAll(`[data-testid="v6e-${k}-cnav"] .v6e-cn`)].every((b) => {
                const x2 = b.getBoundingClientRect();
                return x2.top >= nav.top - 1 && x2.bottom <= nav.bottom + 1;
              });
              return { over, page: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1,
                rows };
            }, kind);
            assert.deepEqual(r, { over: [], page: false, rows: true }, `${w}×${hgt} ${kind} › ${c}`);
          }
        }
        await select('slot:0');
        await page.click(tid('v6e-change'));
        await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
        const c = await ev(() => {
          const d = document.querySelector('[data-testid="v6e-chooser"]').getBoundingClientRect();
          const f = document.querySelector('.v6e-ch-f').getBoundingClientRect();
          const use = document.querySelector('[data-testid="v6e-ch-use"]').getBoundingClientRect();
          return { inside: d.left >= 0 && d.right <= innerWidth && d.top >= 0 && d.bottom <= innerHeight,
            foot: use.right <= f.right + 1 && use.bottom <= d.bottom,
            page: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1 };
        });
        assert.deepEqual(c, { inside: true, foot: true, page: false }, `${w}×${hgt} chooser`);
        await page.keyboard.press('Escape');
        await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    }
  });

  await T('U5b screenshots (Sanctuary): Effects · Space, Effects · Sends, Drone, Master ×2, chooser at 1280×800; '
    + '1024×700; 820×1180', async () => {
    await setSlots(3);
    await setStore([['patch.slots.0.sends.reverb', 0.45], ['patch.slots.0.sends.delay', 0.1],
      ['patch.slots.1.sends.reverb', 0.7], ['patch.slots.1.sends.delay', 0.3], ['patch.slots.2.sends.reverb', 0.15]]);
    const shot = async (name) => {
      await clearToasts();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, name) });
    };
    const frames = [
      ['effects', 'space', 'effects-space'], ['effects', 'sends', 'effects-sends'], ['drone', 'sound', 'drone'],
      ['master', 'wheels', 'master-wheels'], ['master', 'vol', 'master-volume'],
    ];
    for (const [w, hgt, sizes] of [[1280, 800, 'all'], [1024, 700, 'all'], [820, 1180, 'some']]) {
      await page.setViewportSize({ width: w, height: hgt });
      try {
        for (const [kind, c, name] of frames) {
          if (sizes === 'some' && !['effects-sends', 'drone', 'master-wheels'].includes(name)) continue;
          await select(kind);
          await cat(kind, c);
          await shot(`u5b-${name}-${w}.png`);
        }
        await select('slot:0');
        await page.click(tid('v6e-change'));
        await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
        await x.chooserPick(null, 'sampler:salamander-piano');
        await shot(`u5b-chooser-${w}.png`);
        await page.keyboard.press('Escape');
        await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    }
    console.log(`      → ${SHOTS}`);
  });
}
