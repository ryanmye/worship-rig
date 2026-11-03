// Settings suite, "mac" mode: the in-app GarageBand / Logic importer dialog (v11-importer, views/settings-import.js)
// against mac.mjs's fake window.rig (garageBandScan / garageBandImport / garageBandCancel / onGarageBandProgress
// standing in for main.js + importer-host.js). The worker itself is tested in test/unit/exs/importer.test.mjs and
// test/unit/shell/importer-host.test.mjs, and through the real IPC in test/phase1/shell/electron.importer.mjs.
import path from 'node:path';
import assert from 'node:assert/strict';

const MB = 1048576;
/** A scan answer: two importable instruments, one already installed, one whose sounds are not downloaded. */
export const FAKE_SCAN = {
  ok: true,
  out: '/Users/ryan/Music/Worship Rig/Samples',
  roots: [{ path: '/Library/Application Support/GarageBand/Instrument Library', exists: true }],
  encoder: { encoder: 'ffmpeg', format: 'mp3', ffmpeg: true, afconvert: true, error: null },
  instruments: [
    { key: 'k-classical', name: 'Classical Grand', id: 'classical-grand', origin: 'GarageBand', category: 'piano',
      source: 'GarageBand Instrument Library/Sampler/Classical Grand.exs', zones: 104, layers: 2, notes: 104,
      found: 52, needed: 52, sourceBytes: 98 * MB, estBytes: 9.9 * MB, consolidated: false, installed: false },
    { key: 'k-strings', name: 'Silk Strings', id: 'silk-strings', origin: 'Logic', category: 'strings',
      source: 'Logic Sampler Instruments/Strings/Silk Strings.exs', zones: 40, layers: 1, notes: 20, found: 0,
      needed: 20, sourceBytes: 0, estBytes: 4 * MB, consolidated: false, installed: false },
    { key: 'k-yamaha', name: 'Yamaha Grand Piano', id: 'yamaha-grand-piano', origin: 'Logic', category: 'piano',
      source: 'Logic Sampler Instruments/01 Acoustic Pianos/Yamaha Grand Piano.exs', zones: 688, layers: 3,
      notes: 252, found: 249, needed: 249, sourceBytes: 412 * MB, estBytes: 35.8 * MB, consolidated: false,
      installed: true },
  ],
  parseErrors: 0,
  truncated: false,
  limits: { maxPerImport: 40, maxTotalMb: 2048 },
};

/**
 * @param {{page: import('playwright').Page, T: Function, ev: Function, until: Function, openSettings: Function,
 *   calls: Function, SHOTS: string}} d  mac.mjs's helpers
 */
