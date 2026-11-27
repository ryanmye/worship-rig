// D26.1 (U-SNAP) views, flag on: under a snapshot that holds the Space room, the drone's ON / sound and key, the v6
// controls show what plays (the snapshot) and a tap on them goes on top of the snapshot (controller.scenes.take /
// adjust): heard (the engine), the song NOT written, dropped at the next snapshot change, kept by Update. The song
// bar's Space picker, the sidebar Drone module (ON tile, key grid, Major / Minor), a strip's Space step and v6 Edit ›
// Effects. Run from run.mjs on its page (the v6 Perform is on).

/** The page-side setup: the song's own room Stage + Synth drone; snapshot 1 = Hall, the drone two keys up. */
export const HALL_SCENE = () => {
  const { store, controller } = window.__rig;
  const s = store.currentSong();
  const id = s.id;
  controller.scenes.go(null);
  const stage = { size: 0.42, damp: 0.5, predelay: 0.025, returnGain: 1.0 };
  for (const [k, v] of Object.entries(stage)) store.set(`songs.${id}.patch.fx.reverb.${k}`, v);
  store.set(`songs.${id}.drone.mode`, 'synth');
  const up2 = (s.hearIn + 2) % 12;
  store.set(`songs.${id}.scenes`, [{
    slots: [], drone: { mode: 'synth', key: { pc: up2, minor: false } },
    fx: { reverb: { size: 0.65, damp: 0.45, predelay: 0.035, returnGain: 1.15 } },
  }]);
  return { id, up2, own: s.hearIn };
};

/** What is heard, what the song holds, what the engine plays (page side). */
export const HEARD = () => {
  const { store, controller, engine } = window.__rig;
  const s = store.currentSong();
  const v = controller.scenes.view(s);
  return {
    viewSize: v.patch.fx.reverb.size, ownSize: s.patch.fx.reverb.size, engineSize: engine.getParam('fx.reverb.size'),
    viewKey: v.hearIn, ownKey: s.hearIn, engineKey: engine.drone?.key?.pc ?? null,
    viewMode: v.drone.mode, ownMode: s.drone.mode, engineMode: engine.drone?.cfg?.mode ?? null,
    viewSend: v.patch.slots[0]?.sends?.reverb, ownSend: s.patch.slots[0]?.sends?.reverb,
    json: JSON.stringify(s), scene: JSON.stringify(s.scenes?.[0] || null), n: controller.scenes.state().n,
  };
};

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, song, settled, assert}
 */
