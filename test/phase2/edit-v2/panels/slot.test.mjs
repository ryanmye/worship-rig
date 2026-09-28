// OWNER: slot agent (views/edit/CONTRACT.md §6). Tests for panels/slot.js (the H-v2 sound panel).
// Run alone: node test/phase2/edit-v2/run.mjs --only slot
// (or node --test --test-reporter=spec <this file>). The harness smoke test stays first. The ui-edit tests the §6
// checklist assigns to "slot" are ported here (their names are quoted in each test's comments).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

// One page for every single-panel test (a boot costs 20–60 s on the shared 2-CPU box, and run.mjs's
// --test-timeout also caps the whole file); each test starts from a freshly selected song (fresh()), which also
// resets the "since the song was loaded" baseline. The layout test mounts the full view once.
let shared = null;
after(async () => {
  await shared?.close();
  await shutdown();
});
/** The shared single-panel page (slot panel, starting on Pad). */
const page = async () => shared || (shared = await mountPanelForTest('slot', { panelOpts: { slot: 1 } }));
/** Select `id` through another song so its baseline is re-taken; then show block `block`. */
async function fresh(t, id, block, opts) {
  const cur = await t.ev(() => window.__rig.store.currentSong().id);
  const target = await t.ev((x) => {
    const st = window.__rig.store.get();
    return st.songOrder.find((k) => k === x || st.songs[k].factoryId === x);
  }, id);
  if (cur === target) await t.selectSong('factory:rhodes');
  await t.selectSong(target);
  await t.ev(() => document.activeElement?.blur?.());
  if (block) await t.select(block, opts);
  await t.sleep(50);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const bindSel = (t, addr) => `${t.host} [data-bind="${addr}"]`;
const rangeOf = (t, addr) => `${bindSel(t, addr)} input[type=range]`;
const title = (t) => t.page.textContent('#view-edit .ev2-title .ev2-sent');
/**
 * Page-side source of "the slot EQ's low shelf dB" (hv2-edit-integrate: Warmth writes the EQ's low shelf through
 * eq-math shelfWrites, i.e. b1 rows after the first write; a slot with no b1 rows still reads the legacy eq.low).
 */
const LOW_SHELF = `(id) => {
  const st = window.__rig.store;
  const eq = ((id ? st.getSong(id) : st.currentSong()).patch.slots[0] || {}).eq || {};
  return eq.b1 && eq.b1.db !== undefined ? eq.b1.db : (eq.low ?? 0);
}`;
/** Wait until the low shelf of slot 0 (of song `id`, default current) satisfies `test` ('> 3.01', '=== 0', …). */
const untilLowShelf = (t, cond, id = null) =>
  t.until(([src, c, x]) => new Function('x', `return (${src})(x) ${c};`)(x), [LOW_SHELF, cond, id]);
const openSec = (t, ...ids) => t.ev((list) => {
  for (const id of list) for (const d of document.querySelectorAll(`details.ev2-sec[data-sec="${id}"]`)) d.open = true;
}, ids).then(() => t.sleep(40));
/** Count controller 'panic' actions from now on. */
const panicCounter = (t) => t.ev(() => {
  if (!window.__panics) {
    window.__panics = { n: 0 };
    window.__rig.controller.addEventListener('action', (e) => {
      if (e.detail && e.detail.type === 'panic') window.__panics.n += 1;
    });
  }
  return window.__panics.n;
});
/** Two songs of the current list with a slot 0 of the same instrument (makes one when the library has none). */
const sameInstrumentPair = (t) => t.ev(() => {
  const st = window.__rig.store;
  const ids = st.navIds().filter((id) => st.getSong(id)?.patch.slots[0]);
  const key = (id) => JSON.stringify(st.getSong(id).patch.slots[0].instrument);
  const cur = st.currentSong().id;
  for (const y of ids) if (y !== cur && key(y) === key(cur)) return [cur, y];
  const other = ids.find((x) => x !== cur);
  st.set(`songs.${other}.patch.slots.0.instrument`, st.getSong(cur).patch.slots[0].instrument);
  return [cur, other];
});

test('slot: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  const t = await page();
  await smoke(t);
  await t.screenshot('slot-1440');
});

test('slot: sentence title (tokens jump, changed dots), sub-line, THE SOUND ITSELF sliders, change count', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    assert.match(await title(t), /^KEYS plays .+ on every key, .*sustain on$/);
    assert.match(await t.page.textContent('#view-edit .ev2-title .ev2-title-sub'),
      /sampled.* · click an underlined word to jump to its control$/);
    assert.equal(await t.page.textContent('#view-edit .ev2-title .ev2-slot-chg'), 'Change instrument');
    assert.equal(await t.ev(() => document.querySelectorAll('#view-edit .ev2-title .ev2-cdi').length), 0);
    assert.match(await t.page.textContent(`${t.host} .ev2-slot-chgline`), /^No switch changes since the song was loaded$/);
    assert.ok(await t.page.$(`${t.host} .ev2-slot-chgline.none`));

    // a watched change: the word appears with a dot, the Octave chip gets its dot, the footer counts it
    await t.setParam('slots.0.octave', 1);
    await t.until(() => /an octave up/.test(document.querySelector('#view-edit .ev2-title .ev2-sent').textContent));
    const dots = await t.ev(() => {
      const s = document.querySelector('#view-edit .ev2-title .ev2-sent');
      return [...s.querySelectorAll('.ev2-cdi')].map((d) => d.nextElementSibling?.textContent);
    });
    assert.deepEqual(dots, ['an octave up']);
    await t.until((sel) => !document.querySelector(`${sel} .cdi`).hidden, bindSel(t, 'slots.0.octave'));
    assert.equal(await t.page.textContent(`${t.host} .ev2-slot-chgline`), '1 change since the song was loaded');
    assert.equal(await t.page.$(`${t.host} .ev2-slot-chgline.none`), null);
    // faders and levels never get a dot
    await t.setParam('slots.0.gain', 0.5);
    await t.sleep(80);
    assert.equal(await t.page.textContent(`${t.host} .ev2-slot-chgline`), '1 change since the song was loaded');

    // tokens jump to (focus + flash) their control
    await t.click('#view-edit .ev2-title .ev2-tok:has-text("an octave up")');
    await t.until((sel) => document.querySelector(sel).classList.contains('ev2-flash'), bindSel(t, 'slots.0.octave'));
    assert.equal(await t.ev(() => document.activeElement?.dataset.bind), 'slots.0.octave');
    await t.click('#view-edit .ev2-title .ev2-tok:has-text("every key")');
    await t.until((h) => document.querySelector(`${h} .ev2-slot-range`).classList.contains('ev2-flash'), t.host);
    await t.click('#view-edit .ev2-title .ev2-sent .ev2-tok >> nth=-1'); // "on" (sustain)
    await t.until((sel) => document.querySelector(sel).classList.contains('ev2-flash'), bindSel(t, 'slots.0.sustain'));
    await t.ev(() => document.activeElement?.blur());
    await t.setParam('slots.0.octave', 0);
    await t.until(() => !/octave/.test(document.querySelector('#view-edit .ev2-title .ev2-sent').textContent));
    assert.ok(await t.page.$(`${t.host} .ev2-slot-chgline.none`));

    // muted / range / dry words
    await t.setParam('slots.0.muted', true);
    await t.setParam('slots.0.lowNote', 48);
    await t.setParam('slots.0.highNote', 72);
    await t.setParam('slots.0.sends.reverb', 0);
    await t.until(() => /^KEYS is switched off, but plays .+ on C3 to C5, dry, sustain on$/
      .test(document.querySelector('#view-edit .ev2-title .ev2-sent').textContent));
    await t.setParam('slots.0.muted', false);
    await t.setParam('slots.0.lowNote', 0);
    await t.setParam('slots.0.highNote', 127);
    await t.setParam('slots.0.sends.reverb', 0.25);

    // THE SOUND ITSELF: three word sliders from smartSlidersFor(meta), each bound to one valid PARAMS path
    const smart = await t.ev(async (host) => {
      const sc = await import('/app/js/shared/smart-controls.js');
      const { isValidPath } = await import('/app/js/shared/params.js');
      const els = [...document.querySelectorAll(`${host} .ev2-slot-snd .ev2-ws[data-smart]`)];
      const meta = window.__rig.panelCtx.findInstrument(window.__rig.store.currentSong().patch.slots[0].instrument);
      const want = sc.smartSlidersFor(meta).map((s) => sc.slotPath(s, 0));
      // every instrument the engine lists gets 3 sliders on valid paths (the browser half of the node:test)
      const all = window.__rig.engine.listInstruments().map((m) => sc.smartSlidersFor(m).map((s) => sc.slotPath(s, 1)));
      return {
        binds: els.map((e) => e.dataset.bind), roles: els.map((e) => e.dataset.smart), want,
        words: els.map((e) => e.querySelector('.ev2-ws-word').textContent),
        allOk: all.every((l) => l.length === 3 && l.every(isValidPath)), n: all.length,
      };
    }, t.host);
    assert.deepEqual(smart.binds, smart.want);
    assert.deepEqual(smart.roles.slice(0, 2), ['brightness', 'warmth']);
    assert.ok(smart.words.every((w) => w.length > 0), smart.words.join(','));
    assert.ok(smart.allOk && smart.n > 20, `listInstruments: ${smart.n}`);
    // Warmth = the EQ's low shelf (bipolar; hook data-bind="slots.0.eq.low"): 750/1000 → +6 dB, written through
    // eq-math shelfWrites (b1 rows, the legacy eq.low zeroed), the engine follows, the word follows, double-click resets
    await t.setRange(rangeOf(t, 'slots.0.eq.low'), 750);
    await untilLowShelf(t, '> 5.95');
    await t.untilEngine('slots.0.eq.b1.db', 6, 0.05);
    assert.equal(await t.ev(() => window.__rig.store.currentSong().patch.slots[0].eq.b1.type), 'lowshelf');
    assert.ok(!(await t.ev(() => window.__rig.store.currentSong().patch.slots[0].eq.low)), 'legacy eq.low not doubled');
    assert.equal(await t.page.textContent(`${bindSel(t, 'slots.0.eq.low')} .ev2-ws-val`), 'Full+6.0 dB');
    await t.page.dblclick(rangeOf(t, 'slots.0.eq.low'));
    await untilLowShelf(t, '=== 0');
    // the first (Brightness) slider writes its instrument param and the engine follows
    const b0 = smart.binds[0];
    await t.setRange(rangeOf(t, b0), 300);
    const got = await t.ev((a) => {
      const { store } = window.__rig;
      const p = a.split('.').slice(2);
      let o = store.currentSong().patch.slots[0];
      for (const k of p) o = o?.[k];
      return o;
    }, b0);
    assert.ok(Number.isFinite(got), `${b0} written (${got})`);
    await t.untilEngine(b0, got, 1e-6);
    await t.page.dblclick(rangeOf(t, b0));
    t.assertNoConsoleErrors();
  }
});

