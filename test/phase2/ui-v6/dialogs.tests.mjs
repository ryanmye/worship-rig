// UI v6 U7c (native/docs/lanes/UI6-build-plan.md U7; mockup native/docs/design/mockups/dialogs.html): MIDI Learn on
// Perform (views/v6/learn-mode.js), Arrange (arrange.js), Save snapshot (dialogs.js, D25 names) and the song menu
// (song-menu.js). Run from run.mjs on its page (the v6 Perform is on). MIDI goes in through midi._inject, as the
// settings and Edit learn tests do. Screenshots u7c-*.png (1280×800 Sanctuary, and 820×1180) → U7C_SHOTS or SHOTS.
// The song menu on a trial song is checked in the ui-v6-bank suite (it has bank packs).
import path from 'node:path';
import fs from 'node:fs';

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, song, settled, hold, setSlots, SHOTS, assert,
 *   rectOf, armPanics}
 */
export async function dialogTests(x) {
  const { T, page, ev, until, tid, song, settled, hold, setSlots, assert, rectOf, armPanics } = x;
  const SHOTS = process.env.U7C_SHOTS ? path.resolve(process.env.U7C_SHOTS) : x.SHOTS;
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (name) => {
    await ev(() => document.getElementById('toasts')?.replaceChildren()); // earlier checks' toasts out of the picture
    await page.screenshot({ path: path.join(SHOTS, name) });
  };
  const toPerform = async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await ev(() => {
      window.__rig.views.v6?.kb.pick(null);
      document.activeElement?.blur?.();
    });
  };
  const clearToasts = () => ev(() => document.getElementById('toasts')?.replaceChildren());
  const learnState = () => ev(() => window.__rig.views.v6.learn.state);
  const inject = (bytes) => ev((b) => window.__rig.midi._inject(b), bytes);
  const ml = () => ev(() => JSON.parse(JSON.stringify(window.__rig.store.get().settings.midiLearn || {})));
  const ids = async () => (await song()).patch.slots.map((s) => (s ? s.instrument.id : null));

  await T('U7c Learn on Perform from Settings: knob first, then tap → learned (D20 toast, badge); every learnable '
    + 'control outlined; the tap does not move the control', async () => {
    await toPerform();
    await ev(() => window.__rig.controller.scenes.go(null));
    await setSlots(3);
    await ev(() => window.__rig.store.set('settings.midiLearn', {}));
    await ev(() => window.__rig.views.v6.sidebar.open('drone'));
    await ev(() => window.__rig.ctx.openSettings({ section: 'midilearn' }));
    await until(() => !!document.querySelector('[data-testid="settings-learn-perform"]')?.getClientRects().length);
    await page.click(tid('settings-learn-perform'));
    await until(() => window.__rig.views.v6.learn.active && document.getElementById('view-settings').hidden);
    assert.equal(await page.isVisible(tid('v6-learnbar')), true);
    assert.equal(await page.textContent(tid('v6-learn-step1')), '1 · Move a knob, fader or pad');
    assert.equal(await ev(() => window.__rig.midi.learning), '(capture)', 'a capture waits for the knob');
    // every learnable control of the v6 Perform: strip level / Space / Echo, drone level, master, Swell, Fade, PANIC
    const tg = await ev(() => window.__rig.views.v6.learn.targets.map((t) => t.id));
    for (const id of ['slots.0.gain', 'slots.0.sends.reverb', 'slots.0.sends.delay', 'slots.2.gain', 'drone.gain',
      'master.volume', 'swell', 'fadeOutAll', 'panic']) assert.ok(tg.includes(id), `${id} in ${tg}`);
    assert.equal(tg.some((id) => /octave|sustain|muted/.test(id)), false, 'no switch or step control');
    assert.equal(await ev(() => document.querySelectorAll('.v6-learnable').length), tg.length);
    assert.equal(await ev(() => document.querySelector('#master-mount .fader').classList.contains('v6-learnable')),
      true, 'the top bar\'s master fader too');
    // 1 · the knob
    await inject([0xb0, 21, 40]);
    await until(() => document.querySelector('[data-testid="v6-learn-step1"]').textContent === 'CC 21 moved ✓');
    assert.deepEqual((await learnState()).heard, { cc: 21, channel: 0 });
    await shot('u7c-learn-1280.png');
    // 2 · the tap on Warm Pad's fader: learned, the fader did not move
    const g0 = (await song()).patch.slots[1].gain;
    await clearToasts();
    await page.click(tid('v6-fader-1'));
    await until(() => !!window.__rig.store.get().settings.midiLearn?.['slots.1.gain']);
    assert.deepEqual((await ml())['slots.1.gain'], { cc: 21, channel: 0 });
    assert.equal((await song()).patch.slots[1].gain, g0, 'the tap only picked');
    await until(() => /CC 21 → .+ level ✓ · moves stick; Revert undoes them/.test(
      document.getElementById('toasts').innerText));
    await until(() => document.querySelector('[data-testid="v6-fader-1"]').dataset.v6Badge === 'CC21');
    // back to step 1 for the next one; the learned knob drives the level (a song edit, D20)
    await until(() => window.__rig.views.v6.learn.state?.heard === null && window.__rig.midi.learning === '(capture)');
    await shot('u7c-learn-done-1280.png');
    // tap first, then the knob: Grand Piano's Space chip; no step panel opens
    const r0 = (await song()).patch.slots[0].sends.reverb;
    await page.click(tid('v6-space-0'));
    await until(() => window.__rig.views.v6.learn.state?.picked === 'slots.0.sends.reverb');
    assert.match(await page.textContent(tid('v6-learn-step2')), /Space ✓$/);
    assert.equal(await ev(() => document.querySelectorAll('.step-panel').length), 0, 'no step panel opened');
    await inject([0xb0, 22, 10]);
    await until(() => !!window.__rig.store.get().settings.midiLearn?.['slots.0.sends.reverb']);
    assert.deepEqual((await ml())['slots.0.sends.reverb'], { cc: 22, channel: 0 });
    assert.equal((await song()).patch.slots[0].sends.reverb, r0);
    // a pad (note): faders are not outlined as fits, a tap on one is refused (skeptic UI6-U7c F2: the fader stays
    // picked and the capture waits for a knob again); PANIC takes the pad, and the tap on PANIC panics (F1)
    await armPanics();
    await until(() => window.__rig.midi.learning === '(capture)');
    await inject([0x99, 36, 100]);
    await until(() => window.__rig.views.v6.learn.state?.heard?.note === 36);
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-fader-0"]').classList.contains('v6-lmiss')),
      true);
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-panic"]').classList.contains('v6-lmiss')),
      false);
    await clearToasts();
    await page.click(tid('v6-fader-0'));
    await until(() => /A key or pad can’t move/.test(document.getElementById('toasts').innerText));
    assert.equal((await ml())['slots.0.gain'], undefined);
    // F2: no dead end: the fader stays picked, the pad is forgotten, a capture waits again
    await until(() => window.__rig.views.v6.learn.state?.picked === 'slots.0.gain'
      && window.__rig.views.v6.learn.state?.heard === null && window.__rig.midi.learning === '(capture)');
    // the pad again on the picked fader: refused, the fader stays picked
    await clearToasts();
    await inject([0x99, 36, 100]);
    await until(() => /A key or pad can’t move/.test(document.getElementById('toasts').innerText));
    await inject([0x89, 36, 0]);
    assert.equal((await learnState()).picked, 'slots.0.gain');
    await until(() => window.__rig.midi.learning === '(capture)');
    // F1: a tap on PANIC panics (a stuck note can always be stopped) and picks it; the pad then learns to it
    await page.click(tid('v6-panic'));
    await until(() => window.__panics === 1 && window.__rig.views.v6.learn.state?.picked === 'panic');
    await inject([0x99, 36, 100]);
    await until(() => !!window.__rig.store.get().settings.midiLearn?.panic);
    assert.deepEqual((await ml()).panic, { note: 36, channel: 9 });
    assert.equal((await ml())['slots.0.gain'], undefined);
    assert.equal(await ev(() => window.__panics), 1, 'the captured pad did not panic; the tap did, once');
    await inject([0x89, 36, 0]);
    // F1: the pad learned to PANIC is never captured while learning: it panics, the capture keeps waiting
    await until(() => window.__rig.views.v6.learn.state?.heard === null && window.__rig.midi.learning === '(capture)');
    await inject([0x99, 36, 100]);
    await until(() => window.__panics === 2);
    await inject([0x89, 36, 0]);
    assert.deepEqual(await learnState(), { heard: null, picked: null });
    assert.equal(await ev(() => window.__rig.midi.learning), '(capture)');
    // the learned knob, after learn mode: it moves Warm Pad's level (and the learned pad panics)
    await page.click(tid('v6-learn-done'));
    await until(() => !window.__rig.views.v6.learn.active);
    const after = await ev(() => ({ outlined: document.querySelectorAll('.v6-learnable, [data-v6-learn]').length,
      body: document.body.classList.contains('v6-learning'), learning: window.__rig.midi.learning,
      bar: document.querySelector('[data-testid="v6-learnbar"]').hidden }));
    assert.deepEqual(after, { outlined: 0, body: false, learning: null, bar: true });
    // (pickup: the knob takes over once it crosses the level)
    await inject([0xb0, 21, 0]);
    await inject([0xb0, 21, 127]);
    await until((g) => window.__rig.store.currentSong().patch.slots[1].gain !== g, g0);
    await inject([0x99, 36, 100]);
    await until(() => window.__panics === 3);
    await inject([0x89, 36, 0]);
    // put the level back
    await ev((g) => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.1.gain`, g), g0);
  });

  await T('U7c Learn: right-click picks and opens it; Esc leaves (no panic; Esc always panics: panics and leaves); '
    + 'Lock refuses / ends it; a song switch drops the half-made learn; Edit / flag off leave it', async () => {
    await toPerform();
    await page.click(tid('v6-echo-1'), { button: 'right' });
    await until(() => window.__rig.views.v6.learn.active);
    assert.equal((await learnState()).picked, 'slots.1.sends.delay');
    assert.match(await page.textContent(tid('v6-learn-step2')), /Echo ✓$/);
    await armPanics();
    await page.keyboard.press('Escape');
    await until(() => !window.__rig.views.v6.learn.active);
    assert.equal(await ev(() => window.__panics), 0, 'Esc leaves learn mode, no panic');
    assert.equal(await ev(() => window.__rig.midi.learning), null, 'the capture is cancelled');
    // D24.7 on: one Esc panics and leaves
    await ev(() => window.__rig.store.set('settings.escPanics', true));
    try {
      await ev(() => window.__rig.views.v6.learn.enter());
      await page.keyboard.press('Escape');
      await until(() => !window.__rig.views.v6.learn.active && window.__panics === 1);
    } finally {
      await ev(() => window.__rig.store.set('settings.escPanics', null));
    }
    // Lock: refused; the lock coming on ends it
    await ev(() => window.__rig.store.set('settings.performLock', true));
    try {
      assert.equal(await ev(() => window.__rig.views.v6.learn.enter()), false);
      await page.click(tid('v6-fader-0'), { button: 'right' });
      assert.equal(await ev(() => window.__rig.views.v6.learn.active), false);
    } finally {
      await ev(() => window.__rig.store.set('settings.performLock', false));
    }
    await ev(() => window.__rig.views.v6.learn.enter());
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await until(() => !window.__rig.views.v6.learn.active);
    assert.equal(await ev(() => window.__rig.midi.learning), null);
    await ev(() => window.__rig.store.set('settings.performLock', false));
    // a song switch drops what was heard / tapped, learn mode stays
    await ev(() => window.__rig.views.v6.learn.enter({ target: 'slots.0.gain' }));
    await inject([0xb0, 30, 5]);
    await until(() => window.__rig.store.get().settings.midiLearn?.['slots.0.gain']?.cc === 30);
    await inject([0xb0, 31, 5]);
    await until(() => window.__rig.views.v6.learn.state?.heard?.cc === 31);
    const sid0 = (await song()).id;
    await ev(() => window.__rig.controller.nextSong());
    await until((s) => window.__rig.store.currentSong().id !== s, sid0);
    await until(() => window.__rig.views.v6.learn.state?.heard === null);
    assert.equal(await ev(() => window.__rig.views.v6.learn.active), true);
    await ev(() => window.__rig.controller.prevSong());
    await until((s) => window.__rig.store.currentSong().id === s, sid0);
    await settled();
    // Edit leaves it
    await ev(() => window.__rig.ctx.setView('edit'));
    await until(() => !window.__rig.views.v6.learn.active);
    await toPerform();
    // the flag going off with learn mode on: the capture is cancelled
    await ev(() => window.__rig.views.v6.learn.enter());
    assert.equal(await ev(() => window.__rig.midi.learning), '(capture)');
    await ev(() => window.__rig.setUiV6(false));
    assert.deepEqual(await ev(() => ({ learning: window.__rig.midi.learning,
      body: document.body.classList.contains('v6-learning'), marks: document.querySelectorAll('[data-v6-learn]').length,
    })), { learning: null, body: false, marks: 0 });
    await ev(() => window.__rig.setUiV6(true));
    await until(() => !!document.querySelector('[data-testid="v6-perform"]'));
    await ev(() => window.__rig.store.set('settings.midiLearn', {}));
  });

  await T('U7c skeptic F3: the Esc that closes Settings (or clears its search) does not end MIDI Learn or Arrange; '
    + 'the next Esc does', async () => {
    await toPerform();
    await armPanics();
    for (const mode of ['learn', 'arrange']) {
      await ev((m) => window.__rig.views.v6[m].enter(), mode);
      await ev(() => window.__rig.ctx.openSettings({ section: 'midilearn' }));
      await until(() => document.body.classList.contains('settings-open'));
      await page.keyboard.press('Escape');
      await until(() => !document.body.classList.contains('settings-open'));
      assert.equal(await ev((m) => window.__rig.views.v6[m].active, mode), true, `${mode} stays on`);
      if (mode === 'learn') assert.equal(await ev(() => window.__rig.midi.learning), '(capture)');
      await page.keyboard.press('Escape');
      await until((m) => !window.__rig.views.v6[m].active, mode);
    }
    // Settings' search: the first Esc clears it, Settings stays, learn mode stays
    await ev(() => window.__rig.views.v6.learn.enter());
    await ev(() => window.__rig.ctx.openSettings());
    await until(() => !!document.querySelector('#view-settings input[type="search"]')?.getClientRects().length);
    await page.fill('#view-settings input[type="search"]', 'midi');
    await page.focus('#view-settings input[type="search"]');
    await page.keyboard.press('Escape');
    assert.equal(await ev(() => document.body.classList.contains('settings-open')), true);
    assert.equal(await ev(() => window.__rig.views.v6.learn.active), true);
    await page.keyboard.press('Escape');
    await until(() => !document.body.classList.contains('settings-open'));
    assert.equal(await ev(() => window.__rig.views.v6.learn.active), true);
    await page.click(tid('v6-learn-done'));
    await until(() => !window.__rig.views.v6.learn.active);
    assert.equal(await ev(() => window.__panics), 0);
  });

  await T('U7c Arrange: strips get handles (◀ ▶ ✕ hold, ⠿ drag = the strip drag), the sidebar its customize list; '
    + 'Done / Esc; Lock; a folded sidebar opens for it and folds back', async () => {
    await toPerform();
    await setSlots(3);
    await page.click(tid('v6-arrange'));
    await until(() => window.__rig.views.v6.arrange.active);
    const on = await ev(() => ({
      cls: document.querySelector('[data-testid="v6-perform"]').classList.contains('arranging'),
      bars: [...document.querySelectorAll('.v6-arrbar-s')].filter((b) => b.getClientRects().length).length,
      list: !!document.querySelector('[data-testid="v6-sb-arrange"] .v6-cz'),
      mounted: window.__rig.views.v6.sidebar.mounted,
      grips: [...document.querySelectorAll('.v6-grip')].filter((b) => b.getClientRects().length).length,
    }));
    assert.deepEqual(on, { cls: true, bars: 3, list: true, mounted: null, grips: 0 });
    await shot('u7c-arrange-1280.png');
    const before = await ids();
    // ▶ on the first: it goes one place right
    await page.click(tid('v6-arr-later-0'));
    await until((b) => window.__rig.store.currentSong().patch.slots[1]?.instrument.id === b[0], before);
    assert.deepEqual(await ids(), [before[1], before[0], before[2]]);
    // ⠿ drag: the third to the front, through strips-row.js's drag
    const g = await rectOf(page, tid('v6-arr-grip-2'));
    const s0 = await rectOf(page, tid('v6-strip-0'));
    await page.mouse.move(g.cx, g.cy);
    await page.mouse.down();
    await page.mouse.move(s0.l + 10, g.cy + 20, { steps: 12 });
    await page.mouse.up();
    await until((b) => window.__rig.store.currentSong().patch.slots[0]?.instrument.id === b[2], before);
    assert.deepEqual(await ids(), [before[2], before[1], before[0]]);
    // ✕ needs the hold
    await page.click(tid('v6-arr-remove-2'));
    await page.waitForTimeout(150);
    assert.equal((await song()).patch.slots.length, 3, 'a tap does not remove');
    await hold(tid('v6-arr-remove-2'));
    await until(() => window.__rig.store.currentSong().patch.slots.length === 2);
    // the sidebar's order through its list (the same rows as ⋯ customize)
    const o0 = await ev(() => window.__rig.views.v6.sidebar.prefs.order);
    await page.click(tid(`v6-cz-dn-${o0[0]}`));
    await until((a) => window.__rig.views.v6.sidebar.prefs.order[1] === a, o0[0]);
    assert.equal(await ev(() => document.querySelector('.v6-sb-tabs [role=tab]').dataset.id), o0[1],
      'the tabs follow at once');
    await page.click(tid(`v6-cz-up-${o0[0]}`));
    await until((a) => window.__rig.views.v6.sidebar.prefs.order[0] === a, o0[0]);
    // Done: the module is back
    await page.click(tid('v6-arrange-done'));
    await until(() => !window.__rig.views.v6.arrange.active);
    assert.equal(await ev(() => window.__rig.views.v6.sidebar.mounted), await ev(() =>
      window.__rig.views.v6.sidebar.prefs.tab));
    assert.equal(await ev(() => document.querySelectorAll('.v6-arrbar-s').length
      - [...document.querySelectorAll('.v6-arrbar-s')].filter((b) => !b.getClientRects().length).length), 0);
    // Esc leaves (no panic)
    await armPanics();
    await page.click(tid('v6-arrange'));
    await until(() => window.__rig.views.v6.arrange.active);
    await page.keyboard.press('Escape');
    await until(() => !window.__rig.views.v6.arrange.active);
    assert.equal(await ev(() => window.__panics), 0);
    // a folded sidebar opens for Arrange and folds again; the fold stays saved
    await ev(() => window.__rig.views.v6.sidebar.collapse());
    await page.click(tid('v6-arrange'));
    await until(() => window.__rig.views.v6.arrange.active);
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-right"]').classList.contains('rail')), false);
    assert.equal(await ev(() => JSON.parse(localStorage.getItem('worship-rig.v6.sidebar')).open), false);
    await page.click(tid('v6-arrange-done'));
    await until(() => document.querySelector('[data-testid="v6-right"]').classList.contains('rail'));
    await ev(() => window.__rig.views.v6.sidebar.open());
    // Lock: Arrange is disabled; the lock coming on ends it
    await page.click(tid('v6-arrange'));
    await until(() => window.__rig.views.v6.arrange.active);
    await ev(() => window.__rig.store.set('settings.performLock', true));
    try {
      await until(() => !window.__rig.views.v6.arrange.active);
      assert.equal(await page.isDisabled(tid('v6-arrange')), true);
      assert.equal(await ev(() => window.__rig.views.v6.arrange.enter()), false);
    } finally {
      await ev(() => window.__rig.store.set('settings.performLock', false));
    }
    // learn mode and Arrange never show together
    await page.click(tid('v6-arrange'));
    await ev(() => window.__rig.views.v6.learn.enter());
    assert.deepEqual(await ev(() => [window.__rig.views.v6.arrange.active, window.__rig.views.v6.learn.active]),
      [false, true]);
    await ev(() => window.__rig.views.v6.learn.exit());
  });

  await T('U7c Save snapshot: + Save opens the dialog (suggested name; It keeps = what a snapshot holds); Save as new '
    + 'names it; Update keeps or renames; names in the row and the fold chip; Cancel / Esc / backdrop; the max',
  async () => {
    await toPerform();
    await setSlots(3);
    await ev(() => {
      const { store, controller } = window.__rig;
      const id = store.currentSong().id;
      controller.scenes.go(null);
      store.set(`songs.${id}.scenes`, []);
      store.set(`songs.${id}.patch.slots.0.gain`, 0.7);
      store.set(`songs.${id}.patch.slots.1.gain`, 0.5);
      store.set(`songs.${id}.patch.slots.2.muted`, true);
    });
    await until(() => document.querySelectorAll('[data-testid^="v6-snap-"][data-n]').length === 0);
    // the name heuristic (dialogs.js suggestSnapshotName, D25), on made-up songs
    const sg = await ev(async () => {
      const { suggestSnapshotName: f } = await import('./js/views/v6/dialogs.js');
      const names = { name: (r) => r.id };
      const sl = (id, gain, muted) => ({ instrument: { type: 'synth', id }, gain: muted ? 0 : gain,
        ...(muted ? { muted: true, gainBeforeMute: gain } : {}) });
      const songOf = (slots, dg = 1) => ({ patch: { slots }, drone: { mode: 'synth', gain: dg } });
      const own = songOf([sl('A', 0.5), sl('B', 0.5), sl('C', 0.5), sl('D', 0.5)]);
      return [
        f(songOf([sl('A', 0.5), sl('B', 0.5), sl('C', 0.5, true), sl('D', 0, false)]), own, names),
        f(songOf([sl('A', 0.9), sl('B', 0.9), sl('C', 0.9), sl('D', 0.9)]), own, names),
        f(songOf([sl('A', 0.2), null, sl('C', 0.5, true), sl('D', 0.5, true)]), own, names),
        f(songOf([sl('A', 0.5), sl('B', 0.5, true), sl('C', 0.5, true), sl('D', 0.5, true)], 2), own, names),
        f(songOf([sl('A', 0, true)], 0.5), songOf([sl('A', 0.5)]), names),
        f(songOf([sl('A', 0, true)], 0), songOf([sl('A', 0.5)]), names),
        f(songOf([sl('A', 0.5), sl('B', 0.5)]), own, names, ['a + b', 'A + B 2']),
        f(songOf([sl('x'.repeat(30), 0.5), sl('y'.repeat(30), 0.5)]), own, names).length,
      ];
    });
    assert.deepEqual(sg, ['A + B', 'A + B + 2 more, louder', 'A, softer', 'A, drone up', 'Drone only', 'All off',
      'A + B 3', 40]);
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    const d0 = await ev(() => ({
      name: document.querySelector('[data-testid="v6-savesnap-name"]').value,
      focus: document.activeElement?.dataset.testid,
      modal: document.querySelector('[data-testid="v6-savesnap"]').getAttribute('aria-modal'),
      keeps: document.querySelector('[data-testid="v6-savesnap-keeps"]').innerText,
      update: !!document.querySelector('[data-testid="v6-savesnap-update"]'),
    }));
    const n0 = await page.textContent(tid('v6-name-0'));
    const n1 = await page.textContent(tid('v6-name-1'));
    assert.equal(d0.name, `${n0} + ${n1}`, 'the instruments that are on (the third is OFF)');
    assert.equal(d0.focus, 'v6-savesnap-name');
    assert.equal(d0.modal, 'true');
    assert.equal(d0.update, false, 'no snapshot plays: nothing to update');
    assert.match(d0.keeps, /level and ON \/ OFF/);
    // D26.1: the sends, Space / Echo (named as the song bar names them) and the drone's ON / key / sound are kept now
    assert.match(d0.keeps, /Each instrument’s Space and Echo/);
    assert.match(d0.keeps, /Space: (\w[\w ]*|Custom) · Echo: (\w[\w ]*|Custom), with their levels/);
    assert.match(d0.keeps, /The drone: ON \/ OFF, key, sound and level/);
    assert.match(d0.keeps, /(on|off) · [A-G][#b]? (major|minor)/);
    assert.match(d0.keeps, /Not kept: .*tone \(EQ\).*brightness and movement/);
    assert.doesNotMatch(d0.keeps.split('Not kept')[0], /warmer|brighter|octave|sustain/,
      'never claims tone / octave / sustain');
    await shot('u7c-savesnap-1280.png');
    // Esc cancels (no panic), the backdrop too
    await armPanics();
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-savesnap"]'));
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    await page.mouse.click(30, 760); // the backdrop (over the keyboard row)
    await until(() => !document.querySelector('[data-testid="v6-savesnap"]'));
    assert.equal(await ev(() => window.__panics), 0);
    assert.equal(((await song()).scenes || []).length, 0, 'nothing saved');
    // Save as new with a typed name (Enter)
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    await page.fill(tid('v6-savesnap-name'), '  Quiet   start ');
    await page.keyboard.press('Enter');
    await until(() => (window.__rig.store.currentSong().scenes || []).length === 1);
    assert.equal((await song()).scenes[0].name, 'Quiet start');
    await until(() => document.querySelector('[data-testid="v6-snap-1"]')?.textContent === 'Quiet start');
    // edited → Save as new opens the dialog with Update “Quiet start”; Update with the field untouched keeps the name
    await page.click(tid('v6-on-0'));
    await until(() => !document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    await page.click(tid('v6-snap-new'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap-update"]'));
    assert.equal(await page.textContent(tid('v6-savesnap-update')), 'Update “Quiet start”');
    await page.click(tid('v6-savesnap-update'));
    await until(() => document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    assert.deepEqual([(await song()).scenes.length, (await song()).scenes[0].name, (await song()).scenes[0].slots[0]
      .muted], [1, 'Quiet start', true]);
    // the dirty line's Update saves at once and keeps the name
    await page.click(tid('v6-on-0'));
    await until(() => !document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    await page.click(tid('v6-snap-update'));
    await until(() => document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    assert.equal((await song()).scenes[0].name, 'Quiet start');
    // Update with an edited field renames
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap-update"]'));
    await page.fill(tid('v6-savesnap-name'), 'Verse');
    await page.click(tid('v6-savesnap-update'));
    await until(() => window.__rig.store.currentSong().scenes[0].name === 'Verse');
    // Save as new with an empty field: no name, "Scene 2"
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    await page.fill(tid('v6-savesnap-name'), '');
    assert.match(await ev(() => document.querySelector('.v6-dlg-namebox small').textContent), /Scene n/);
    await page.click(tid('v6-savesnap-new'));
    await until(() => (window.__rig.store.currentSong().scenes || []).length === 2);
    assert.equal('name' in (await song()).scenes[1], false);
    assert.equal(await page.textContent(tid('v6-snap-2')), 'Scene 2');
    // the fold chip shows the playing one's name
    await page.click(tid('v6-snap-1'));
    await until(() => window.__rig.controller.scenes.state().n === 0);
    await page.click(tid('v6-snap-fold'));
    await until(() => document.querySelector('[data-testid="v6-snaps"]').hidden);
    assert.equal(await page.textContent(`${tid('v6-snap-chip')} .v6-snapchip-n`), 'Verse');
    await page.click(tid('v6-snap-chip'));
    await until(() => !document.querySelector('[data-testid="v6-snaps"]').hidden);
    // a third, then the max: + Save opens the dialog only while one plays, Save as new disabled, Enter = Update
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    await page.click(tid('v6-savesnap-new'));
    await until(() => (window.__rig.store.currentSong().scenes || []).length === 3);
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    assert.equal(await page.isDisabled(tid('v6-savesnap-new')), true);
    await page.fill(tid('v6-savesnap-name'), 'Third');
    await page.keyboard.press('Enter');
    await until(() => window.__rig.store.currentSong().scenes[2].name === 'Third');
    assert.equal((await song()).scenes.length, 3);
    await page.click(tid('v6-snap-own'));
    await until(() => document.querySelector('[data-testid="v6-snap-save"]').disabled);
    // Lock does not block snapshots (D24.1): the dialog opens and saves
    await page.click(tid('v6-snap-1'));
    await until(() => window.__rig.controller.scenes.state().n === 0);
    await ev(() => window.__rig.store.set('settings.performLock', true));
    try {
      await page.click(tid('v6-snap-save'));
      await until(() => !!document.querySelector('[data-testid="v6-savesnap-update"]'));
      await page.fill(tid('v6-savesnap-name'), 'Locked rename');
      await page.click(tid('v6-savesnap-update'));
      await until(() => window.__rig.store.currentSong().scenes.some((s) => s.name === 'Locked rename'));
    } finally {
      await ev(() => window.__rig.store.set('settings.performLock', false));
    }
    // a footswitch step to another snapshot, or a song switch, closes it (Update would name the wrong one)
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap-update"]'));
    await ev(() => window.__rig.controller.scenes.next());
    await until(() => !document.querySelector('[data-testid="v6-savesnap"]'));
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    const sid0 = (await song()).id;
    await ev(() => window.__rig.controller.nextSong());
    await until(() => !document.querySelector('[data-testid="v6-savesnap"]'));
    await ev((id) => window.__rig.controller.selectSong(id), sid0);
    await until((id) => window.__rig.store.currentSong().id === id, sid0);
    await settled();
    await ev(() => {
      const { store, controller } = window.__rig;
      controller.scenes.go(null);
      store.set(`songs.${store.currentSong().id}.scenes`, []);
      store.set(`songs.${store.currentSong().id}.patch.slots.2.muted`, false);
    });
  });

  await T('U7c song menu: Rename… / Duplicate / Add to setlist ▸ / Export / Reset to as saved (hold) / Delete (hold); '
    + 'Lock freezes all but Reset', async () => {
    await toPerform();
    await settled();
    // a clean baseline: the checks above changed levels (Revert puts the song back as it was selected)
    if (!(await page.isDisabled(tid('v6-revert')))) {
      await hold(tid('v6-revert'));
      await until(() => document.querySelector('[data-testid="v6-revert"]').disabled);
    }
    const s0 = await song();
    const openMenu = async () => {
      await page.click(tid('v6-songmenu-btn'));
      await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
    };
    await openMenu();
    await shot('u7c-songmenu-1280.png');
    assert.match(await ev(() => document.querySelector('[data-testid="v6-sm-delete"]').textContent),
      /no automatic backup in Chrome/, 'Chrome: no backup, and the menu says so');
    // Rename…
    await page.click(tid('v6-sm-rename'));
    await until(() => !!document.querySelector('[data-testid="v6-rename"]'));
    assert.equal(await page.inputValue(tid('v6-rename-name')), s0.name);
    await page.fill(tid('v6-rename-name'), '   ');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible(tid('v6-rename')), true, 'an empty name is refused');
    await page.fill(tid('v6-rename-name'), 'Renamed in v6');
    await page.keyboard.press('Enter');
    await until((id) => window.__rig.store.getSong(id).name === 'Renamed in v6', s0.id);
    assert.equal(await page.textContent(tid('v6-song-name')), 'Renamed in v6');
    await ev(({ id, nm }) => window.__rig.store.set(`songs.${id}.name`, nm), { id: s0.id, nm: s0.name });
    // Duplicate: a copy next to it, the song plays on
    const order0 = await ev(() => window.__rig.store.get().songOrder.slice());
    await openMenu();
    await page.click(tid('v6-sm-dup'));
    await until((n) => window.__rig.store.get().songOrder.length === n + 1, order0.length);
    const copy = await ev((id) => {
      const st = window.__rig.store.get();
      const k = st.songOrder.indexOf(id);
      return { id: st.songOrder[k + 1], name: st.songs[st.songOrder[k + 1]].name, cur: st.settings.currentSongId };
    }, s0.id);
    assert.deepEqual([copy.name, copy.cur], [`${s0.name} (copy)`, s0.id]);
    // Add to setlist ▸: a new setlist gets the song
    const slId = await ev(() => window.__rig.store.addSetlist('U7c set', []));
    await openMenu();
    await page.click(tid('v6-sm-set'));
    await until(() => !!document.querySelector('[data-testid="v6-bank-setpop"]'));
    await page.click(tid(`v6-bank-setlist-${slId}`));
    await until(({ sl, id }) => window.__rig.store.get().setlists[sl].songIds.includes(id), { sl: slId, id: s0.id });
    // Export this song…: one file
    await openMenu();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(tid('v6-sm-export'))]);
    assert.match(dl.suggestedFilename(), /\.rig-song\.json$/);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(text.includes(JSON.stringify(s0.name).slice(1, -1)), 'the song is in the file');
    // Reset to as saved (hold) = Revert: disabled while nothing changed; puts a change back
    await openMenu();
    assert.equal(await page.isDisabled(tid('v6-sm-reset')), true);
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-songmenu"]'));
    const rv = s0.patch.slots[0].sends.reverb;
    await ev(({ id, v }) => window.__rig.store.set(`songs.${id}.patch.slots.0.sends.reverb`, v), {
      id: s0.id, v: rv > 0.5 ? 0.1 : 0.9 });
    await openMenu();
    await hold(tid('v6-sm-reset'));
    await until(({ id, v }) => window.__rig.store.getSong(id).patch.slots[0].sends.reverb === v, { id: s0.id, v: rv });
    // Delete (hold): the copy, selected first
    await ev((id) => window.__rig.controller.selectSong(id), copy.id);
    await until((id) => window.__rig.store.currentSong().id === id, copy.id);
    await settled();
    await openMenu();
    await page.click(tid('v6-sm-delete'));
    await page.waitForTimeout(150);
    assert.ok(await ev((id) => !!window.__rig.store.getSong(id), copy.id), 'a tap does not delete');
    if (!(await page.isVisible(tid('v6-songmenu')))) await openMenu();
    await hold(tid('v6-sm-delete'));
    await until((id) => !window.__rig.store.getSong(id), copy.id);
    await until(() => /Deleted “/.test(document.getElementById('toasts').innerText));
    // back to the first song; the setlist goes
    await ev((id) => window.__rig.controller.selectSong(id), s0.id);
    await until((id) => window.__rig.store.currentSong().id === id, s0.id);
    await settled();
    await ev((sl) => window.__rig.store.deleteSetlist(sl), slId);
    // Lock: everything that changes the library is frozen; Reset stays (a hold, as Revert)
    await ev(() => window.__rig.store.set('settings.performLock', true));
    try {
      await openMenu();
      const dis = await ev(() => ['rename', 'dup', 'set', 'export', 'delete'].map((k) =>
        document.querySelector(`[data-testid="v6-sm-${k}"]`).disabled));
      assert.deepEqual(dis, [true, true, true, true, true]);
      await page.keyboard.press('Escape');
    } finally {
      await ev(() => window.__rig.store.set('settings.performLock', false));
    }
    await clearToasts();
  });

  await T('U7c song menu (skeptic checks): a song switch closes it (its items act on the song it was opened on); '
    + 'Delete in the Mac app (simulated): a failed backup deletes nothing, a good one deletes after it', async () => {
    await toPerform();
    await settled();
    const s0 = await song();
    await page.click(tid('v6-songmenu-btn'));
    await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
    await ev(() => window.__rig.controller.nextSong());
    await until((id) => window.__rig.store.currentSong().id !== id, s0.id);
    await until(() => !document.querySelector('[data-testid="v6-songmenu"]'));
    await ev((id) => window.__rig.controller.selectSong(id), s0.id);
    await until((id) => window.__rig.store.currentSong().id === id, s0.id);
    await settled();
    // the Mac app's backup, simulated: ctx.rig.backupNow present, controller.backupNow failing then working
    const copyId = await ev((id) => window.__rig.store.duplicateSong(id), s0.id);
    await ev((id) => window.__rig.controller.selectSong(id), copyId);
    await until((id) => window.__rig.store.currentSong().id === id, copyId);
    await settled();
    await ev(() => {
      const { ctx, controller } = window.__rig;
      window.__u7cRig = { had: 'rig' in ctx, rig: ctx.rig, bn: controller.backupNow, calls: 0, fail: true };
      ctx.rig = { ...(ctx.rig || {}), backupNow: async () => ({ ok: true }) };
      controller.backupNow = async () => {
        window.__u7cRig.calls += 1;
        return window.__u7cRig.fail ? { error: 'disk full' } : { ok: true, file: 'x.json' };
      };
    });
    try {
      await page.click(tid('v6-songmenu-btn'));
      await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
      assert.match(await page.textContent(tid('v6-sm-delete')), /a backup of the library is made first/);
      await clearToasts();
      await hold(tid('v6-sm-delete'));
      await until(() => /Could not make a backup first/.test(document.getElementById('toasts').innerText));
      assert.equal(await ev(() => window.__u7cRig.calls), 1);
      assert.ok(await ev((id) => !!window.__rig.store.getSong(id), copyId), 'nothing deleted without the backup');
      await ev(() => {
        window.__u7cRig.fail = false;
      });
      await page.click(tid('v6-songmenu-btn'));
      await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
      await hold(tid('v6-sm-delete'));
      await until((id) => !window.__rig.store.getSong(id), copyId);
      assert.equal(await ev(() => window.__u7cRig.calls), 2);
      await until(() => /Import latest backup/.test(document.getElementById('toasts').innerText));
    } finally {
      await ev(() => {
        const { ctx, controller } = window.__rig;
        const o = window.__u7cRig;
        if (o.had) ctx.rig = o.rig;
        else delete ctx.rig;
        controller.backupNow = o.bn;
      });
    }
    await ev((id) => window.__rig.controller.selectSong(id), s0.id);
    await until((id) => window.__rig.store.currentSong().id === id, s0.id);
    await settled();
    await clearToasts();
  });

  await T('U7c screens: 820×1180 (learn, arrange, save snapshot, song menu)', async () => {
    await toPerform();
    await setSlots(3);
    await page.setViewportSize({ width: 820, height: 1180 });
    try {
      await page.waitForTimeout(300);
      await ev(() => window.__rig.views.v6.learn.enter({ target: 'slots.1.gain' }));
      await inject([0xb0, 40, 1]);
      await until(() => !!window.__rig.store.get().settings.midiLearn?.['slots.1.gain']);
      await ev(() => window.__rig.views.v6.learn.enter({ target: 'slots.0.gain' }));
      await page.waitForTimeout(200);
      await shot('u7c-learn-820.png');
      await ev(() => window.__rig.views.v6.learn.exit());
      await page.click(tid('v6-arrange'));
      await until(() => window.__rig.views.v6.arrange.active);
      await page.waitForTimeout(200);
      await shot('u7c-arrange-820.png');
      await page.click(tid('v6-arrange-done'));
      await page.click(tid('v6-snap-save'));
      await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
      await shot('u7c-savesnap-820.png');
      await page.keyboard.press('Escape');
      await page.click(tid('v6-songmenu-btn'));
      await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
      await shot('u7c-songmenu-820.png');
      await page.keyboard.press('Escape');
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(() => window.__rig.store.set('settings.midiLearn', {}));
    }
  });
}