export async function snapTests(x) {
  const { T, page, ev, until, tid, settled, assert } = x;
  const setup = async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    const r = await ev(HALL_SCENE);
    await settled();
    await ev(() => window.__rig.controller.scenes.go(0));
    await settled();
    return r;
  };

  await T('D26.1 v6: under snapshot "Hall" (song’s own room Stage) the song bar shows Hall; tapping Stage is heard, '
    + 'the song is not written; the next snapshot change drops it; Update keeps it', async () => {
    await setup();
    let h = await ev(HEARD);
    assert.deepEqual([h.viewSize, h.ownSize, h.engineSize], [0.65, 0.42, 0.65], 'Hall plays over the song’s Stage');
    assert.equal(await page.textContent('.v6-space-t'), 'Hall', 'the song bar shows what plays');
    const before = h.json;
    await page.click(tid('v6-space'));
    await page.waitForSelector(tid('v6-space-pop'));
    assert.equal(await page.getAttribute(tid('v6-room-hall'), 'aria-pressed'), 'true');
    await page.click(tid('v6-room-stage'));
    await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.42);
    h = await ev(HEARD);
    assert.equal(h.viewSize, 0.42, 'heard');
    assert.equal(h.json, before, 'the song is NOT written');
    assert.equal(JSON.parse(h.scene).fx.reverb.size, 0.65, 'the snapshot is not rewritten');
    await until(() => document.querySelector('.v6-space-t')?.textContent === 'Stage');
    // the next snapshot change drops the move
    await ev(() => {
      window.__rig.controller.scenes.go(null);
      window.__rig.controller.scenes.go(0);
    });
    await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.65);
    // Update keeps it
    await page.click(tid('v6-space'));
    await page.click(tid('v6-room-stage'));
    await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.42);
    assert.equal(await ev(() => window.__rig.controller.scenes.save(0)), true);
    h = await ev(HEARD);
    assert.equal(JSON.parse(h.scene).fx.reverb.size, 0.42, 'Update keeps the tap');
    assert.equal(h.ownSize, 0.42);
  });

  await T('D26.1 v6: the Drone module shows the snapshot’s key / ON; a key tap and the ON tile are heard, the song '
    + 'is not written', async () => {
    const { up2, own } = await setup();
    await ev(() => window.__rig.views.v6.sidebar.open('drone'));
    await page.waitForSelector(tid('v6-drone-keys'));
    let h = await ev(HEARD);
    assert.deepEqual([h.viewKey, h.ownKey, h.engineKey], [up2, own, up2]);
    assert.equal(await ev((pc) => document.querySelector(
      `[data-testid="v6-drone-keys"] .key-btn[data-pc="${pc}"]`)?.getAttribute('aria-checked'), up2), 'true',
    'the key grid shows the snapshot’s key');
    const before = h.json;
    const up4 = (own + 4) % 12;
    await page.click(`[data-testid="v6-drone-keys"] .key-btn[data-pc="${up4}"]`);
    await until((pc) => window.__rig.engine.drone?.key?.pc === pc, up4);
    h = await ev(HEARD);
    assert.equal(h.viewKey, up4, 'heard');
    assert.equal(h.json, before, 'the song’s key is NOT written');
    // Major / Minor
    await page.click('[data-testid="v6-drone-quality"] .seg[data-value="true"]');
    await until(() => window.__rig.engine.drone?.key?.minor === true);
    assert.equal((await ev(HEARD)).json, before, 'minor: not written');
    // the ON tile: off, then on again
    await page.click(tid('v6-drone-on'));
    await until(() => window.__rig.engine.drone?.cfg?.mode === 'off');
    h = await ev(HEARD);
    assert.deepEqual([h.viewMode, h.ownMode], ['off', 'synth']);
    assert.equal(h.json, before, 'the ON tile: not written');
    await page.click(tid('v6-drone-on'));
    await until(() => window.__rig.engine.drone?.cfg?.mode === 'synth');
    assert.equal((await ev(HEARD)).json, before);
    // the next change: the snapshot's key again
    await ev(() => {
      window.__rig.controller.scenes.go(null);
      window.__rig.controller.scenes.go(0);
    });
    await until((pc) => window.__rig.engine.drone?.key?.pc === pc && window.__rig.engine.drone.key.minor === false, up2);
    await ev(() => window.__rig.controller.scenes.go(null));
  });

  await T('D26.1 v6: a strip’s Space and v6 Edit › Effects under a snapshot that holds them: heard, not written',
    async () => {
      await setup();
      // the snapshot holds Keys' Space send at 0.9
      await ev(() => {
        const { store, controller } = window.__rig;
        const s = store.currentSong();
        const sc = s.scenes[0];
        store.set(`songs.${s.id}.scenes`, [{ ...sc, slots: [{ gain: s.patch.slots[0].gain, sends: { reverb: 0.9 } }] }]);
        controller.scenes.go(null);
        controller.scenes.go(0);
      });
      await settled();
      let h = await ev(HEARD);
      assert.equal(h.viewSend, 0.9);
      const before = h.json;
      // the strip's write path (strip.js → v.setSlot), as the Space step panel calls it
      await ev(() => window.__rig.views.v6.chartMounts.v6.v.setSlot(0, 'sends.reverb', 0.2));
      h = await ev(HEARD);
      assert.equal(h.viewSend, 0.2, 'heard');
      assert.equal(h.json, before, 'not written');
      // v6 Edit › Effects: the room choices show Hall; Stage is heard, not written
      await ev(() => window.__rig.ctx.setView('edit'));
      await until(() => document.body.dataset.view === 'edit');
      await ev(() => window.__rig.views.edit.editState.select('effects'));
      await page.waitForSelector(tid('v6e-fx-space-stage'), { timeout: 10000 });
      assert.equal(await page.getAttribute(tid('v6e-fx-space-hall'), 'aria-pressed'), 'true', 'Edit shows Hall');
      await page.click(tid('v6e-fx-space-stage'));
      await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.42);
      assert.equal((await ev(HEARD)).json, before, 'Edit › Effects: not written');
      await until(() => document.querySelector('[data-testid="v6e-fx-space-stage"]')?.getAttribute('aria-pressed')
        === 'true');
      await ev(() => window.__rig.ctx.setView('perform'));
      await until(() => document.body.dataset.view === 'perform');
      await ev(() => window.__rig.controller.scenes.go(null));
    });

  await T('D26.1 name suggestion: only the Space / Echo / drone changed → "Hall", "Hall + Dotted Eighth", "Drone D"',
    async () => {
      const got = await ev(async () => {
        const { suggestSnapshotName } = await import('/js/views/v6/dialogs.js');
        const names = { name: (r) => r.id };
        const slot = (g) => ({ instrument: { id: 'pad' }, gain: g, sends: {} });
        const fx = (r, d) => ({ reverb: r, delay: d });
        const stage = { size: 0.42, damp: 0.5, predelay: 0.025, returnGain: 1.0 };
        const hall = { size: 0.65, damp: 0.45, predelay: 0.035, returnGain: 1.15 };
        const none = { returnGain: 0, time: 0.4, feedback: 0.3, pingpong: false, tone: 0.5, sync: 'off' };
        const dotted = { sync: '1/8d', feedback: 0.38, pingpong: true, tone: 0.45, returnGain: 0.9, time: 0.4 };
        const song = (r, d, drone = { mode: 'synth', gain: 0.5 }, hearIn = 0, g = 0.8) => ({
          hearIn, minor: false, patch: { slots: [slot(g)], fx: fx(r, d) }, drone });
        const own = song(stage, none);
        return [
          suggestSnapshotName(song(hall, none), own, names),
          suggestSnapshotName(song(hall, dotted), own, names),
          suggestSnapshotName(song(stage, none, { mode: 'synth', gain: 0.5 }, 2), own, names),
          suggestSnapshotName(song(stage, none, { mode: 'off', gain: 0.5 }), own, names),
          suggestSnapshotName(song(hall, none), own, names, ['Hall']),
          suggestSnapshotName(song(hall, none, undefined, 0, 0.2), own, names), // a level moved too: levels name it
        ];
      });
      assert.deepEqual(got, ['Hall', 'Hall + Dotted Eighth', 'Drone D', 'Drone off', 'Hall 2', 'pad, softer']);
    });
}