test('slot: Change instrument menu, change → engine, Remove (confirm + Undo), empty slot → fill', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    const p0 = await panicCounter(t);
    // ui-edit "instrument picker lists engine instruments by group" + "picker groups: engine group order"
    await t.click('#view-edit .ev2-slot-chg');
    await t.until(() => !document.querySelector('#view-edit .ev2-slot-menu').hidden);
    const m = await t.ev(() => {
      const menu = document.querySelector('#view-edit .ev2-slot-menu');
      const list = window.__rig.engine.listInstruments();
      const items = [...menu.querySelectorAll('.ev2-slot-mi[data-value]')];
      return {
        role: menu.getAttribute('role'),
        groups: [...menu.querySelectorAll('.ev2-slot-mg')].map((g) => g.getAttribute('aria-label')),
        values: items.map((b) => b.dataset.value),
        list: list.filter((x) => x.ref.id !== 'drone-osc' && !x.hidden).length,
        brass: list.filter((x) => x.group === 'Brass & Leads').map((x) => `${x.ref.type}:${x.ref.id}`).sort(),
        inBrass: [...menu.querySelectorAll('.ev2-slot-mg[aria-label="Brass & Leads"] .ev2-slot-mi')]
          .map((b) => b.dataset.value).sort(),
        focused: document.activeElement?.getAttribute('aria-checked'),
        remove: !!menu.querySelector('[data-action="remove"]'),
        dialog: document.body.hasAttribute('data-dialog-open'),
        expanded: document.querySelector('#view-edit .ev2-slot-chg').getAttribute('aria-expanded'),
      };
    });
    assert.equal(m.role, 'menu');
    assert.equal(m.values.length, m.list, 'every offered instrument, once');
    assert.ok(!m.values.includes('synth:drone-osc'), 'the drone voice is not offered');
    assert.ok(['Piano', 'Synth Pads', 'Organ'].every((g) => m.groups.includes(g)), m.groups.join());
    if (m.brass.length) {
      assert.ok(m.groups.indexOf('Brass & Leads') > m.groups.indexOf('Synth Keys'), m.groups.join());
      assert.ok(m.groups.indexOf('Brass & Leads') < m.groups.indexOf('Mallets & Bells'), m.groups.join());
      assert.deepEqual(m.inBrass, m.brass);
    }
    if (m.groups.includes('My Samples')) assert.equal(m.groups.at(-1), 'My Samples');
    assert.equal(m.focused, 'true', 'opening focuses the current instrument');
    assert.ok(m.remove && m.dialog);
    assert.equal(m.expanded, 'true');
    // ↓ moves between items (and never nudges the wheel); Esc closes and returns focus to the button, no panic
    const before = await t.ev(() => document.activeElement.dataset.value);
    await t.page.keyboard.press('ArrowDown');
    assert.notEqual(await t.ev(() => document.activeElement.dataset.value), before);
    await t.page.keyboard.press('End');
    assert.equal(await t.ev(() => document.activeElement.dataset.action), 'remove');
    await t.page.keyboard.press('Home');
    await t.page.keyboard.press('Escape');
    await t.until(() => document.querySelector('#view-edit .ev2-slot-menu').hidden);
    assert.ok(await t.ev(() => document.activeElement.classList.contains('ev2-slot-chg')));
    assert.equal(await panicCounter(t), p0, 'Esc never panics in Edit');
    // the shell keeps its own 'edit-esc' token up until the Esc event is done (a setTimeout 0); ours is gone at once
    assert.ok(!(await t.ev(() => [...(globalThis.__rigOpenDialogs || [])])).some((k) => /slot/.test(k)));
    await t.until(() => !document.body.hasAttribute('data-dialog-open'), null, 5000);
    // an outside click closes it too
    await t.click('#view-edit .ev2-slot-chg');
    await t.page.mouse.click(5, 895);
    await t.until(() => document.querySelector('#view-edit .ev2-slot-menu').hidden);

    // ui-edit "instrument change → engine slot instrument changes, card rebuilt, sound plays"
    await t.ev((h) => {
      document.querySelector(`${h} .ev2-slot-filled`).__mark = 1;
    }, t.host);
    await t.click('#view-edit .ev2-slot-chg');
    await t.click('#view-edit .ev2-slot-mi[data-value="synth:soft-keys"]');
    await t.until(() => window.__rig.engine.slots[0]?.ref.id === 'soft-keys', null, 30000);
    assert.deepEqual((await t.song()).patch.slots[0].instrument, { type: 'synth', id: 'soft-keys' });
    await t.until((h) => !document.querySelector(`${h} .ev2-slot-filled`).__mark, t.host);
    await t.until(() => /^KEYS plays Soft Keys/.test(document.querySelector('#view-edit .ev2-sent').textContent));
    assert.match(await t.page.textContent(`${t.host} .ev2-slot-adv-h`), /Soft Keys settings/);
    await t.until(() => !window.__rig.controller.status.loading, null, 30000);
    const db = await t.playAndMeasure(60);
    assert.ok(db > -50, `soft-keys RMS ${db.toFixed(1)} dBFS`);
    // the instrument word carries the changed dot
    await t.until(() => /Soft Keys/.test([...document.querySelectorAll('#view-edit .ev2-title .ev2-cdi')]
      .map((d) => d.nextElementSibling?.textContent).join()));

    // Remove this sound… → confirm (Cancel focused, nothing changes yet); Esc cancels without panic
    const slotBefore = (await t.song()).patch.slots[0];
    await t.click('#view-edit .ev2-slot-chg');
    await t.click('#view-edit .ev2-slot-mi[data-action="remove"]');
    await t.until((h) => !document.querySelector(`${h} .ev2-slot-confirm`).hidden, t.host);
    assert.equal(await t.page.getAttribute(`${t.host} .ev2-slot-confirm`, 'role'), 'alertdialog');
    assert.ok(await t.ev(() => document.activeElement.classList.contains('ev2-slot-cancel')), 'Cancel focused');
    assert.ok(await t.ev(() => document.body.hasAttribute('data-dialog-open')));
    assert.deepEqual((await t.song()).patch.slots[0], slotBefore, 'nothing changes before the confirm');
    await t.page.keyboard.press('Escape');
    await t.until((h) => document.querySelector(`${h} .ev2-slot-confirm`).hidden, t.host);
    assert.equal(await panicCounter(t), p0);
    await t.until(() => !document.body.hasAttribute('data-dialog-open'), null, 5000);
    // confirm → slot null, engine slot gone, empty body with Undo; the toast carries an Undo action
    await t.ev(() => {
      const c = window.__rig.ctx;
      const orig = c.toast;
      window.__toastCalls = [];
      c.toast = (msg, kind, opts) => {
        window.__toastCalls.push({ msg, kind, action: opts && opts.action ? opts.action.label : null });
        window.__undoRun = opts && opts.action ? opts.action.run : null;
        return orig(msg, kind, opts);
      };
    });
    await t.click('#view-edit .ev2-slot-chg');
    await t.click('#view-edit .ev2-slot-mi[data-action="remove"]');
    await t.click(`${t.host} .ev2-slot-remove`);
    await t.until(() => window.__rig.store.currentSong().patch.slots[0] === null && !window.__rig.engine.slots[0]);
    await t.until((h) => !!document.querySelector(`${h} .ev2-slot-empty`), t.host);
    assert.match(await title(t), /^KEYS is empty\. Add a sound$/);
    assert.equal(await t.page.textContent('#view-edit .ev2-title .ev2-slot-chg'), 'Add a sound');
    const calls = await t.ev(() => window.__toastCalls);
    assert.equal(calls.length, 1);
    assert.match(calls[0].msg, /Soft Keys removed from Keys/);
    assert.equal(calls[0].action, 'Undo');
    await t.until((h) => !document.querySelector(`${h} .ev2-slot-undo`).hidden, t.host);
    await t.click(`${t.host} .ev2-slot-undo-btn`);
    await t.until(() => !!window.__rig.store.currentSong().patch.slots[0]);
    assert.deepEqual((await t.song()).patch.slots[0], slotBefore, 'Undo writes the captured slot back');
    await t.until(() => window.__rig.engine.slots[0]?.ref.id === 'soft-keys', null, 30000);
    assert.equal(await t.ev(() => window.__undoRun()), false, 'the toast Undo does nothing once the sound is back');

    // ui-edit "empty a slot and fill it again (defaultSlot)": Extra (empty in this song) → bell, role default sends
    await t.setParam('slots.2', null);
    await t.select('slot:2', { focus: 'instrument' });
    await t.until(() => !document.querySelector('#view-edit .ev2-slot-menu').hidden);
    assert.match(await title(t), /^EXTRA is empty\. Add a sound$/);
    assert.ok(await t.page.$(`${t.host} .ev2-slot[data-slot="2"] .ev2-slot-empty`));
    await t.click('#view-edit .ev2-slot-mi[data-value="synth:bell"]');
    await t.until(() => window.__rig.engine.slots[2] && window.__rig.engine.slots[2].ref.id === 'bell', null, 30000);
    const s2 = (await t.song()).patch.slots[2];
    assert.equal(s2.sends.delay, 0.2); // Extra role default
    assert.ok(await t.page.$(bindSel(t, 'slots.2.gain')));
    assert.equal(await t.ev(() => document.querySelectorAll('#view-edit [data-bind^="slots.0."]').length), 0,
      'update({slot}) left no Keys bindings behind');
    // a missing instrument shows "<id> (not available)" in the title and the menu
    await t.setParam('slots.2.instrument', { type: 'synth', id: 'no-such-synth' });
    await t.until(() => /no-such-synth \(not available\)/
      .test(document.querySelector('#view-edit .ev2-sent').textContent));
    assert.match(await t.page.textContent(`${t.host} .ev2-slot-inst-hint`),
      /Instrument details appear once sound has started/);
    await t.click('#view-edit .ev2-slot-chg');
    assert.match(await t.page.textContent('#view-edit .ev2-slot-mi[aria-checked="true"]'),
      /no-such-synth \(not available\)/);
    await t.page.keyboard.press('Escape');
    await t.screenshot('slot-extra-missing');
    const errs = t.errors.filter((e) => !/no-such-synth/.test(e));
    assert.deepEqual(errs, []);
    t.errors.splice(0); // the shared page's later tests assert on their own errors only
    await t.setParam('slots.2', null);
  }
});

