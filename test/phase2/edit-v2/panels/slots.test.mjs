// UIA (native DECISIONS D3): 1..16 slots per song in Edit. The rig bar's "Slots n" adds a slot (empty, selected,
// picker open) or removes the last one after a question; more than four slot tabs scroll sideways with the selected
// one in view; Sound 5.. are named and coloured past the four roles; on the web engine they say they are silent here
// (they play on the 2.0 engine); the Effects "goes in" chips, Master's wheel targets and the wiring strip follow the
// count. Zero console errors. Screenshots → screenshots/slots-*.png.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, shutdown } from '../harness.mjs';

let t;
before(async () => {
  t = await mountPanelForTest(null, { full: true });
});
after(async () => {
  await t?.close();
  await shutdown();
});

const tabSel = (id) => `#view-edit .ev2-tab[data-block="${id}"]`;
const slotTabs = () => t.ev(() => [...document.querySelectorAll('#view-edit .ev2-slottabs .ev2-tab')].map((x) => x.dataset.block));
const count = () => t.ev(() => window.__rig.store.currentSong().patch.slots.length);
const openMenu = async () => {
  await t.click('[data-testid=edit-slots]');
  await t.page.waitForSelector('#view-edit .ev2-slots-pop[role=menu]', { state: 'visible' });
};
/** A tab fully inside the scrolling slot-tab row (or the row does not scroll). */
const inView = (id) => t.ev((sel) => {
  const row = document.querySelector('#view-edit .ev2-slottabs');
  const a = row.getBoundingClientRect();
  const b = document.querySelector(sel).getBoundingClientRect();
  return b.left >= a.left - 1 && b.right <= a.right + 1;
}, tabSel(id));

test('a 4-slot song: "Slots 4", the same seven tabs, the row does not scroll', async () => {
  assert.equal(await t.ev(() => document.querySelector('[data-testid=edit-slots] .ev2-slots-n').textContent), '4');
  assert.deepEqual(await slotTabs(), ['slot:0', 'slot:1', 'slot:2', 'slot:3']);
  const all = await t.ev(() => [...document.querySelectorAll('#view-edit .ev2-tab')].map((x) => x.dataset.block));
  assert.deepEqual(all, ['slot:0', 'slot:1', 'slot:2', 'slot:3', 'drone', 'effects', 'master']);
  const r = await t.ev(() => {
    const row = document.querySelector('#view-edit .ev2-slottabs');
    const tabs = [...row.children].map((x) => Math.round(x.getBoundingClientRect().width));
    return { scroll: row.classList.contains('scroll'), sw: row.scrollWidth, cw: row.clientWidth, tabs };
  });
  assert.equal(r.scroll, false);
  assert.ok(r.sw <= r.cw + 1, 'nothing to scroll');
  assert.ok(Math.max(...r.tabs) - Math.min(...r.tabs) <= 1, `four equal tabs: ${r.tabs}`);
  t.assertNoConsoleErrors();
});

