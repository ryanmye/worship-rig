// OWNER: effects agent (views/edit/CONTRACT.md §6). Tests for panels/effects.js (the Effects tab).
// Run alone: node test/phase2/edit-v2/run.mjs --only effects
// (or node --test --test-reporter=spec <this file>). The harness smoke test stays first.
// Ports ui-edit "presets: Space / Echo / Vibe apply through the store; tweak → Custom" and the reverb / delay / chorus
// parts of "FX: reverb / delay (sync, pingpong) / chorus / lofi / master reach the engine".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

after(shutdown);

const rangeOf = (bind) => `[data-bind="${bind}"] input[type=range]`;
const selectOf = (bind) => `[data-bind="${bind}"] select`;
const pressed = (t, kind) => t.ev((k) => {
  const b = document.querySelector(`[data-preset="${k}"] .ev2-fx-pc[aria-pressed="true"]`);
  return b ? b.dataset.id : null;
}, kind);
const openSec = (t, ...ids) => t.ev((xs) => {
  for (const id of xs) document.querySelector(`details[data-sec="${id}"]`).open = true;
}, ids);
const titleText = (t) => t.ev(() => document.querySelector('#view-edit .ev2-title .ev2-sent').textContent);
const text = (t, sel) => t.ev((s) => document.querySelector(s)?.textContent ?? null, sel);

// run.mjs gives the whole file 240 s (node --test-timeout) on a shared 2-CPU box, so the file uses two mounts:
// one at 1440×900 shared by the first four tests (in order; each leaves a state the next one does not depend on) and
// one at 1024×700 for the step panels, focus and the song switch.
let wide = null;
const wideMount = async () => (wide ||= await mountPanelForTest('effects', { song: 'Sunday Pad + Piano' }));

test('effects: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  const t = await wideMount();
  await smoke(t);
  await t.screenshot('effects-1440');
});