test('slot: ON STAGE — ON tile mute, fader, Space/Echo/Octave/Sustain/Chorus chips + dots, in place', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:1');
    // ui-edit "mute toggle (Slot.muted)": ON tile → engine gain 0, grey strip; back > 0
    const tile = `${t.host} .ev2-slot-os .ontile`;
    assert.equal(await t.page.getAttribute(tile, 'aria-pressed'), 'true');
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().patch.slots[1].muted === true
      && window.__rig.engine.getParam('slots.1.gain') === 0);
    assert.ok(await t.page.$(`${t.host} .ev2-slot-os.off .ontile.off[aria-pressed="false"]`));
    assert.ok(await t.page.$(`${bindSel(t, 'slots.1.gain')}.muted`), 'fader shows muted');
    await t.click(tile);
    await t.until(() => !window.__rig.store.currentSong().patch.slots[1].muted
      && window.__rig.engine.getParam('slots.1.gain') > 0);
    assert.equal(await t.page.$(`${t.host} .ev2-slot-os.off`), null);
    // ON tile computed colour = the slot colour, never the accent (ui-edit "M4")
    const col = await t.ev((sel) => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const resolve = (c) => {
        probe.style.color = '';
        probe.style.color = c;
        return getComputedStyle(probe).color;
      };
      const r = {
        want: resolve('var(--slot-1)'), accent: resolve('var(--accent)'),
        tile: getComputedStyle(document.querySelector(sel)).backgroundColor,
        c: resolve(getComputedStyle(document.querySelector('#view-edit .ev2-slot')).getPropertyValue('--c').trim()),
      };
      probe.remove();
      return r;
    }, tile);
    assert.equal(col.tile, col.want);
    assert.equal(col.c, col.want);
    assert.notEqual(col.want, col.accent);

    // ui-edit "slot fader → store (taper) → engine.getParam; keyboard; double-click reset"
    await t.setRange(rangeOf(t, 'slots.1.gain'), 600);
    await t.until(() => Math.abs(window.__rig.store.currentSong().patch.slots[1].gain - 2 * 0.6 ** 3) < 0.01);
    const g = await t.ev(() => [window.__rig.store.currentSong().patch.slots[1].gain,
      window.__rig.engine.getParam('slots.1.gain')]);
    assert.ok(near(g[0], g[1]), `store ${g[0]} engine ${g[1]}`);
    assert.match(await t.page.textContent(`${bindSel(t, 'slots.1.gain')} output`), /dB$/);
    await t.page.focus(rangeOf(t, 'slots.1.gain'));
    await t.page.keyboard.press('ArrowUp');
    await t.until((prev) => window.__rig.store.currentSong().patch.slots[1].gain > prev + 1e-4, g[0]);
    await t.ev(() => document.activeElement.blur());
    await t.page.dblclick(rangeOf(t, 'slots.1.gain'));
    await t.until(() => Math.abs(window.__rig.engine.getParam('slots.1.gain') - 0.8) < 1e-9);

    // Space chip → the step panel opens inside the On-stage column; a step writes the send (store + engine) + dot
    const space = bindSel(t, 'slots.1.sends.reverb');
    await t.click(space);
    await t.until((h) => !!document.querySelector(`${h} .ev2-slot-os > .step-panel`), t.host);
    const inside = await t.ev((h) => {
      const col = document.querySelector(`${h} .ev2-slot-os`).getBoundingClientRect();
      const p = document.querySelector(`${h} .ev2-slot-os > .step-panel`).getBoundingClientRect();
      return p.top >= col.top - 1 && p.bottom <= col.bottom + 1 && p.left >= col.left - 8 && p.right <= col.right + 8;
    }, t.host);
    assert.ok(inside, 'step panel stays in the On-stage column');
    await t.click(`${t.host} .step-panel .sp-step[data-value="0.75"]`);
    await t.untilEngine('slots.1.sends.reverb', 0.75, 1e-6);
    assert.equal(await t.readParam('slots.1.sends.reverb'), 0.75);
    await t.until((s) => !document.querySelector(`${s} .cdi`).hidden, space);
    assert.equal(await t.page.$(`${t.host} .step-panel`), null, 'a tap on a step closes the panel');
    // Echo by keyboard arrows on the focused chip (never reaching song nav)
    const songBefore = await t.ev(() => window.__rig.store.currentSong().id);
    await t.setParam('slots.1.sends.delay', 0.25); // a step value: ↑ goes to the next step (0.5)
    await t.page.focus(bindSel(t, 'slots.1.sends.delay'));
    const d0 = await t.readParam('slots.1.sends.delay');
    await t.page.keyboard.press('ArrowUp');
    await t.until((v) => window.__rig.store.currentSong().patch.slots[1].sends.delay > v, d0);
    assert.equal(await t.ev(() => window.__rig.store.currentSong().id), songBefore);
    await t.ev(() => document.activeElement.blur());
    // Octave: steps −2..+2 with the "next note" footnote; engine follows
    await t.click(bindSel(t, 'slots.1.octave'));
    assert.match(await t.page.textContent(`${t.host} .step-panel .sp-foot`), /Starts on your next note/);
    assert.equal(await t.ev((h) => document.querySelectorAll(`${h} .step-panel .sp-step`).length, t.host), 5);
    await t.click(`${t.host} .step-panel .sp-step[data-value="1"]`);
    await t.untilEngine('slots.1.octave', 1);
    // Sustain: a 2-step chip, a tap cycles
    const sus0 = await t.engineParam('slots.1.sustain');
    await t.click(bindSel(t, 'slots.1.sustain'));
    await t.untilEngine('slots.1.sustain', !sus0);
    assert.equal(await t.page.getAttribute(bindSel(t, 'slots.1.sustain'), 'aria-pressed'), String(!sus0));
    // the wide Chorus chip
    await t.click(bindSel(t, 'slots.1.sends.chorus'));
    await t.click(`${t.host} .step-panel .sp-step[data-value="0.25"]`);
    await t.untilEngine('slots.1.sends.chorus', 0.25, 1e-6);
    assert.ok(await t.page.$(`${t.host} .ev2-slot-mods .mchip.ev2-slot-wide[data-bind="slots.1.sends.chorus"]`));
    // Esc closes an open step panel and never panics
    const p0 = await panicCounter(t);
    await t.click(bindSel(t, 'slots.1.sends.delay'));
    await t.until((h) => !!document.querySelector(`${h} .step-panel`), t.host);
    await t.page.keyboard.press('Escape');
    await t.until((h) => !document.querySelector(`${h} .step-panel`), t.host);
    assert.equal(await panicCounter(t), p0);
    // setLoaded(baseline): each changed chip has its dot; restoring the loaded values clears them
    const chipDots = () => t.ev((h) => [...document.querySelectorAll(`${h} .ev2-slot-mods .mchip`)]
      .filter((c) => !c.querySelector('.cdi').hidden).map((c) => c.dataset.bind).sort(), t.host);
    assert.deepEqual(await chipDots(), ['slots.1.octave', 'slots.1.sends.chorus', 'slots.1.sends.delay',
      'slots.1.sends.reverb', 'slots.1.sustain']);
    assert.equal(await t.page.textContent(`${t.host} .ev2-slot-chgline`), '5 changes since the song was loaded');
    await t.ev(() => {
      const base = window.__rig.view.editState.baseline.patch.slots[1];
      const st = window.__rig.store;
      for (const f of ['octave', 'sustain', 'sends.reverb', 'sends.delay', 'sends.chorus']) {
        st.set(`slots.1.${f}`, f.split('.').reduce((o, k) => o[k], base));
      }
    });
    await t.until((h) => [...document.querySelectorAll(`${h} .ev2-slot-mods .mchip .cdi`)].every((d) => d.hidden),
      t.host);

    // ui-edit "store → view updates in place (no rebuild on param change or song switch)"
    await t.ev((h) => {
      document.querySelector(`${h} .ev2-slot-filled`).__mark = 1;
      document.querySelector(`${h} [data-bind="slots.1.gain"]`).__mark = 1;
      window.__rig.store.set('slots.1.gain', 1);
    }, t.host);
    await t.until((sel) => Math.abs(Number(document.querySelector(sel).value) - Math.round(Math.cbrt(0.5) * 1000)) <= 1,
      rangeOf(t, 'slots.1.gain'));
    assert.equal(await t.ev((s) => document.querySelector(s).__mark, bindSel(t, 'slots.1.gain')), 1, 'fader kept');
    const target = await t.ev(() => {
      const st = window.__rig.store;
      const cur = st.currentSong();
      const k = JSON.stringify(cur.patch.slots[1].instrument);
      const ids = st.navIds().filter((id) => id !== cur.id && st.getSong(id).patch.slots[1]);
      const same = ids.find((id) => JSON.stringify(st.getSong(id).patch.slots[1].instrument) === k);
      if (same) return same;
      st.set(`songs.${ids[0]}.patch.slots.1.instrument`, cur.patch.slots[1].instrument);
      return ids[0];
    });
    await t.selectSong(target);
    await t.until((h) => document.querySelector(`${h} .ev2-slot-filled`).__mark === 1, t.host);
    const want = await t.ev(() => window.__rig.store.currentSong().patch.slots[1].gain);
    await t.until(([sel, w]) => Math.abs(Number(document.querySelector(sel).value) - Math.round(Math.cbrt(w / 2) * 1e3))
      <= 1,
      [rangeOf(t, 'slots.1.gain'), want]);
    assert.ok((await t.playAndMeasure(60)) > -60, 'switched song sounds');
    await t.screenshot('slot-onstage');
    t.assertNoConsoleErrors();
  }
});