export async function runImporterTests({ page, T, ev, until, openSettings, calls, SHOTS }) {
  const dlg = '[data-testid="gb-dialog"]';
  const text = (s) => page.textContent(s);
  const push = (snap) => ev((x) => window.__fake.gbPush(x), snap);
  const item = (key, name, patch) => ({ key, name, state: 'waiting', done: 0, files: 0, ...patch });

  await T('GarageBand import: one quiet button (Mac app); opening scans and lists sizes; missing sounds can’t be ticked', async () => {
    await ev((scan) => {
      window.__fake.gbScan = scan;
    }, FAKE_SCAN);
    await openSettings();
    const open = page.locator('[data-testid="gb-open"]');
    await open.scrollIntoViewIfNeeded();
    assert.equal(await open.textContent(), 'Import from GarageBand / Logic…');
    assert.equal(await page.isHidden(dlg), true, 'no dialog until asked');
    assert.equal(await page.isHidden('[data-testid="gb-line"]'), true);
    assert.equal(await page.locator('.st-samples .st-howto-steps').count(), 0, 'the Mac app has the button, not the Terminal steps');
    assert.equal((await calls('garageBandScan')).length, 0, 'nothing scans before the button is pressed');
    await open.click();
    await until(() => !document.querySelector('[data-testid="gb-dialog"]').hidden);
    await until(() => !!document.querySelector('[data-testid="gb-scanning"]') || !!document.querySelector('[data-testid="gb-list"]'));
    await until(() => !!document.querySelector('[data-testid="gb-list"]'));
    assert.equal((await calls('garageBandScan')).length, 1);
    assert.equal(await text('[data-testid="gb-license"]'), 'For your own use on this Mac. Apple’s sounds must not be shared or copied to other people.');
    assert.equal(await page.locator('[data-testid="gb-encoder"]').count(), 0, 'ffmpeg found: nothing to say');
    const rows = await ev(() => [...document.querySelectorAll('.st-gb-row')].map((r) => ({
      id: r.dataset.id, name: r.querySelector('.st-gb-name').textContent, size: r.querySelector('.st-gb-size').textContent,
      flag: r.querySelector('.st-gb-flag')?.textContent || '', disabled: r.querySelector('input').disabled })));
    assert.deepEqual(rows, [
      { id: 'classical-grand', name: 'Classical Grand', size: 'about 9.9 MB', flag: '', disabled: false },
      { id: 'silk-strings', name: 'Silk Strings', size: 'about 4.0 MB', flag: 'Sounds not downloaded', disabled: true },
      { id: 'yamaha-grand-piano', name: 'Yamaha Grand Piano', size: 'about 36 MB', flag: 'Already in My Samples (imports again)', disabled: false },
    ]);
    assert.equal(await text('[data-testid="gb-summary"]'), 'Tick the instruments you want.');
    assert.equal(await page.isDisabled('[data-testid="gb-import"]'), true, 'nothing ticked: Import is off');
    // no absolute library path is ever shown in the list (keys and labels only)
    assert.equal(await ev(() => /\/Library\/Application Support/.test(document.querySelector('[data-testid="gb-list"]').textContent)), false);
  });

  await T('GarageBand import: search narrows the list; ticking shows the count and the estimate; Esc closes the dialog only', async () => {
    await page.fill('[data-testid="gb-filter"]', 'grand');
    await until(() => document.querySelectorAll('.st-gb-row').length === 2);
    await page.click('[data-testid="gb-pick-classical-grand"]');
    await page.click('[data-testid="gb-pick-yamaha-grand-piano"]');
    assert.equal(await text('[data-testid="gb-summary"]'), '2 instruments · about 46 MB');
    assert.equal(await page.isEnabled('[data-testid="gb-import"]'), true);
    await page.fill('[data-testid="gb-filter"]', '');
    await until(() => document.querySelectorAll('.st-gb-row').length === 3);
    assert.equal(await page.isChecked('[data-testid="gb-pick-classical-grand"]'), true, 'the search keeps the ticks');
    await ev(() => document.activeElement?.blur?.());
    await page.locator('.st-gb-card').screenshot({ path: path.join(SHOTS, 'mac-gb-import-list.png') });
    await page.keyboard.press('Escape');
    await until(() => document.querySelector('[data-testid="gb-dialog"]').hidden);
    assert.equal(await ev(() => window.__rig.views.settings.isOpen), true, 'Settings stays open');
    assert.equal(await ev(() => document.documentElement.hasAttribute('data-gb-import')), false);
    // reopening keeps the list and the ticks (no second scan)
    await page.click('[data-testid="gb-open"]');
    await until(() => !!document.querySelector('[data-testid="gb-list"]'));
    assert.equal((await calls('garageBandScan')).length, 1);
    assert.equal(await page.isChecked('[data-testid="gb-pick-yamaha-grand-piano"]'), true);
  });

  await T('GarageBand import: Import → per-instrument progress → done → My Samples is rescanned once', async () => {
    const rescans = (await calls('rescanUserSamples')).length;
    await page.click('[data-testid="gb-import"]');
    await until(() => !!document.querySelector('[data-testid="gb-progress"]'));
    assert.deepEqual((await calls('garageBandImport')).at(-1), ['k-classical', 'k-yamaha'], 'keys only, no paths');
    assert.equal(await text('[data-testid="gb-cancel"]'), 'Stop');
    const startedAt = Date.now();
    const base = { state: 'importing', startedAt, total: 2, imported: 0, failed: 0 };
    await push({ ...base, items: [item('k-classical', 'Classical Grand', { state: 'converting', done: 13, files: 52 }),
      item('k-yamaha', 'Yamaha Grand Piano')] });
    await until(() => /13 of 52 files/.test(document.querySelector('[data-testid="gb-progress"]').textContent));
    assert.equal(await text('[data-testid="gb-progress-summary"]'), 'Importing 1 of 2…');
    assert.equal(await ev(() => document.querySelector('.st-gb-prow[data-key="k-classical"] progress').value), 13);
    assert.equal(await ev(() => document.querySelector('.st-gb-prow[data-key="k-classical"] progress').max), 52);
    await ev(() => document.activeElement?.blur?.());
    await page.locator('.st-gb-card').screenshot({ path: path.join(SHOTS, 'mac-gb-import-progress.png') });
    // closing the dialog while it runs: a line under the button says how far it is
    await page.click('[data-testid="gb-close"]');
    await until(() => document.querySelector('[data-testid="gb-dialog"]').hidden);
    await push({ ...base, items: [item('k-classical', 'Classical Grand', { state: 'done', done: 52, files: 52, notes: 104 }),
      item('k-yamaha', 'Yamaha Grand Piano', { state: 'converting', done: 5, files: 252 })], imported: 1, current: 1 });
    await until(() => document.querySelector('[data-testid="gb-line"]').textContent === 'Importing 2 of 2…');
    assert.equal(await page.isVisible('[data-testid="gb-line"]'), true);
    assert.equal((await calls('rescanUserSamples')).length, rescans, 'no rescan until the run ends');
    await page.click('[data-testid="gb-open"]');
    await until(() => !!document.querySelector('[data-testid="gb-progress"]'));
    await push({ ...base, state: 'done', imported: 2, finishedAt: Date.now(), items: [
      item('k-classical', 'Classical Grand', { state: 'done', done: 52, files: 52, notes: 104 }),
      item('k-yamaha', 'Yamaha Grand Piano', { state: 'done', done: 252, files: 252, notes: 252, missing: 3 })] });
    await until(() => document.querySelector('[data-testid="gb-progress-summary"]').textContent === '2 instruments are in My Samples now.');
    await until((n) => window.__fake.calls.filter((c) => c[0] === 'rescanUserSamples').length === n + 1, rescans);
    await until(() => /instrument picker under “My Samples”/.test(document.querySelector('[data-testid="gb-rescan-state"]').textContent));
    assert.match(await text('.st-gb-prow[data-key="k-yamaha"] .st-gb-state'), /^Done: 252 notes \(3 sounds missing\)$/);
    // a repeated "done" snapshot does not rescan again
    await push({ ...(await ev(() => window.__fake.gbStatus)) });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await calls('rescanUserSamples')).length, rescans + 1);
    await page.click('[data-testid="gb-more"]');
    await until(() => !!document.querySelector('[data-testid="gb-list"]'));
    assert.equal(await text('.st-gb-row[data-id="classical-grand"] .st-gb-flag'), 'Already in My Samples (imports again)');
    assert.equal(await page.isChecked('[data-testid="gb-pick-classical-grand"]'), false, 'the ticks are cleared');
  });

  await T('GarageBand import: Stop → "Stopping…" → nothing imported, no rescan; errors in plain words', async () => {
    const rescans = (await calls('rescanUserSamples')).length;
    await page.click('[data-testid="gb-pick-classical-grand"]');
    await page.click('[data-testid="gb-import"]');
    await until(() => !!document.querySelector('[data-testid="gb-cancel"]'));
    const startedAt = Date.now() + 1;
    await push({ state: 'importing', startedAt, total: 1, imported: 0, failed: 0,
      items: [item('k-classical', 'Classical Grand', { state: 'converting', done: 2, files: 52 })] });
    await page.click('[data-testid="gb-cancel"]');
    await until(() => window.__fake.calls.some((c) => c[0] === 'garageBandCancel'));
    await until(() => document.querySelector('[data-testid="gb-cancel"]')?.textContent === 'Stopping…');
    await push({ state: 'cancelled', startedAt, total: 1, imported: 0, failed: 0, finishedAt: Date.now(),
      items: [item('k-classical', 'Classical Grand', { state: 'cancelled', done: 2, files: 52 })] });
    await until(() => document.querySelector('[data-testid="gb-progress-summary"]').textContent === 'Stopped. Nothing was imported.');
    assert.equal(await text('.st-gb-prow[data-key="k-classical"] .st-gb-state'), 'Not imported');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await calls('rescanUserSamples')).length, rescans, 'nothing new: no rescan');
    // a refused import (main's limits / disk space) is said in plain words and the list stays
    await page.click('[data-testid="gb-more"]');
    await until(() => !!document.querySelector('[data-testid="gb-list"]'));
    await ev(() => {
      window.__fake.gbImportReply = { error: 'no-space' };
    });
    await page.click('[data-testid="gb-pick-yamaha-grand-piano"]');
    await page.click('[data-testid="gb-import"]');
    await until(() => /enough free disk space/.test(document.querySelector('[data-testid="gb-error"]')?.textContent || ''));
    assert.equal(await page.isVisible('[data-testid="gb-list"]'), true);
    await ev(() => {
      window.__fake.gbImportReply = null;
    });
  });

  await T('GarageBand import: no ffmpeg → a plain-words note (m4a via the Mac); no converter at all → Import stays off', async () => {
    await ev((scan) => {
      window.__fake.gbScan = { ...scan, encoder: { encoder: 'afconvert', format: 'm4a', ffmpeg: false, afconvert: true, error: null } };
    }, FAKE_SCAN);
    await page.click('[data-testid="gb-scan"]');
    await until(() => !!document.querySelector('[data-testid="gb-encoder"]'));
    assert.match(await text('[data-testid="gb-encoder"]'), /^ffmpeg isn’t installed, so Worship Rig uses the Mac’s own converter.*brew install ffmpeg/);
    assert.deepEqual((await calls('garageBandScan')).at(-1), { reindex: true }, 'Scan again rebuilds the sample index');
    await ev((scan) => {
      window.__fake.gbScan = { ...scan, encoder: { encoder: null, format: null, ffmpeg: false, afconvert: false, error: 'no-encoder' } };
    }, FAKE_SCAN);
    await page.click('[data-testid="gb-scan"]');
    await until(() => /No audio converter was found/.test(document.querySelector('[data-testid="gb-encoder"]')?.textContent || ''));
    await page.click('[data-testid="gb-pick-classical-grand"]');
    assert.equal(await page.isDisabled('[data-testid="gb-import"]'), true);
    // nothing installed at all → the GarageBand download hint
    await ev((scan) => {
      window.__fake.gbScan = { ...scan, instruments: [] };
    }, FAKE_SCAN);
    await page.click('[data-testid="gb-scan"]');
    await until(() => !!document.querySelector('[data-testid="gb-empty"]'));
    assert.match(await text('[data-testid="gb-empty"]'), /Download All Available Sounds/);
    await ev((scan) => {
      window.__fake.gbScan = scan;
    }, FAKE_SCAN);
    // Esc closes the dialog, a second Esc closes Settings
    await page.keyboard.press('Escape');
    await until(() => document.querySelector('[data-testid="gb-dialog"]').hidden);
    await page.keyboard.press('Escape');
    await until(() => !window.__rig.views.settings.isOpen);
  });

  await T('GarageBand import: closing Settings closes the dialog; the computer keyboard never played meanwhile', async () => {
    await openSettings();
    await page.click('[data-testid="gb-open"]');
    await until(() => !document.querySelector('[data-testid="gb-dialog"]').hidden);
    // the panel covers Settings' Close button: the shell closes Settings (e.g. ⌘, or a menu) while it is open
    await ev(() => window.__rig.ctx.closeSettings());
    await until(() => !window.__rig.views.settings.isOpen);
    assert.equal(await page.isHidden(dlg), true);
    assert.equal(await ev(() => document.documentElement.hasAttribute('data-gb-import')), false);
    assert.equal(await ev(() => window.__rig.controller.status.activeNotes?.length ?? 0), 0);
  });
}