test('effects: sentence title, three lines, Song’s own echo, who-goes-in chips, footer', async () => {
  const t = await wideMount();
  {
    // Sunday Pad + Piano: reverb size .62 (no preset), a fixed 420 ms echo, the Pad sends .35 into the chorus
    assert.equal(await titleText(t),
      'The room is the song’s own, the echo is the song’s own, and the Pad has a medium chorus');
    assert.equal(await text(t, '#view-edit .ev2-title-actions .ev2-fx-vibe-btn'), 'Vibe: Custom');
    assert.deepEqual(await t.ev(() => [...document.querySelectorAll('.ev2-fx-line')].map((l) => l.dataset.line)),
      ['reverb', 'delay', 'chorus']);
    assert.match(await text(t, '[data-line="delay"] .ev2-fx-blurb'),
      /^A fixed 420 ms echo saved with this song, so it doesn’t follow the tempo\.$/);
    const own = await t.ev(() => {
      const b = document.querySelector('[data-preset="echo"] [data-id="own"]');
      const hint = b.querySelector('.ev2-fx-pc-hint').textContent;
      return { hidden: b.hidden, hint, on: b.getAttribute('aria-pressed') };
    });
    assert.deepEqual(own, { hidden: false, hint: '420 ms', on: 'true' });
    // no room preset matches → the Space row's "Song’s own" (round3-edit M3) is shown and pressed
    assert.equal(await pressed(t, 'space'), 'own');
    // Space hints (concept §5 4a); "Song’s own" names the saved room's size
    assert.deepEqual(await t.ev(() => [...document.querySelectorAll('[data-preset="space"] .ev2-fx-pc')]
      .filter((b) => !b.hidden)
      .map((b) => [b.querySelector('.ev2-fx-pc-name').textContent, b.querySelector('.ev2-fx-pc-hint').textContent]
        .join('/'))),
    ['Dry/none', 'Room/small', 'Stage/medium', 'Hall/big', 'Cathedral/huge', 'Ambient Wash/pad-only',
      'Song’s own/large']);

    // who goes in: the same step chips as Perform, bound to slots.<i>.sends.<unit>; empty slots are a disabled "off"
    const chips = await t.ev(() => Object.fromEntries([...document.querySelectorAll('.ev2-fx-mod')].map((c) =>
      [c.dataset.bind, `${c.querySelector('.mc-value')?.textContent}${c.disabled ? ' (disabled)' : ''}`])));
    assert.equal(chips['slots.0.sends.reverb'], '25%');
    assert.equal(chips['slots.1.sends.reverb'], '50%');
    assert.equal(chips['slots.1.sends.chorus'], '35%');
    assert.equal(chips['slots.2.sends.delay'], 'off (disabled)');
    assert.equal(chips['slots.3.sends.chorus'], 'off (disabled)');
    assert.equal(Object.keys(chips).length, 12);

    // footer
    assert.match(await text(t, '.ev2-fx-tape'), /^Tape & finishTape off .*these live on the Master tab$/);
    assert.equal(await text(t, '.ev2-fx-foot .ev2-chg'), 'No switch changes since the song was loaded');

    // an echo preset: store + engine, the chip moves, the title word gets its changed dot, the count goes to 1
    await t.click('[data-preset="echo"] [data-id="dotted"]');
    await t.untilEngine('fx.delay.sync', '1/8d');
    assert.equal(await t.readParam('fx.delay.pingpong'), true);
    assert.equal(await pressed(t, 'echo'), 'dotted');
    assert.match(await titleText(t), /the echo is dotted 8ths/);
    assert.equal(await t.ev(() => document.querySelectorAll('#view-edit .ev2-title .ev2-sent .ev2-cdi').length), 1);
    assert.equal(await text(t, '.ev2-fx-foot .ev2-chg'), '1 change since the song was loaded');
    // synced: the note shows ms at the song's tempo (ms appear only in Edit); time is disabled
    await openSec(t, 'fx-delay');
    const tempo = await t.readParam('song.tempo');
    if (tempo) {
      assert.equal(await text(t, '.ev2-fx-delay-note'),
        `Dotted eighths at ${Math.round(tempo)} BPM = ${Math.round((60 / tempo) * 0.75 * 1000)} ms`);
    }
    assert.equal(await t.ev((s) => document.querySelector(s).disabled, rangeOf('fx.delay.time')), true);
    await t.setParam('song.tempo', null);
    await t.until(() =>
      /need the song’s tempo — set one/.test(document.querySelector('.ev2-fx-delay-note').textContent));
    await t.click('.ev2-fx-delay-note .ev2-fx-link');
    assert.deepEqual(await t.ev(() => [window.__rig.view.editState.selected, window.__rig.view.editState.opts.focus]),
      ['song', 'tempo']);
    if (tempo) await t.setParam('song.tempo', tempo);

    // Song's own writes back only the baseline's fx.delay.*
    await t.setParam('fx.reverb.size', 0.3);
    await t.click('[data-preset="echo"] [data-id="own"]');
    await t.untilEngine('fx.delay.sync', 'off');
    const d = (await t.song()).patch.fx.delay;
    assert.deepEqual(
      { time: d.time, feedback: d.feedback, tone: d.tone, sync: d.sync, pingpong: d.pingpong, rg: d.returnGain },
      { time: 0.42, feedback: 0.3, tone: 0.4, sync: 'off', pingpong: false, rg: 0.8 });
    assert.equal(await t.readParam('fx.reverb.size'), 0.3, 'Song’s own never touches the reverb');
    assert.equal(await pressed(t, 'echo'), 'own');
    assert.match(await titleText(t), /the echo is the song’s own/);

    // round3-edit M3: an audition tap on Hall no longer loses the custom room — Space's "Song’s own" writes the
    // baseline's whole fx.reverb back in one store change, and never touches the echo
    await t.click('[data-preset="space"] [data-id="hall"]');
    await t.untilEngine('fx.reverb.size', 0.65, 1e-6);
    assert.equal(await pressed(t, 'space'), 'hall');
    const delayBefore = (await t.song()).patch.fx.delay;
    const writes = await t.ev(() => {
      window.__fxWrites = 0;
      window.__fxOff = window.__rig.store.subscribe((st, paths) => {
        if (paths.some((p) => p.includes('.patch.fx.reverb'))) window.__fxWrites += 1;
      });
      document.querySelector('[data-preset="space"] [data-id="own"]').click();
      return new Promise((r) => setTimeout(() => {
        window.__fxOff();
        r(window.__fxWrites);
      }, 50));
    });
    assert.equal(writes, 1, 'one store change');
    await t.untilEngine('fx.reverb.size', 0.62, 1e-6);
    const rv = (await t.song()).patch.fx.reverb;
    assert.deepEqual({ size: rv.size, damp: rv.damp, predelay: rv.predelay, returnGain: rv.returnGain },
      { size: 0.62, damp: 0.5, predelay: 0.025, returnGain: 1 });
    assert.deepEqual((await t.song()).patch.fx.delay, delayBefore, 'Space’s own never touches the echo');
    assert.equal(await pressed(t, 'space'), 'own');
    assert.match(await titleText(t), /^The room is the song’s own/);

    // a title token focuses and flashes its control; a line token opens its Fine-tune
    await t.click('#view-edit .ev2-title .ev2-tok');
    await t.until(() => !!document.querySelector('#view-edit .ev2-flash'));
    await t.click('[data-line="chorus"] .ev2-fx-lt-title .ev2-tok');
    await t.until(() => document.querySelector('details[data-sec="fx-chorus"]').open
      && document.activeElement === document.querySelector('[data-bind="fx.chorus.returnGain"] input'));

    // Tape & finish → the Master tab, focused on Tape
    await t.click('.ev2-fx-tape');
    assert.deepEqual(await t.ev(() => [window.__rig.view.editState.selected, window.__rig.view.editState.opts.focus]),
      ['master', 'tape']);
    t.assertNoConsoleErrors();
  }
});