test('slot: polish-1 — a level meter beside the fader follows the slot; a slot no longer shown stops reading',
  async () => {
  const t = await page();
  await fresh(t, 'factory:sunday-pad-piano', 'slot:1');
  const meter = (i) => `${t.host} [data-testid="ev2-slot-level-${i}"]`;
  const g = await t.ev(([sel]) => {
    const m = document.querySelector(sel);
    const r = m.getBoundingClientRect();
    const col = m.closest('.ev2-slot-fz').getBoundingClientRect();
    const inp = m.parentElement.querySelector('.fader-input').getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, right: r.right, colL: col.left, colR: col.right, inpH: inp.height,
      pe: getComputedStyle(m).pointerEvents, track: m.parentElement.classList.contains('fader-track') };
  }, [meter(1)]);
  assert.equal(g.w, 4, 'a 4 px bar');
  assert.ok(g.left >= g.colL && g.right <= g.colR + 0.5, `inside the 64 px fader column (${JSON.stringify(g)})`);
  assert.ok(g.track && g.pe === 'none' && g.h > g.inpH * 0.6, JSON.stringify(g));
  await t.ev(() => window.__rig.controller.perform.noteOn(60, 110));
  await t.until((sel) => {
    const c = document.querySelector(`${sel} .lvl-cover`);
    return c && Number(c.style.transform.replace(/[^0-9.]/g, '') || 1) < 0.9;
  }, meter(1));
  await t.ev(() => window.__rig.controller.perform.noteOff(60));
  // Keys selected: slot 1's meter is gone with its body; only slot 0 is read; slot 1's engine tap idles out
  await t.select('slot:0');
  await t.until((sel) => !!document.querySelector(sel), meter(0));
  assert.equal(await t.page.$(meter(1)), null);
  const per = await t.ev(async () => {
    const c = window.__rig.controller;
    const orig = c.slotLevel;
    const n = [0, 0, 0, 0];
    c.slotLevel = (i) => {
      n[i] += 1;
      return orig(i);
    };
    await new Promise((r) => setTimeout(r, 400));
    c.slotLevel = orig;
    return n;
  });
  assert.ok(per[0] > 3 && per[1] === 0 && per[2] === 0 && per[3] === 0, `reads per slot ${per}`);
  await t.until(() => !window.__rig.engine._slotTaps[1], null, 6000);
  t.assertNoConsoleErrors();
});