test('Slots › Add Sound 5: an empty slot at the end, selected, its picker open; Esc closes the menu', async () => {
  await openMenu();
  const items = await t.ev(() => [...document.querySelectorAll('#view-edit .ev2-slots-pop [role=menuitem]')].map((b) => [b.dataset.act, b.querySelector('span').textContent, b.disabled]));
  assert.deepEqual(items, [['add', 'Add Sound 5', false], ['remove', 'Remove Bass…', false]]);
  assert.match(await t.ev(() => document.querySelector('#view-edit .ev2-slots-pop').textContent), /play on the 2\.0 engine/);
  assert.equal(await t.ev(() => document.body.dataset.dialogOpen), '1', 'the dialog flag is up while the menu is open');
  await t.page.keyboard.press('Escape');
  await t.until(() => document.querySelector('#view-edit .ev2-slots-pop').hidden);
  assert.equal(await count(), 4, 'Esc changed nothing');
  await openMenu();
  await t.click('#view-edit .ev2-slots-mi[data-act=add]');
  await t.until(() => window.__rig.view.editState.selected === 'slot:4');
  assert.equal(await count(), 5);
  assert.equal(await t.ev(() => window.__rig.store.currentSong().patch.slots[4]), null, 'an empty slot');
  assert.equal(await t.ev(() => window.__rig.view.editState.opts.focus), 'instrument');
  assert.deepEqual(await slotTabs(), ['slot:0', 'slot:1', 'slot:2', 'slot:3', 'slot:4']);
  assert.equal(await t.ev((s) => document.querySelector(s).querySelector('.ev2-tab-role').textContent, tabSel('slot:4')), 'SOUND 5');
  assert.equal(await t.ev(() => document.querySelector('[data-testid=edit-slots] .ev2-slots-n').textContent), '5');
  assert.ok(await inView('slot:4'), 'the new tab scrolled into view');
  // pick a sound for it through the panel's own picker (the store write is what the picker does)
  assert.ok(await t.setParam('slots.4', { instrument: { type: 'synth', id: 'soft-keys' } }));
  await t.until(() => /Soft Keys/i.test(document.querySelector('#view-edit .ev2-tab[data-block="slot:4"] .ev2-tab-name-text').textContent));
  // the web engine plays 4 slots: Sound 5's panel says so, and the engine never hears it
  await t.until(() => /Silent here: it plays on the 2\.0 engine/.test(document.querySelector('#view-edit .ev2-title-sub')?.textContent || ''));
  assert.equal(await t.ev(() => window.__rig.engine.getParam('slots.4.gain')), undefined);
  t.assertNoConsoleErrors();
});