test('effects: presets: Space / Echo / Vibe apply through the store; tweak → Custom (ui-edit port)', async () => {
  const t = await wideMount();
  {
    await t.click('[data-preset="space"] [data-id="hall"]');
    await t.until(() => Math.abs(window.__rig.store.currentSong().patch.fx.reverb.size - 0.65) < 1e-9
      && Math.abs(window.__rig.engine.getParam('fx.reverb.size') - 0.65) < 1e-6);
    assert.equal(await pressed(t, 'space'), 'hall');
    assert.match(await text(t, '[data-line="reverb"] .ev2-fx-blurb'), /concert hall/i);
    assert.match(await titleText(t), /^The room is a Hall,/);

    // Vibe menu (CONTRACT §5): opens with focus on an item, arrows move, Esc closes and returns focus, never panics
    const panics = await t.ev(() => {
      window.__panics = 0;
      const c = window.__rig.controller;
      const orig = c.panic.bind(c);
      c.panic = (...a) => {
        window.__panics += 1;
        return orig(...a);
      };
      return window.__panics;
    });
    await t.page.focus('.ev2-fx-vibe-btn');
    await t.page.keyboard.press('Enter');
    await t.until(() => !document.querySelector('.ev2-fx-vibe-menu').hidden
      && document.activeElement?.getAttribute('role') === 'menuitem' && document.body.dataset.dialogOpen !== undefined);
    assert.equal(await t.ev(() => document.querySelector('.ev2-fx-vibe-btn').getAttribute('aria-expanded')), 'true');
    const first = await t.ev(() => document.activeElement.dataset.id);
    await t.page.keyboard.press('ArrowDown');
    assert.notEqual(await t.ev(() => document.activeElement.dataset.id), first);
    await t.page.keyboard.press('End');
    assert.equal(await t.ev(() => document.activeElement.dataset.id), 'ambient');
    await t.page.keyboard.press('Escape');
    await t.until(() => document.querySelector('.ev2-fx-vibe-menu').hidden
      && document.activeElement === document.querySelector('.ev2-fx-vibe-btn'));
    assert.equal(await t.ev(() => window.__panics), panics, 'Esc in the menu never panics');
    // outside click closes
    await t.click('.ev2-fx-vibe-btn');
    await t.until(() => !document.querySelector('.ev2-fx-vibe-menu').hidden);
    await t.page.screenshot({ path: new URL('../screenshots/effects-vibe-menu.png', import.meta.url).pathname });
    await t.click('[data-line="chorus"] .ev2-fx-blurb');
    await t.until(() => document.querySelector('.ev2-fx-vibe-menu').hidden);

    await t.click('.ev2-fx-vibe-btn');
    await t.click('.ev2-fx-vibe-menu [data-id="set"]');
    await t.until(() => window.__rig.store.currentSong().patch.fx.delay.sync === '1/8d'
      && window.__rig.engine.getParam('fx.delay.pingpong') === true);
    assert.equal(await text(t, '.ev2-fx-vibe-btn'), 'Vibe: Full Set');
    assert.equal(await pressed(t, 'space'), 'stage');
    assert.equal(await pressed(t, 'echo'), 'dotted');
    assert.equal(await t.ev(() => document.querySelector('.ev2-fx-vibe-menu').hidden), true);

    await openSec(t, 'fx-reverb');
    await t.setRange(rangeOf('fx.reverb.size'), 300);
    await t.until(() => !document.querySelector('[data-preset="space"] [aria-pressed="true"]'));
    assert.equal(await text(t, '.ev2-fx-vibe-btn'), 'Vibe: Custom');
    assert.equal(await pressed(t, 'echo'), 'dotted');
    assert.match(await titleText(t), /^The room is the song’s own, the echo is dotted 8ths/);

    await t.click('.ev2-fx-vibe-btn');
    await t.click('.ev2-fx-vibe-menu [data-id="sunday"]');
    await t.until(() => document.querySelector('.ev2-fx-vibe-btn').textContent === 'Vibe: Sunday');
    t.assertNoConsoleErrors();
  }
});

