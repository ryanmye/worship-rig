// OWNER: song agent (views/edit/CONTRACT.md §6). Tests for panels/song.js (block 'song': Easy Transpose, tempo,
// notes). Ports ui-edit "Easy Transpose", the tempo field of "tap tempo", the notes half of "song name + notes" and
// the notes/tempo half of "round2-ui #3".
// Run alone: node test/phase2/edit-v2/run.mjs --only song
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

// One shared mount (1440, resized to 1024 for the last test): every mount costs 10–45 s on the shared 2-CPU box, and
// node:test's per-test timeout also bounds the whole file.
let t;
before(async () => {
  t = await mountPanelForTest('song');
});
after(async () => {
  await t?.close();
  await shutdown();
});

const titleText = (t) => t.page.textContent('#view-edit .ev2-title .ev2-sent');

test('song: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  await smoke(t);
  assert.match(await titleText(t), /^This song is in \S+, you play in \S+/);
  for (const sec of ['song-key', 'song-tempo', 'song-notes']) {
    assert.ok(await t.page.$(`${t.host} [data-sec="${sec}"]`), `section ${sec}`);
  }
  await t.screenshot('song-1440');
});

test('song: Easy Transpose — Play In / Hear In / octave / minor → engine transpose, key names, readout, title',
  async () => {
    const H = t.host;
    const sel = (a) => `${H} select[data-bind="${a}"]`;
    await t.page.selectOption(sel('song.playIn'), '0');
    await t.page.selectOption(sel('song.hearIn'), '2');
    await t.until(() => window.__rig.engine.transpose === 2);
    assert.match(await t.page.textContent(`${H} .ev2-song-readout`), /Play in C, sounds in D \(\+2 semitones\)/);
    assert.match(await titleText(t), /This song is in D, you play in C/);
    // the key changed since load → the title's key word carries the white dot
    await t.until(() => !!document.querySelector('#view-edit .ev2-title .ev2-cdi'));
    await t.click(`${H} [data-bind="song.transposeOctave"] button[data-value="1"]`);
    await t.until(() => window.__rig.engine.transpose === 14);
    assert.match(await titleText(t), /an octave up/);
    await t.click(`${H} [data-bind="song.transposeOctave"] button[data-value="0"]`);
    await t.until(() => window.__rig.engine.transpose === 2);
    await t.page.selectOption(sel('song.hearIn'), '10'); // Bb → −2 (shortest way)
    await t.until(() => window.__rig.engine.transpose === -2);
    assert.equal(await t.page.textContent(`${sel('song.hearIn')} option[value="10"]`), 'Bb');
    await t.click(`${H} [data-bind="song.minor"]`);
    await t.until((s) => document.querySelector(`${s} option[value="1"]`).textContent === 'C#m', sel('song.hearIn'));
    assert.equal(await t.page.textContent(`${sel('song.playIn')} option[value="1"]`), 'C#m');
    assert.match(await t.page.textContent(`${H} .ev2-song-readout`), /Bbm/);
    assert.match(await titleText(t), /in Bbm/);
    await t.click(`${H} [data-bind="song.minor"]`);
    await t.page.selectOption(sel('song.hearIn'), '0');
    await t.until(() => window.__rig.engine.transpose === 0);
    assert.match(await t.page.textContent(`${H} .ev2-song-readout`), /No transpose — you hear what you play \(C\)\./);
    // store → view in place: an outside write moves the select and the readout
    await t.setParam('song.hearIn', 7);
    await t.until((s) => document.querySelector(s).value === '7', sel('song.hearIn'));
    assert.match(await t.page.textContent(`${H} .ev2-song-readout`), /sounds in G/);
    t.assertNoConsoleErrors();
  });