test('slot: round2-ui #2 — a fader drag still going at a song switch never writes into the new song', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    const [a, b] = await sameInstrumentPair(t);
    await t.ev(([x, y]) => {
      window.__rig.store.set(`songs.${x}.patch.slots.0.gain`, 0.5);
      window.__rig.store.set(`songs.${y}.patch.slots.0.gain`, 0.7);
    }, [a, b]);
    await t.selectSong(a);
    const loc = t.page.locator(rangeOf(t, 'slots.0.gain')).first();
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    // vertical fader: drag along y
    const x = box.x + box.width / 2;
    const y0 = box.y + box.height * 0.5;
    await t.page.mouse.move(x, y0);
    await t.page.mouse.down();
    await t.page.mouse.move(x, y0 - box.height * 0.15, { steps: 4 });
    await t.sleep(80);
    const midA = await t.ev((id) => window.__rig.store.getSong(id).patch.slots[0].gain, a);
    assert.notEqual(midA, 0.5, 'the drag moves A');
    await t.selectSong(b);
    await t.sleep(60);
    await t.page.mouse.move(x, y0 - box.height * 0.3, { steps: 4 });
    await t.page.mouse.up();
    await t.sleep(120);
    const g = await t.ev(([x1, y1]) => [window.__rig.store.getSong(x1).patch.slots[0].gain,
      window.__rig.store.getSong(y1).patch.slots[0].gain], [a, b]);
    assert.equal(g[1], 0.7, `B untouched (got ${g[1]})`);
    assert.equal(g[0], midA, 'A keeps the level dragged before the switch');
    const shown = await t.ev((sel) => Number(document.querySelector(sel).value), rangeOf(t, 'slots.0.gain'));
    assert.ok(Math.abs(shown - Math.round(Math.cbrt(0.7 / 2) * 1000)) <= 2, `fader shows B (pos ${shown})`);
    // the next drag works normally again
    await t.page.mouse.move(x, y0);
    await t.page.mouse.down();
    await t.page.mouse.move(x, y0 + box.height * 0.1, { steps: 3 });
    await t.page.mouse.up();
    await t.sleep(80);
    const gb = await t.ev((id) => window.__rig.store.getSong(id).patch.slots[0].gain, b);
    assert.notEqual(gb, 0.7, 'a fresh drag writes');
    t.assertNoConsoleErrors();
  }
});

test('slot: WHERE IT PLAYS — note fields, mini keyboard, Whole keyboard, Set lowest/highest…', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0', { focus: 'range' });
    // opts.focus 'range' on mount: the range block is flashed and its first control focused
    await t.until((h) => document.querySelector(`${h} .ev2-slot-range`).classList.contains('ev2-flash'), t.host);
    assert.ok(await t.ev((h) => document.querySelector(`${h} .ev2-slot-range`).contains(document.activeElement),
      t.host));
    await t.ev(() => document.activeElement.blur());
    // ui-edit "split: note fields + mini keyboard write lowNote/highNote"
    const low = bindSel(t, 'slots.0.lowNote');
    const high = bindSel(t, 'slots.0.highNote');
    await t.page.fill(low, 'C3');
    await t.page.press(low, 'Enter');
    await t.untilEngine('slots.0.lowNote', 48);
    await t.page.fill(high, '72');
    await t.page.press(high, 'Enter');
    await t.untilEngine('slots.0.highNote', 72);
    assert.equal(await t.page.inputValue(high), 'C5');
    await t.until((h) => /C3 to C5/.test(document.querySelector(`${h} .ev2-slot-rnote`).textContent), t.host);
    await t.page.fill(low, 'f#2');
    await t.page.press(low, 'Enter');
    await t.untilEngine('slots.0.lowNote', 42);
    // an invalid entry toasts and shows the stored value again
    await t.page.fill(low, 'H9');
    await t.page.press(low, 'Enter');
    await t.until(() => window.__rig.toasts.some((x) => x.msg === '“H9” is not a key name — try C4 or F#2'));
    assert.equal(await t.page.inputValue(low), 'Gb2');
    await t.click(`${t.host} .ev2-slot-whole`);
    await t.untilEngine('slots.0.lowNote', 0);
    await t.untilEngine('slots.0.highNote', 127);
    assert.match(await t.page.textContent(`${t.host} .ev2-slot-rnote`), /every key/);
    const mini = await t.page.locator(bindSel(t, 'slots.0.split')).boundingBox();
    await t.page.mouse.click(mini.x + mini.width * 0.3, mini.y + mini.height * 0.3);
    await t.until(() => {
      const n = window.__rig.engine.getParam('slots.0.lowNote');
      return n > 30 && n < 70;
    });
    await t.click(`${t.host} .ev2-slot-whole`);
    await t.untilEngine('slots.0.lowNote', 0);

    // Set lowest… arms a one-shot on the next held note
    const armLow = `${t.host} .ev2-slot-arm[data-arm="low"]`;
    const armHigh = `${t.host} .ev2-slot-arm[data-arm="high"]`;
    await t.click(armLow);
    assert.equal(await t.page.getAttribute(armLow, 'aria-pressed'), 'true');
    assert.match(await t.page.textContent(armLow), /Play a key/);
    await t.ev(() => window.__rig.controller.perform.noteOn(50, 90));
    await t.untilEngine('slots.0.lowNote', 50);
    await t.ev(() => window.__rig.controller.perform.noteOff(50));
    assert.equal(await t.page.getAttribute(armLow, 'aria-pressed'), 'false', 'one-shot');
    await t.ev(() => window.__rig.controller.perform.noteOn(40, 90));
    await t.sleep(120);
    assert.equal(await t.engineParam('slots.0.lowNote'), 50, 'not armed any more');
    await t.ev(() => window.__rig.controller.perform.noteOff(40));
    await t.click(armHigh);
    await t.ev(() => window.__rig.controller.perform.noteOn(79, 90));
    await t.untilEngine('slots.0.highNote', 79);
    await t.ev(() => window.__rig.controller.perform.noteOff(79));
    assert.match(await title(t), / on D3 to G5,/);
    // Esc disarms (never panics); a click elsewhere disarms
    const p0 = await panicCounter(t);
    await t.click(armLow);
    await t.page.keyboard.press('Escape');
    assert.equal(await t.page.getAttribute(armLow, 'aria-pressed'), 'false');
    assert.equal(await panicCounter(t), p0);
    await t.click(armHigh);
    await t.click(`${t.host} .ev2-slot-snd .ev2-cap`);
    assert.equal(await t.page.getAttribute(armHigh, 'aria-pressed'), 'false');
    await t.ev(() => window.__rig.controller.perform.noteOn(90, 90));
    await t.sleep(120);
    assert.equal(await t.engineParam('slots.0.highNote'), 79);
    await t.ev(() => window.__rig.controller.perform.noteOff(90));
    await t.click(`${t.host} .ev2-slot-whole`);

    // ui-edit "velocity-curve sparkline + More summary": Response = velocityCurve with Settings' words
    const resp = bindSel(t, 'slots.0.velocityCurve');
    assert.deepEqual(await t.ev((s) => [...document.querySelectorAll(`${s} button`)].map((b) => b.textContent), resp),
      ['Light', 'Normal', 'Heavy', 'Fixed']);
    const spark = `${t.host} .ev2-slot-spark`;
    assert.equal(await t.page.getAttribute(spark, 'data-curve'), 'normal');
    await t.click(`${resp} button[data-value="soft"]`);
    await t.until((s) => document.querySelector(s).dataset.curve === 'soft'
      && window.__rig.engine.getParam('slots.0.velocityCurve') === 'soft', spark);
    const px = await t.ev((s) => {
      const c = document.querySelector(s);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
      return n;
    }, spark);
    assert.ok(px > 50, `sparkline pixels ${px}`);
    assert.match(await t.page.textContent(`${t.host} details[data-sec="slot0-adv"] .ev2-sec-sum`), /Light touch/);
    await t.click(`${resp} button[data-value="normal"]`);
    await t.untilEngine('slots.0.velocityCurve', 'normal');
    t.assertNoConsoleErrors();
  }
});