test('effects: FX reverb / delay (sync, pingpong) / chorus reach the engine (ui-edit FX port)', async () => {
  const t = await wideMount();
  try {
    await openSec(t, 'fx-reverb', 'fx-delay', 'fx-chorus');
    await t.setRange(rangeOf('fx.reverb.size'), 800);
    await t.untilEngine('fx.reverb.size', 0.8, 0.002);
    await t.setRange(rangeOf('fx.reverb.returnGain'), 700); // taper: 2·pos³
    await t.untilEngine('fx.reverb.returnGain', 2 * 0.7 ** 3, 0.01);
    await t.setRange(rangeOf('fx.delay.feedback'), 500);
    await t.untilEngine('fx.delay.feedback', 0.45, 0.002);
    await t.page.selectOption(selectOf('fx.delay.sync'), '1/4');
    await t.untilEngine('fx.delay.sync', '1/4');
    assert.ok(await t.ev((s) => document.querySelector(s).disabled, rangeOf('fx.delay.time')),
      'time disabled when synced');
    await t.page.selectOption(selectOf('fx.delay.sync'), 'off');
    await t.until((s) => !document.querySelector(s).disabled, rangeOf('fx.delay.time'));
    await t.setRange(rangeOf('fx.delay.time'), 500);
    await t.until(() => Math.abs(window.__rig.engine.getParam('fx.delay.time') - Math.sqrt(0.05 * 1.5)) < 0.002);
    assert.equal(await text(t, '.ev2-fx-delay-note'), '');
    const pp = await t.engineParam('fx.delay.pingpong');
    await t.click('[data-bind="fx.delay.pingpong"]');
    await t.untilEngine('fx.delay.pingpong', !pp);
    await t.setRange(rangeOf('fx.chorus.depth'), 300);
    await t.untilEngine('fx.chorus.depth', 0.3, 0.002);
    await t.setRange(rangeOf('fx.chorus.rate'), 1000);
    await t.untilEngine('fx.chorus.rate', 3, 0.002);
    await t.setRange(rangeOf('fx.chorus.returnGain'), 0);
    await t.untilEngine('fx.chorus.returnGain', 0, 1e-6);
    assert.match(await text(t, '[data-line="chorus"] .ev2-fx-lt-title'), /^The chorus is off$/);
    assert.match(await text(t, 'details[data-sec="fx-chorus"] .ev2-sec-sum'), /^level off$/);
    assert.match(await text(t, 'details[data-sec="fx-reverb"] .ev2-sec-sum'),
      /^size Huge · darkness \w+ · pre-delay \w+ · level −3\.3 dB$/);
    // double-click resets a word slider to its PARAMS default
    await t.page.dblclick(rangeOf('fx.chorus.depth'));
    await t.untilEngine('fx.chorus.depth', 0.5, 1e-6);
    assert.ok((await t.playAndMeasure(64)) > -50, 'still sounds after FX edits');
    t.assertNoConsoleErrors();
  } finally {
    await t.close(); // last user of the 1440 mount: free the CPU before the 1024 mount
    wide = null;
  }
});