test('16 slots: the slot tabs scroll (four in view), arrows reveal the selected tab, Add is disabled', async () => {
  await t.ev(() => {
    const s = window.__rig.store;
    while (s.currentSong().patch.slots.length < 16) s.addSlot(undefined, { instrument: { type: 'synth', id: 'warm-pad' } });
  });
  await t.until(() => document.querySelectorAll('#view-edit .ev2-slottabs .ev2-tab').length === 16);
  const r = await t.ev(() => {
    const row = document.querySelector('#view-edit .ev2-slottabs');
    const w = [...row.children].map((x) => x.getBoundingClientRect().width);
    return { scroll: row.classList.contains('scroll'), sw: row.scrollWidth, cw: row.clientWidth, w0: w[0], w15: w[15] };
  });
  assert.equal(r.scroll, true);
  assert.ok(r.sw > r.cw * 3, `scrolls: ${r.sw} > 3 × ${r.cw}`);
  assert.ok(Math.abs(r.w0 * 4 - r.cw) < 24, `four tabs in view (${r.w0} × 4 ≈ ${r.cw})`);
  assert.equal(r.w0, r.w15);
  const tabColor = (id) => t.ev((s) => getComputedStyle(document.querySelector(s)).getPropertyValue('--tc').trim(), tabSel(id));
  const root15 = await t.ev(() => getComputedStyle(document.documentElement).getPropertyValue('--slot-15').trim());
  assert.match(root15, /color-mix\(in oklch, #b784ff 25%, #ff8a3d\)/, 'Sound 16: a mix of the Bass and Keys colours');
  assert.equal(await tabColor('slot:15'), root15);
  const rgb = await t.ev((s) => getComputedStyle(document.querySelector(s).querySelector('.ev2-tab-led')).backgroundColor, tabSel('slot:15'));
  assert.ok(/^(rgb|oklch|color)/.test(rgb) && rgb !== 'rgba(0, 0, 0, 0)', `a real colour: ${rgb}`);
  await t.select('slot:0');
  await t.page.focus(tabSel('slot:0'));
  // ← from Keys wraps to Master, then Effects, Drone, and the last slot tab
  for (let k = 0; k < 4; k++) await t.page.keyboard.press('ArrowLeft');
  await t.until(() => window.__rig.view.editState.selected === 'slot:15');
  await t.until((s) => {
    const row = document.querySelector('#view-edit .ev2-slottabs').getBoundingClientRect();
    const b = document.querySelector(s).getBoundingClientRect();
    return b.left >= row.left - 1 && b.right <= row.right + 1;
  }, tabSel('slot:15'));
  await t.page.keyboard.press('Home');
  await t.until(() => window.__rig.view.editState.selected === 'slot:0');
  assert.ok(await inView('slot:0'));
  await t.ev(() => document.activeElement?.blur());
  // the wheel / pedal can drive Sound 16; the wiring strip has a column per slot
  await t.select('master', { focus: 'wheels' });
  await t.until(() => window.__rig.view._debug.mounted().includes('master'));
  const opts = await t.ev(() => [...document.querySelectorAll('#view-edit [data-route="modWheel"] select option')].map((o) => o.value));
  assert.ok(opts.includes('slots.15.gain') && opts.includes('none'), opts.join());
  assert.equal(await t.ev(() => [...document.querySelectorAll('#view-edit [data-route="modWheel"] select option')].find((o) => o.value === 'slots.15.gain').textContent), 'Sound 16 level');
  await t.click('#view-edit .ev2-wiretog');
  // one number per filled slot (Extra and Bass are empty in this song), Sound 16's in the 16th column
  await t.until(() => document.querySelectorAll('#view-edit .ev2-wv[data-lane="reverb"][data-slot]').length
    === window.__rig.store.currentSong().patch.slots.filter(Boolean).length);
  assert.equal(await t.ev(() => document.querySelector('#view-edit .ev2-wv[data-lane="reverb"][data-slot="15"]').parentElement.style.gridColumn), '16');
  await t.screenshot('slots-16-wiring');
  await t.click('#view-edit .ev2-wiretog');
  await t.select('effects');
  await t.until(() => document.querySelectorAll('#view-edit [data-testid^="fx-reverb-"]').length === 16);
  await t.select('slot:15');
  await openMenu();
  assert.equal(await t.ev(() => document.querySelector('#view-edit .ev2-slots-mi[data-act=add]').disabled), true, '16 is the most');
  await t.page.keyboard.press('Escape');
  await t.screenshot('slots-16');
  t.assertNoConsoleErrors();
});

test('Remove the last slot asks first; Cancel keeps it; Remove drops it and moves the selection', async () => {
  await t.select('slot:15');
  await openMenu();
  await t.click('#view-edit .ev2-slots-mi[data-act=remove]');
  await t.page.waitForSelector('#view-edit .ev2-slots-pop[role=alertdialog]', { state: 'visible' });
  assert.match(await t.ev(() => document.querySelector('#view-edit .ev2-slots-q').textContent), /^Remove Sound 16 from .*\? Its sound and settings go with it\.$/);
  assert.equal(await t.ev(() => document.activeElement?.dataset?.act), 'cancel', 'focus on Cancel');
  await t.click('#view-edit .ev2-slots-pop [data-act=cancel]');
  assert.equal(await count(), 16);
  await openMenu();
  await t.click('#view-edit .ev2-slots-mi[data-act=remove]');
  await t.click('#view-edit .ev2-slots-pop [data-act=remove-go]');
  await t.until(() => window.__rig.store.currentSong().patch.slots.length === 15);
  await t.until(() => window.__rig.view.editState.selected === 'slot:14');
  assert.equal(await t.ev(() => document.querySelectorAll('#view-edit .ev2-slottabs .ev2-tab').length), 15);
  // back to four: the row stops scrolling and the seven tabs are as before
  await t.ev(() => {
    const s = window.__rig.store;
    while (s.currentSong().patch.slots.length > 4) s.removeSlot();
  });
  await t.until(() => !document.querySelector('#view-edit .ev2-slottabs').classList.contains('scroll'));
  assert.deepEqual(await slotTabs(), ['slot:0', 'slot:1', 'slot:2', 'slot:3']);
  assert.equal(await t.ev(() => window.__rig.view.editState.selected), 'slot:3');
  // one slot: Remove is disabled (a song keeps at least one)
  await t.ev(() => {
    const s = window.__rig.store;
    while (s.currentSong().patch.slots.length > 1) s.removeSlot();
  });
  await t.until(() => document.querySelectorAll('#view-edit .ev2-slottabs .ev2-tab').length === 1);
  await openMenu();
  assert.equal(await t.ev(() => document.querySelector('#view-edit .ev2-slots-mi[data-act=remove]').disabled), true);
  await t.page.keyboard.press('Escape');
  await t.screenshot('slots-1');
  t.assertNoConsoleErrors();
});