test('slot: round2-ui #3 — a note typed before a non-pointer song switch goes to its own song', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    const [a, b] = await sameInstrumentPair(t);
    await t.ev(([x, y]) => {
      window.__rig.store.set(`songs.${x}.patch.slots.0.lowNote`, 0);
      window.__rig.store.set(`songs.${y}.patch.slots.0.lowNote`, 0);
    }, [a, b]);
    await t.selectSong(a);
    const low = bindSel(t, 'slots.0.lowNote');
    await t.page.focus(low);
    await t.page.fill(low, 'D3');
    await t.selectSong(b); // MIDI Next / program change: no pointer, the field still has focus
    await t.until(([x]) => window.__rig.store.getSong(x).patch.slots[0].lowNote === 50, [a]);
    assert.equal(await t.ev((y) => window.__rig.store.getSong(y).patch.slots[0].lowNote, b), 0, 'B untouched');
    await t.until((s) => document.querySelector(s).value === 'C-1', low);
    // the switch kept the body (same instrument): its word sliders still take keyboard / programmatic input
    // (lib.wordSlider's cancelDrag used to leave them "dead" until the next click; slot.js wraps it)
    await t.setRange(rangeOf(t, 'slots.0.eq.low'), 625);
    await untilLowShelf(t, '> 2.95', b);
    await t.page.focus(rangeOf(t, 'slots.0.eq.low'));
    await t.page.keyboard.press('ArrowRight');
    await untilLowShelf(t, '> 3.01', b);
    await t.ev(() => document.activeElement.blur());
    await t.page.dblclick(rangeOf(t, 'slots.0.eq.low'));
    await untilLowShelf(t, '=== 0', b);
    t.assertNoConsoleErrors();
  }
});