test('effects: 1024×700: opts.focus (mount + update), who-goes-in step panels inside their column, no overflow, '
  + 'store → view in place across a song switch',
  async () => {
    const t = await mountPanelForTest('effects', {
      viewport: { width: 1024, height: 700 }, song: 'Sunday Pad + Piano', panelOpts: { focus: 'chorus' },
    });
    try {
      await t.until(() => document.activeElement === document.querySelector('[data-bind="fx.chorus.depth"] input'));
      await t.select('effects', { focus: 'delay' });
      await t.until(() => !!document.activeElement?.closest('[data-line="delay"] [data-preset="echo"]')
        && document.querySelector('[data-line="delay"]').classList.contains('ev2-flash'));
      await t.select('effects', { focus: 'reverb' });
      await t.until(() => !!document.activeElement?.closest('[data-line="reverb"] [data-preset="space"]'));

      await t.screenshot('effects-1024');
      const over = await t.ev(() => [document.documentElement, ...document.querySelectorAll('#view-edit, #view-edit *')]
        .filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1
          && /auto|scroll/.test(getComputedStyle(e).overflowX))
        .map((e) => `${e.tagName}.${[...e.classList].join('.')} ${e.scrollWidth}>${e.clientWidth}`));
      assert.deepEqual(over, [], 'nothing scrolls horizontally at 1024');
      assert.ok(await t.ev(() => document.documentElement.scrollWidth <= window.innerWidth), 'page fits 1024');
      // every line fits its width (no clipped column): the three grid columns sum to at most the line's width
      assert.deepEqual(await t.ev(() => [...document.querySelectorAll('.ev2-fx-line, .ev2-fx-pchips, .ev2-fx-mods')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className)), []);

      for (const [unit, slot, pick] of [['reverb', 0, 0.75], ['delay', 1, 0.5], ['chorus', 1, 1]]) {
        const chip = `[data-line="${unit}"] [data-bind="slots.${slot}.sends.${unit}"]`;
        await t.click(chip);
        await t.until(() => !!document.querySelector('.ev2-fx-sphost .step-panel'));
        if (unit === 'delay') await t.screenshot('effects-1024-step');
        const geo = await t.ev(([c, u]) => {
          const r = (e) => e.getBoundingClientRect();
          const p = r(document.querySelector('.ev2-fx-sphost .step-panel'));
          const kids = [...document.querySelectorAll('.ev2-fx-sphost .step-panel *')].map(r)
            .filter((k) => k.height > 0);
          const col = r(document.querySelector(`[data-line="${u}"] .ev2-fx-who`));
          const body = r(document.querySelector('#view-edit .ev2-body'));
          return {
            inCol: p.left >= col.left - 1 && p.right <= col.right + 1,
            inBody: p.top >= body.top - 1 && p.bottom <= body.bottom + 1,
            tall: p.height >= 200,
            contained: kids.every((k) => k.top >= p.top - 1 && k.bottom <= p.bottom + 1
              && k.left >= p.left - 1 && k.right <= p.right + 1),
            expanded: document.querySelector(c).getAttribute('aria-expanded'),
            // polish-1 stepChip({placement:'auto'}): below or above the chip (never over it), or covering the column
            placed: (() => {
              const el = document.querySelector('.ev2-fx-sphost .step-panel');
              const ch = r(document.querySelector(c));
              const dir = el.dataset.dir;
              if (dir === 'down') return p.top >= ch.bottom - 1;
              if (dir === 'up') return p.bottom <= ch.top + 1;
              return dir === 'cover';
            })(),
            steps: [...document.querySelectorAll('.ev2-fx-sphost .sp-step')]
              .map((b) => b.textContent.replace('as loaded', '')),
          };
        }, [chip, unit]);
        assert.deepEqual(geo, {
          inCol: true, inBody: true, tall: true, contained: true, expanded: 'true', placed: true,
          steps: ['100%', '75%', '50%', '25%', 'Off'],
        }, `${unit} step panel`);
        await t.click(`.ev2-fx-sphost .sp-step[data-value="${pick}"]`);
        await t.until(() => !document.querySelector('.ev2-fx-sphost .step-panel'));
        await t.untilEngine(`slots.${slot}.sends.${unit}`, pick, 1e-6);
        assert.equal(await t.readParam(`slots.${slot}.sends.${unit}`), pick);
        // the changed dot on the chip (vs the song as loaded)
        assert.equal(await t.ev((c) => !document.querySelector(`${c} .cdi`).hidden, chip), true);
      }
      // the Space hint names the room (concept §5 4b)
      await t.click('[data-preset="space"] [data-id="stage"]');
      await t.click('[data-line="reverb"] [data-bind="slots.0.sends.reverb"]');
      assert.equal(await text(t, '.ev2-fx-sphost .sp-hint'), 'how much of the Keys goes into the Space (Stage)');
      await t.page.keyboard.press('Escape');
      await t.until(() => !document.querySelector('.ev2-fx-sphost .step-panel'));
      // empty slot: disabled, opens nothing
      assert.equal(await t.ev(() => document.querySelector('[data-bind="slots.3.sends.reverb"]').disabled), true);
      // elements survive a song switch; values, the Song's own chip and the who chips follow the new song
      await t.ev(() => {
        document.querySelector('[data-line="delay"]').dataset.mark = '1';
        document.querySelector('[data-bind="slots.2.sends.delay"]').dataset.mark = '1';
      });
      await t.selectSong('Glass Ocean');
      await t.until(() => document.querySelector('[data-bind="slots.2.sends.delay"] .mc-value').textContent === '55%'
        && !document.querySelector('[data-bind="slots.2.sends.delay"]').disabled);
      const r = await t.ev(() => ({
        line: document.querySelector('[data-line="delay"]').dataset.mark,
        chip: document.querySelector('[data-bind="slots.2.sends.delay"]').dataset.mark,
        own: document.querySelector('[data-preset="echo"] [data-id="own"] .ev2-fx-pc-hint').textContent,
        ownOn: document.querySelector('[data-preset="echo"] [data-id="own"]').getAttribute('aria-pressed'),
        blurb: document.querySelector('[data-line="delay"] .ev2-fx-blurb').textContent,
        chg: document.querySelector('.ev2-fx-foot .ev2-chg').textContent,
      }));
      assert.deepEqual(r, {
        line: '1', chip: '1', own: 'dotted 8ths', ownOn: 'true',
        blurb: 'Dotted eighths saved with this song, so it follows the tempo.',
        chg: 'No switch changes since the song was loaded',
      });
      // the Space "Song’s own" (round3-edit M3) is shown exactly when the new song's saved room is no preset
      const so = await t.ev(async () => {
        const { SPACE_PRESETS, matchPreset } = await import('/app/js/shared/fx-presets.js');
        const { describe } = await import('/app/js/shared/params.js');
        const b = window.__rig.view.editState.baseline;
        const get = (p) => b.patch.fx.reverb?.[p.split('.')[2]] ?? describe(p).default;
        return { custom: !matchPreset(SPACE_PRESETS, get),
          hidden: document.querySelector('[data-preset="space"] [data-id="own"]').hidden };
      });
      assert.equal(so.hidden, !so.custom, JSON.stringify(so));
      t.assertNoConsoleErrors();
    } finally {
      await t.close();
    }
  });