test('song: tempo field (Enter commits, clamps, empty → null), Clear, Tap button, tapper rules', async () => {
  const H = t.host;
  const input = `${H} .ev2-song-tempo`;
  assert.equal(await t.page.getAttribute(input, 'data-bind'), 'song.tempo');
  await t.page.fill(input, '96');
  await t.page.press(input, 'Enter');
  await t.until(() => window.__rig.store.currentSong().tempo === 96);
  await t.until(() => window.__rig.engine.tempo === 96);
  assert.match(await titleText(t), /at 96 BPM/);
  await t.page.fill(input, '999');
  await t.page.press(input, 'Enter');
  await t.until(() => window.__rig.store.currentSong().tempo === 300);
  assert.equal(await t.page.inputValue(input), '300', 'the field shows what the store kept');
  await t.page.fill(input, '');
  await t.page.press(input, 'Enter');
  await t.until(() => window.__rig.store.currentSong().tempo === null);
  assert.match(await titleText(t), /no set tempo/);
  assert.equal(await t.page.isDisabled(`${H} .ev2-song-clear`), true, 'Clear is off with no tempo');
  await t.setParam('song.tempo', 88);
  await t.until((s) => document.querySelector(s).value === '88', input);
  await t.click(`${H} .ev2-song-clear`);
  await t.until(() => window.__rig.store.currentSong().tempo === null);
  await t.until((s) => document.querySelector(s).value === '', input);

  // the panel's Tap: 2 taps set a tempo, and the button flashes
  await t.ev(async () => {
    const b = document.querySelector('[data-tap="panel"]');
    b.click();
    await new Promise((r) => setTimeout(r, 400));
    b.click();
  });
  await t.until(() => window.__rig.store.currentSong().tempo !== null);
  assert.ok(await t.ev(() => document.querySelector('[data-tap="panel"]').classList.contains('ev2-song-flash')));

  // tapper rules with a fake clock: 500 ms → 120; > 2 s gap starts over; < 30 BPM is not written
  const r = await t.ev(async () => {
    const { createTapper } = await import('/app/js/views/edit/panels/song.js');
    let now = 0;
    const out = [];
    const tp = createTapper((b) => out.push(b), () => now);
    for (const at of [0, 500, 1000, 1500]) {
      now = at;
      tp.tap();
    }
    now = 5000; // gap > 2 s: starts over, one tap writes nothing
    tp.tap();
    now = 7000; // 2000 ms → 30 BPM, the edge still counts
    tp.tap();
    now = 9001; // > 2 s again
    tp.tap();
    return out;
  });
  assert.deepEqual(r, [120, 120, 120, 30]);
  t.assertNoConsoleErrors();
});