test('slot: Advanced — pan/transpose/voices/bend/pedal, width/EQ by hasParam, instrument settings', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    await openSec(t, 'slot0-adv');
    assert.match(await t.page.textContent(`${t.host} details[data-sec="slot0-adv"] .ev2-sec-sum`),
      /^Pan Center · (Width \d+% · )?(Tone (Flat|Custom · \d+ bands?) · )?Transpose 0 · Voices All · Pitch bend (On|Off)$/);
    // ui-edit "pan / octave / transpose / sustain / mono reach the engine" (octave + sustain: see the chip test)
    await t.setRange(rangeOf(t, 'slots.0.pan'), 250);
    await t.until(() => Math.abs(window.__rig.engine.getParam('slots.0.pan') + 0.5) < 0.01).catch(async (err) => {
      const d = await t.ev(() => [window.__rig.store.currentSong().patch.slots[0].pan,
        window.__rig.engine.getParam('slots.0.pan'), document.querySelectorAll('[data-bind="slots.0.pan"]').length]);
      throw new Error(`pan: ${JSON.stringify(d)} ${err.message}`);
    });
    await t.until((h) => /Pan L 50/
      .test(document.querySelector(`${h} [data-sec="slot0-adv"] .ev2-sec-sum`).textContent), t.host);
    await t.click(`${bindSel(t, 'slots.0.transpose')} button[aria-label$="up"]`);
    await t.untilEngine('slots.0.transpose', 1);
    assert.match(await t.page.textContent(bindSel(t, 'slots.0.transpose')), /\+1 semitone\b/);
    await t.click(`${bindSel(t, 'slots.0.transpose')} button[aria-label$="down"]`);
    await t.untilEngine('slots.0.transpose', 0);
    await t.page.selectOption(`${bindSel(t, 'slots.0.mono')} select`, 'highest');
    await t.untilEngine('slots.0.mono', 'highest');
    assert.match(await t.page.textContent(`${t.host} details[data-sec="slot0-adv"] .ev2-sec-sum`), /Voices Highest/);
    await t.page.selectOption(`${bindSel(t, 'slots.0.mono')} select`, 'off');
    const bend = await t.engineParam('slots.0.bendEnabled');
    await t.click(bindSel(t, 'slots.0.bendEnabled'));
    await t.untilEngine('slots.0.bendEnabled', !bend);
    await t.click(bindSel(t, 'slots.0.bendEnabled'));
    const sus = await t.engineParam('slots.0.sustain');
    await t.click(`${t.host} .ev2-slot-adv ${'[data-bind="slots.0.sustain"]'}`);
    await t.untilEngine('slots.0.sustain', !sus);
    await t.click(`${t.host} .ev2-slot-adv ${'[data-bind="slots.0.sustain"]'}`);
    await t.untilEngine('slots.0.sustain', sus);
    await t.setRange(rangeOf(t, 'slots.0.pan'), 500);

    // ui-edit "new strip/master params render only when params.describe has them; labels, reset, store".
    // hv2-edit-integrate: the strip EQ is the Tone section (eqKeyboard) when the b-rows exist; eq.low / eq.high are
    // bound only as the smart shelf sliders (Warmth always, Brightness when the instrument has no cutoff/tone).
    const have = await t.ev(async (paths) => {
      const { describe } = await import('/app/js/shared/params.js');
      return Object.fromEntries(paths.map((p) => [p, !!describe(p) && !describe(p).dynamic]));
    }, ['slots.0.width', 'slots.0.eq.low', 'slots.0.eq.b1.db']);
    assert.equal(!!(await t.page.$(bindSel(t, 'slots.0.width'))), have['slots.0.width'], 'width rendered iff described');
    assert.equal(!!(await t.page.$(bindSel(t, 'slots.0.eq.low'))), have['slots.0.eq.low'], 'Warmth iff eq.low');
    assert.equal(!!(await t.page.$(`${t.host} .ev2-slot-adv [data-bind="slots.0.eq.high"]`)), false,
      'no separate Highs slider in Advanced (the Tone section replaced Lows/Highs)');
    assert.equal(!!(await t.page.$(`${t.host} details[data-sec="slot0-tone"]`)), have['slots.0.eq.b1.db'],
      'Tone section iff the EQ rows exist');
    if (have['slots.0.eq.b1.db']) {
      // lazy: the editor exists only while Advanced › Tone is open, and is destroyed on close
      assert.equal(await t.ev(() => window.__rig.view.instance._debug.tone().mounted), false);
      assert.equal(await t.page.$(`${t.host} .ev2-slot-tone-host .eqk`), null);
      await openSec(t, 'slot0-tone');
      await t.until((h) => !!document.querySelector(`${h} .ev2-slot-tone-host .eqk`), t.host);
      assert.match(await t.page.textContent(`${t.host} details[data-sec="slot0-tone"] .ev2-sec-sum`),
        /^(Flat|Custom · \d+ bands?)$/);
      const d0 = await t.ev(() => window.__rig.view.instance._debug.tone());
      await t.ev(() => {
        document.querySelector('details[data-sec="slot0-tone"]').open = false;
      });
      await t.until(() => !window.__rig.view.instance._debug.tone().mounted);
      const d1 = await t.ev(() => window.__rig.view.instance._debug.tone());
      assert.equal(d1.destroyed, d0.destroyed + 1, 'closing Tone destroys the editor');
      assert.equal(await t.page.$(`${t.host} .ev2-slot-tone-host .eqk`), null);
    }
    if (have['slots.0.width']) {
      await t.setRange(rangeOf(t, 'slots.0.width'), 400); // 0..1.5 → 0.6
      await t.until(() => Math.abs(window.__rig.store.currentSong().patch.slots[0].width - 0.6) < 0.002);
      assert.equal(await t.page.textContent(`${bindSel(t, 'slots.0.width')} .ev2-ws-num`), '60%');
      await t.setRange(rangeOf(t, 'slots.0.width'), 0);
      assert.equal(await t.page.textContent(`${bindSel(t, 'slots.0.width')} .ev2-ws-num`), 'Mono');
      await t.page.dblclick(rangeOf(t, 'slots.0.width'));
      await t.until(() => window.__rig.store.currentSong().patch.slots[0].width === 1);
    }
    // params the smart sliders took are not repeated in Advanced, and the note says where they went
    const dup = await t.ev((h) => {
      const all = [...document.querySelectorAll(`${h} [data-bind]`)].map((e) => e.dataset.bind)
        .filter((b) => !/sustain$/.test(b)); // sustain: the chip and the Advanced pedal toggle (checklist)
      return all.filter((b, k) => all.indexOf(b) !== k);
    }, t.host);
    assert.deepEqual(dup, [], 'no path bound twice');
    assert.match(await t.page.textContent(`${t.host} .ev2-slot-moved`), /In The sound itself above: .*→ /);

    // ui-edit "sends + instrument params reach the engine": soft-keys tremolo 0.9, double-click → 0.25
    await t.setParam('slots.0.instrument', { type: 'synth', id: 'soft-keys' });
    await t.until(() => window.__rig.engine.slots[0]?.ref.id === 'soft-keys', null, 30000);
    await t.until((h) => /Soft Keys settings/.test(document.querySelector(`${h} .ev2-slot-adv-h`)?.textContent || ''),
      t.host);
    assert.ok(await t.ev(() => document.querySelector('details[data-sec="slot0-adv"]').open), 'Advanced stays open');
    await t.setRange(rangeOf(t, 'slots.0.params.tremolo'), 900);
    await t.until(() => Math.abs(window.__rig.store.currentSong().patch.slots[0].params.tremolo - 0.9) < 0.002);
    const v = await t.ev(() => [window.__rig.store.currentSong().patch.slots[0].params.tremolo,
      window.__rig.engine.getParam('slots.0.params.tremolo')]);
    assert.ok(near(v[0], v[1]), `store ${v[0]} engine ${v[1]}`);
    await t.page.dblclick(rangeOf(t, 'slots.0.params.tremolo'));
    await t.until(() => Math.abs(window.__rig.engine.getParam('slots.0.params.tremolo') - 0.25) < 1e-9);
    // Tone → Brightness, Release → Ring-out; those two are not in the instrument grid
    assert.equal(await t.page.$(`${t.host} .ev2-slot-params [data-param="tone"]`), null);
    assert.equal(await t.page.$(`${t.host} .ev2-slot-params [data-param="release"]`), null);
    assert.match(await t.page.textContent(`${t.host} .ev2-slot-moved`), /Tone → Brightness/);
    // Reset these settings writes every default explicitly
    await t.setRange(rangeOf(t, 'slots.0.params.drive'), 1000);
    await t.setRange(rangeOf(t, 'slots.0.params.tone'), 100);
    await t.click(`${t.host} .ev2-slot-preset`);
    const reset = await t.ev(() => {
      const meta = window.__rig.engine.listInstruments().find((x) => x.ref.id === 'soft-keys');
      const p = window.__rig.store.currentSong().patch.slots[0].params;
      return meta.params.every((q) => p[q.key] === q.default);
    });
    assert.ok(reset, 'every instrument param back at its default');
    await t.screenshot('slot-advanced');

    // update({slot}) switches slots without stale bindings; the old slot's writes no longer reach the panel
    await t.select('slot:1');
    await t.until((h) => document.querySelector(`${h} .ev2-slot`).dataset.slot === '1', t.host);
    assert.equal(await t.ev((h) => document.querySelectorAll(`${h} [data-bind^="slots.0."]`).length, t.host), 0);
    assert.match(await title(t), /^PAD /);
    await t.setParam('slots.1.gain', 1);
    await t.until((sel) => Math.abs(Number(document.querySelector(sel).value) - Math.round(Math.cbrt(0.5) * 1000)) <= 1,
      rangeOf(t, 'slots.1.gain'));
    t.assertNoConsoleErrors();
  }
});

test('slot: round3-edit M2 — a step panel closes on a song switch; its fine drag never writes into the new song', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    const [a, b] = await sameInstrumentPair(t);
    await t.ev(([x, y]) => {
      window.__rig.store.set(`songs.${x}.patch.slots.0.sends.reverb`, 0.5);
      window.__rig.store.set(`songs.${y}.patch.slots.0.sends.reverb`, 0.3);
    }, [a, b]);
    await t.selectSong(a);
    await t.ev(() => document.activeElement?.blur?.());
    // a plain switch closes an open step panel (MIDI Next / ⌘→ reach selectSong without an outside tap)
    await t.click(bindSel(t, 'slots.0.sends.reverb'));
    await t.until((h) => !!document.querySelector(`${h} .step-panel`), t.host);
    await t.ev((y) => window.__rig.controller.selectSong(y), b);
    await t.until((h) => !document.querySelector(`${h} .step-panel`), t.host);
    await t.selectSong(a);
    await t.ev(() => document.activeElement?.blur?.());
    // a fine-slider drag running across the switch: B's send stays 0.3
    await t.click(bindSel(t, 'slots.0.sends.reverb'));
    await t.until((h) => !!document.querySelector(`${h} .step-panel .sp-fine input[type=range]`), t.host);
    const loc = t.page.locator(`${t.host} .step-panel .sp-fine input[type=range]`).first();
    const box = await loc.boundingBox();
    const x = box.x + box.width / 2;
    const y0 = box.y + box.height * 0.5;
    await t.page.mouse.move(x, y0);
    await t.page.mouse.down();
    await t.page.mouse.move(x, y0 - box.height * 0.15, { steps: 4 });
    await t.sleep(80);
    const midA = await t.ev((id) => window.__rig.store.getSong(id).patch.slots[0].sends.reverb, a);
    assert.notEqual(midA, 0.5, 'the fine drag moves A');
    await t.ev((y) => window.__rig.controller.selectSong(y), b);
    await t.until((y) => window.__rig.store.currentSong().id === y, b);
    await t.sleep(60);
    await t.page.mouse.move(x, y0 - box.height * 0.45, { steps: 6 });
    await t.page.mouse.move(x, y0 - box.height * 0.6, { steps: 4 });
    await t.page.mouse.up();
    await t.sleep(150);
    const r = await t.ev(([x1, y1]) => [window.__rig.store.getSong(x1).patch.slots[0].sends.reverb,
      window.__rig.store.getSong(y1).patch.slots[0].sends.reverb], [a, b]);
    assert.equal(r[1], 0.3, `B untouched (got ${r[1]})`);
    assert.equal(r[0], midA, 'A keeps what the drag wrote before the switch');
    assert.equal(await t.page.$(`${t.host} .step-panel`), null, 'the panel is closed');
    t.assertNoConsoleErrors();
  }
});