test('song: notes — debounced 500 ms, flushed on blur, song-bound (round2-ui #3 notes + tempo)', async () => {
  const H = t.host;
  const area = `${H} textarea.ev2-song-notes`;
  assert.equal(await t.page.getAttribute(area, 'placeholder'), 'Notes for this song (shown in Perform)');
  // debounce: nothing is written while typing; the write lands ≥ 500 ms after the last input
  const d = await t.ev(async (s) => {
    const a = document.querySelector(s);
    const st = window.__rig.store;
    a.focus();
    a.value = 'Verse soft, chorus big.';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    const t0 = performance.now();
    const immediate = st.currentSong().notes;
    while (st.currentSong().notes !== 'Verse soft, chorus big.' && performance.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return { immediate, ms: performance.now() - t0, final: st.currentSong().notes };
  }, area);
  assert.notEqual(d.immediate, 'Verse soft, chorus big.', 'not written on the keystroke');
  assert.equal(d.final, 'Verse soft, chorus big.');
  assert.ok(d.ms >= 450, `debounced (${d.ms.toFixed(0)} ms)`);
  // blur flushes at once
  const b = await t.ev((s) => {
    const a = document.querySelector(s);
    a.focus();
    a.value = 'Bridge: drop out.';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    a.blur();
    return window.__rig.store.currentSong().notes;
  }, area);
  assert.equal(b, 'Bridge: drop out.');

  // round2-ui #3: text typed before a non-pointer (MIDI) song switch goes to the song it was typed in
  const [a, bId] = await t.ev(() => {
    const st = window.__rig.store;
    const ids = st.navIds();
    const cur = st.currentSong().id;
    return [cur, ids.find((x) => x !== cur && st.getSong(x).name !== st.getSong(cur).name)];
  });
  const snap = () => t.ev(([x, y]) => {
    const st = window.__rig.store;
    const f = (s) => ({ name: s.name, notes: s.notes, tempo: s.tempo });
    return { a: f(st.getSong(x)), b: f(st.getSong(y)) };
  }, [a, bId]);
  const s0 = await snap();
  await t.click(area);
  await t.page.keyboard.press('Control+End');
  await t.page.keyboard.type(' x');
  await t.selectSong(bId);
  await t.page.keyboard.type('y');
  await t.sleep(700);
  let s1 = await snap();
  assert.equal(s1.b.notes, s0.b.notes, 'B’s notes not replaced by A’s text');
  assert.equal(s1.a.notes, `${s0.a.notes || ''} x`, 'A keeps what was typed in it');
  assert.equal(await t.page.inputValue(area), s0.b.notes || '', 'the notes field shows B');
  // tempo
  await t.selectSong(a);
  await t.page.fill(`${H} .ev2-song-tempo`, '97');
  await t.selectSong(bId);
  s1 = await snap();
  assert.equal(s1.a.tempo, 97);
  assert.equal(s1.b.tempo, s0.b.tempo, 'B’s tempo unchanged');
  assert.equal(await t.page.inputValue(`${H} .ev2-song-tempo`),
    s0.b.tempo === null ? '' : String(Math.round(s0.b.tempo)), 'the tempo field shows B');
  t.assertNoConsoleErrors();
});

test('song: opts.focus key / notes in update() (same instance); title tokens jump to their control', async () => {
  const H = t.host;
  await t.ev((h) => {
    document.querySelector(`${h} [data-sec="song-key"]`).__mark = 1;
  }, H);
  await t.select('song', { focus: 'notes' });
  await t.until(() => document.activeElement?.matches('textarea.ev2-song-notes'));
  await t.select('song', { focus: 'key' });
  await t.until(() => document.activeElement?.dataset.bind === 'song.playIn');
  const k = await t.ev((h) => {
    const sec = document.querySelector(`${h} [data-sec="song-key"]`);
    return { flash: sec.classList.contains('ev2-flash'), mark: sec.__mark };
  }, H);
  assert.equal(k.flash, true, 'the section flashes');
  assert.equal(k.mark, 1, 'update(), not a remount');
  // title token "in D" → the Hear In select
  await t.ev(() => document.activeElement?.blur());
  await t.click('#view-edit .ev2-title .ev2-tok');
  await t.until(() => document.activeElement?.dataset.bind === 'song.hearIn');
  await t.until(() => !!document.querySelector('#view-edit .ev2-flash'));
  // the last token is the tempo
  await t.ev(() => [...document.querySelectorAll('#view-edit .ev2-title .ev2-tok')].pop().click());
  await t.until(() => document.activeElement?.dataset.bind === 'song.tempo');
  t.assertNoConsoleErrors();
});

test('song: polish-1 text:"dirty" — tempo and notes follow outside writes while focused until typed in', async () => {
  const H = t.host;
  const id = await t.ev(() => window.__rig.store.currentSong().id);
  const outside = (rel, v) => t.ev(([i, r, x]) => window.__rig.store.set(`songs.${i}.${r}`, x), [id, rel, v]);
  // tempo: focused and untouched → follows; typed → keeps the draft; Enter commits the draft
  const tempo = `${H} .ev2-song-tempo`;
  await t.click(tempo);
  await outside('tempo', 88);
  await t.until((s) => document.querySelector(s).value === '88', tempo);
  // L-9: ControlOrMeta, not Control. Playwright on macOS maps Control+A to moveToBeginningOfParagraph (caret to 0), so
  // '13' landed before '88' = '1388' on the Mac (2/2); Linux Chromium has no Emacs bindings and selected all.
  await t.page.keyboard.press('ControlOrMeta+A');
  await t.page.keyboard.type('13');
  await outside('tempo', 99);
  await t.sleep(80);
  assert.equal(await t.page.inputValue(tempo), '13', 'a typed draft is not overwritten');
  await t.page.keyboard.type('2');
  await t.page.keyboard.press('Enter');
  await t.until((i) => window.__rig.store.getSong(i).tempo === 132, id);
  assert.equal(await t.page.inputValue(tempo), '132');
  // focused again (fresh focus = clean): an outside write shows at once
  await t.click(tempo);
  await outside('tempo', 76);
  await t.until((s) => document.querySelector(s).value === '76', tempo);
  await t.ev(() => document.activeElement.blur());
  // notes: focused and untouched → follows; typed → draft kept while focused
  const area = `${H} textarea.ev2-song-notes`;
  await t.click(area);
  await outside('notes', 'From the header.');
  await t.until((s) => document.querySelector(s).value === 'From the header.', area);
  await t.page.keyboard.press('Control+End');
  await t.page.keyboard.type(' Mine');
  await outside('notes', 'Someone else.');
  await t.sleep(60);
  assert.equal(await t.page.inputValue(area), 'From the header. Mine', 'the notes draft stays');
  await t.ev(() => document.activeElement.blur()); // flushes the draft (last writer wins, as before)
  await t.until((i) => window.__rig.store.getSong(i).notes === 'From the header. Mine', id);
  await outside('notes', '');
  await outside('tempo', null);
  t.assertNoConsoleErrors();
});

test('song: L-9 — tempo and notes drafts stay exactly as typed under an outside write storm (store.set / 20 ms)',
  async (tc) => {
    tc.after(() => t.ev(() => clearInterval(window.__l9))); // a failed assertion must not leave the storm running
    const H = t.host;
    const id = await t.ev(() => window.__rig.store.currentSong().id);
    const storm = (rel, vals) => t.ev(([i, r, vs]) => {
      window.__l9n = 0;
      window.__l9 = setInterval(() => window.__rig.store.set(`songs.${i}.${r}`, vs[window.__l9n++ % vs.length]), 20);
    }, [id, rel, vals]);
    const outsideSet = (rel, v) => t.ev(([i, r, x]) => window.__rig.store.set(`songs.${i}.${r}`, x), [id, rel, v]);
    const calm = () => t.ev(() => {
      clearInterval(window.__l9);
      return window.__l9n;
    });
    const typeSlow = async (text) => {
      for (const ch of text) {
        await t.page.keyboard.type(ch);
        await t.sleep(25); // storm writes land between the keys
      }
    };
    // tempo: follows while untyped; select-all, writes before the first key (still selected: replaced, never
    // appended), then every key while writes keep coming; Enter commits exactly the typed text
    const tempo = `${H} .ev2-song-tempo`;
    const tempos = [61, 88, 99, 147, 203];
    await t.click(tempo);
    await storm('tempo', tempos);
    await t.sleep(120);
    assert.ok(tempos.map(String).includes(await t.page.inputValue(tempo)), 'the untyped field follows the storm');
    await t.page.keyboard.press('ControlOrMeta+A');
    await t.sleep(60);
    await typeSlow('132');
    await t.sleep(200);
    assert.equal(await t.page.inputValue(tempo), '132', 'tempo draft is exactly the typed text');
    assert.ok(await calm() > 10, 'the storm ran');
    await t.page.keyboard.press('Enter');
    await t.until((i) => window.__rig.store.getSong(i).tempo === 132, id);
    assert.equal(await t.page.inputValue(tempo), '132');
    // notes: > 500 ms of storm after typing, so the debounced commit fires mid-storm and must not re-apply a stale
    // value; on blur the field shows what the store holds (the storm's last write came after that commit)
    const area = `${H} textarea.ev2-song-notes`;
    const notes = ['Storm one.', 'Storm two, longer.', 'S3'];
    await t.click(area);
    await storm('notes', notes);
    await t.sleep(120);
    assert.ok(notes.includes(await t.page.inputValue(area)), 'the untyped notes follow the storm');
    await t.page.keyboard.press('ControlOrMeta+A');
    await t.sleep(60);
    await typeSlow('Typed under fire');
    await t.sleep(700);
    assert.equal(await t.page.inputValue(area), 'Typed under fire', 'notes draft is exactly the typed text');
    assert.ok(await calm() > 10, 'the storm ran');
    await t.ev(() => document.activeElement.blur());
    await t.sleep(60);
    const kept = await t.ev((i) => window.__rig.store.getSong(i).notes, id);
    assert.ok(notes.includes(kept), 'the storm wrote after the debounced commit (last writer wins)');
    assert.equal(await t.page.inputValue(area), kept, 'after blur the field shows the store, not the stale draft');
    // and a draft typed after the storm is what blur commits
    await t.click(area);
    await t.page.keyboard.press('ControlOrMeta+A');
    await t.page.keyboard.type('Mine.');
    await t.ev(() => document.activeElement.blur());
    await t.until((i) => window.__rig.store.getSong(i).notes === 'Mine.', id);
    assert.equal(await t.page.inputValue(area), 'Mine.');
    // the debounced commit, then outside writes that bring the store back to the value the field had before the
    // draft: blur shows the store, never the committed-then-superseded draft (focusout re-applies forced)
    await t.click(area);
    await t.page.keyboard.press('ControlOrMeta+A');
    await t.page.keyboard.type('Stale draft');
    await t.until((i) => window.__rig.store.getSong(i).notes === 'Stale draft', id); // the 500 ms debounce
    await outsideSet('notes', 'Elsewhere');
    await outsideSet('notes', 'Mine.');
    await t.ev(() => document.activeElement.blur());
    await t.sleep(60);
    assert.equal(await t.page.inputValue(area), 'Mine.', 'blur shows the store after a debounced commit');
    await t.ev(([i]) => {
      window.__rig.store.set(`songs.${i}.notes`, '');
      window.__rig.store.set(`songs.${i}.tempo`, null);
    }, [id]);
    t.assertNoConsoleErrors();
  });

test('song: 1024×700 — focus on mount, fits with no horizontal (or vertical) scroll, change line', async () => {
  // the same page, resized and remounted with {focus:'tempo'} (a second boot doubles the cost on the loaded box)
  const u = t;
  await u.page.setViewportSize({ width: 1024, height: 700 });
  // the Revert snapshot = the song as it is now (main.js getBaseline), so the change line starts from zero
  await u.ev(() => window.__rig.setBaseline(JSON.parse(JSON.stringify(window.__rig.store.currentSong()))));
  await u.ev(() => window.__rig.view.remount({ focus: 'tempo' }));
  assert.equal(await u.ev(() => document.activeElement?.dataset.bind), 'song.tempo', '{focus:"tempo"} on mount');
  const chg = `${u.host} .ev2-chg`;
  const tempo = await u.readParam('song.tempo');
  const next = tempo === 140 ? 141 : 140;
  await u.setParam('song.tempo', next);
  await u.until((s) => /1 change since/.test(document.querySelector(s).textContent), chg);
  // the focused but untouched tempo field follows an outside write (Tap in the header)
  assert.equal(await u.page.inputValue(`${u.host} .ev2-song-tempo`), String(next));
  await u.setParam('song.name', 'Renamed but not counted');
  await u.sleep(100);
  assert.match(await u.page.textContent(chg), /^1 change since/);
  const o = await u.ev(() => {
    const bad = [];
    for (const e of document.querySelectorAll('#view-edit .ev2, #view-edit .ev2 *')) {
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible') bad.push(e.className);
    }
    const body = document.querySelector('#view-edit .ev2-body');
    return {
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      bad,
      vscroll: body.scrollHeight > body.clientHeight + 1,
    };
  });
  assert.ok(o.page, 'page does not scroll sideways');
  assert.deepEqual(o.bad, [], 'no host scrolls sideways');
  assert.equal(o.vscroll, false, 'the panel fits at 1024×700');
  await u.screenshot('song-1024');
  u.assertNoConsoleErrors();
});