test('slot: round3-edit m1/m2/m3 — off shelf reads 0 dB, "Sound edited" copy, instrument change has Undo', async () => {
  const t = await page();
  {
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    const line = () => t.page.textContent(`${t.host} .ev2-slot-chgline`);
    assert.equal(await line(), 'No switch changes since the song was loaded');
    // m2: a Warmth move is a real edit that the switch count leaves out → the line says so
    await t.setRange(rangeOf(t, 'slots.0.eq.low'), 750);
    await untilLowShelf(t, '> 5.95');
    await t.until((h) => /Sound edited \(no switch changes\)/.test(
      document.querySelector(`${h} .ev2-slot-chgline`).textContent), t.host);
    // a fader move alone is a level, not an edit
    await t.page.dblclick(rangeOf(t, 'slots.0.eq.low'));
    await untilLowShelf(t, '=== 0');
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    await t.setParam('slots.0.gain', 0.33);
    await t.sleep(80);
    assert.equal(await line(), 'No switch changes since the song was loaded');

    // m1: the Tone editor switched the low shelf off → Warmth shows 0 dB (the engine hears it flat), not +6
    await t.ev(() => {
      const { store } = window.__rig;
      store.set('slots.0.eq.b1.type', 'lowshelf');
      store.set('slots.0.eq.b1.db', 6);
      store.set('slots.0.eq.b1.on', false);
    });
    await t.until(() => window.__rig.store.currentSong().patch.slots[0].eq.b1.on === false);
    await t.sleep(80);
    const warm = await t.page.textContent(`${bindSel(t, 'slots.0.eq.low')} .ev2-ws-val`);
    assert.doesNotMatch(warm, /\+6\.0/, `Warmth of an off shelf: ${warm}`);
    assert.equal(warm, 'Neutral0 dB');
    await t.ev(() => window.__rig.store.set('slots.0.eq.b1.on', true));
    await t.until((s) => /\+6\.0 dB/.test(document.querySelector(s).textContent),
      `${bindSel(t, 'slots.0.eq.low')} .ev2-ws-val`);
    assert.match(await t.ev(() => document.querySelector('#view-edit .ev2-slot-tone-hint')?.textContent || ''),
      /switches its shelf back on/);

    // m3: an instrument change drops params → an 8 s Undo toast brings back the instrument and its params
    await fresh(t, 'factory:sunday-pad-piano', 'slot:0');
    await t.setParam('slots.0.params.tremolo', 0.9);
    const before = (await t.song()).patch.slots[0];
    await t.ev(() => {
      const c = window.__rig.ctx;
      // (an earlier test may have wrapped toast already: record in our own array, call through whatever is there)
      if (!c.__origToast) c.__origToast = c.toast;
      window.__r3Toasts = [];
      c.toast = (msg, kind, opts) => {
        window.__r3Toasts.push({ msg, kind, action: opts && opts.action ? opts.action.label : null, ms: opts?.ms });
        window.__r3Undo = opts && opts.action ? opts.action.run : null;
        return c.__origToast(msg, kind, opts);
      };
    });
    await t.click('#view-edit .ev2-slot-chg');
    await t.until(() => !document.querySelector('#view-edit .ev2-slot-menu').hidden);
    const other = await t.ev((cur) => [...document.querySelectorAll('#view-edit .ev2-slot-mi[data-value^="sampler:"]')]
      .map((b) => b.dataset.value).find((v) => v !== cur), `${before.instrument.type}:${before.instrument.id}`);
    assert.ok(other, 'another sampler instrument to pick');
    await t.click(`#view-edit .ev2-slot-mi[data-value="${other}"]`);
    await t.until((o) => `${window.__rig.store.currentSong().patch.slots[0].instrument.type}:${
      window.__rig.store.currentSong().patch.slots[0].instrument.id}` === o, other);
    assert.deepEqual((await t.song()).patch.slots[0].params, {}, 'the store resets params on a change');
    const calls = await t.ev(() => window.__r3Toasts);
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0].action, 'Undo');
    assert.equal(calls[0].ms, 8000);
    assert.match(calls[0].msg, /^Keys is now /);
    assert.equal(await t.ev(() => window.__r3Undo()), true);
    await t.until(() => window.__rig.store.currentSong().patch.slots[0].params.tremolo === 0.9);
    const after = (await t.song()).patch.slots[0];
    assert.deepEqual(after.instrument, before.instrument);
    assert.deepEqual(after.params, before.params);
    assert.equal(await t.ev(() => window.__r3Undo()), false, 'a second Undo finds the slot moved on');
    await t.ev(() => {
      const c = window.__rig.ctx;
      c.toast = c.__origToast;
    });
    t.assertNoConsoleErrors();
  }
});

test('slot: full view at 1024×700 and 1440×900 — fits, no overflow; focus on mount and on update', async () => {
  await shared?.close(); // one page at a time on the shared box
  shared = null;
  const t = await mountPanelForTest(null, { full: true, viewport: { width: 1024, height: 700 } });
  try {
    for (const viewport of [{ width: 1024, height: 700 }, { width: 1440, height: 900 }]) {
      await t.page.setViewportSize(viewport);
      await t.until(() => !!document.querySelector('#view-edit [data-panel="slot"] .ev2-slot-filled'));
      await t.sleep(150);
      const m = await t.ev(() => {
        const body = document.querySelector('#view-edit .ev2-body');
        const over = [...document.querySelectorAll('#view-edit .ev2-slot *')]
          .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible'
            && !e.matches('.ev2-sent, .ev2-sec-sum, .ev2-slot-rh, select, input'))
          .map((e) => e.className);
        return {
          page: document.documentElement.scrollWidth <= window.innerWidth,
          bodyX: body.scrollWidth <= body.clientWidth + 1,
          bodyY: body.scrollHeight <= body.clientHeight + 1,
          over,
          fader: document.querySelector('#view-edit [data-bind="slots.0.gain"] input').getBoundingClientRect().height,
        };
      });
      assert.ok(m.page && m.bodyX, `no horizontal overflow at ${viewport.width}`);
      assert.deepEqual(m.over, []);
      assert.ok(m.bodyY, `the panel fits without vertical scroll at ${viewport.width}×${viewport.height}`);
      assert.ok(m.fader > 120, `fader throw ${m.fader}px`);
      await t.screenshot(`slot-full-${viewport.width}`);
    }
    // update(): an empty tab's "+ Add a sound" sends focus 'instrument' → the menu opens on its current item
    await t.select('slot:3', { focus: 'instrument' });
    await t.until(() => !document.querySelector('#view-edit .ev2-slot-menu').hidden
      && document.activeElement?.classList.contains('ev2-slot-mi'));
    await t.page.keyboard.press('Escape');
    // mount(): from another panel, 'range' opens on the range block
    await t.select('drone');
    await t.until(() => !document.querySelector('#view-edit [data-panel="slot"]'));
    await t.select('slot:0', { focus: 'range' });
    await t.until(() => document.querySelector('#view-edit .ev2-slot-range')?.classList.contains('ev2-flash'));
    assert.ok(await t.ev(() => document.querySelector('#view-edit .ev2-slot-range').contains(document.activeElement)));
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});
