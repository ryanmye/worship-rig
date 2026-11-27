// UI v6 polish batch 2 (native/docs/lanes/UI6-build-plan.md "Queued small tasks", UI6-polish1 O1): the v6 Perform's
// overlays (Quick sheet, a strip's step panel, popovers, the range pick, a dialog) opt in to overlay.js
// `underModal`, so the Esc that closes Settings over them never closes them (U7c F3, polish1 F1 for the bank); their
// own next Esc still does, without a panic. Today's Perform (flag off) is unchanged: the same Esc closes its Quick
// sheet too, as before. Run from run.mjs on its page (the v6 Perform is on).

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, settled, setSlots, assert, armPanics}
 */
export async function polish2Tests(x) {
  const { T, page, ev, until, tid, setSlots, assert, armPanics } = x;
  const toPerform = async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
  };
  /** Each overlay: open it (resolves once open), and whether it is open. */
  const OVERLAYS = {
    quick: {
      open: async () => {
        await ev(() => window.__rig.views.v6.openQuick());
        await until(() => window.__rig.views.v6.quickOpen);
      },
      isOpen: () => ev(() => window.__rig.views.v6.quickOpen),
    },
    step: {
      open: async () => {
        await page.click(tid('v6-space-0'));
        await until(() => !!document.querySelector('.v6 .step-panel, .v6 [data-testid^="v6-space-0-panel"]')
          || document.querySelector('[data-testid="v6-space-0"]')?.getAttribute('aria-expanded') === 'true');
      },
      isOpen: () => ev(() => document.querySelector('[data-testid="v6-space-0"]')
        ?.getAttribute('aria-expanded') === 'true'),
    },
    popover: {
      open: async () => {
        await page.click(tid('v6-more-0'));
        await until(() => !!document.querySelector('[data-testid="v6-menu-0"]'));
      },
      isOpen: () => ev(() => !!document.querySelector('[data-testid="v6-menu-0"]')),
    },
    pick: {
      open: async () => {
        await ev(() => window.__rig.views.v6.kb.pick(0));
        await until(() => window.__rig.views.v6.kb.picked === 0);
      },
      isOpen: () => ev(() => window.__rig.views.v6.kb.picked === 0),
    },
    dialog: {
      open: async () => {
        await page.click(tid('v6-snap-save'));
        await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
      },
      isOpen: () => ev(() => !!document.querySelector('[data-testid="v6-savesnap"]')),
    },
  };
  const settingsOpen = () => ev(() => document.body.classList.contains('settings-open'));

  await T('polish2 O1: the Esc that closes Settings keeps the v6 Quick sheet, step panel, popover, range pick and '
    + 'dialog open (no panic); their own next Esc closes them (D24.7 off and on)', async () => {
    await toPerform();
    await setSlots(3);
    await armPanics();
    try {
      for (const esc of [null, true]) {
        await ev((v) => window.__rig.store.set('settings.escPanics', v), esc);
        for (const [k, o] of Object.entries(OVERLAYS)) {
          await o.open();
          await ev(() => window.__rig.ctx.openSettings());
          await until(() => document.body.classList.contains('settings-open'));
          await page.waitForTimeout(100);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
          const r = { settings: await settingsOpen(), open: await o.isOpen(), panics: await ev(() => window.__panics) };
          assert.deepEqual(r, { settings: false, open: true, panics: 0 }, `${k}, escPanics ${esc}`);
          await page.keyboard.press('Escape'); // its own Esc (with "Esc always panics" on, that one panics too)
          await page.waitForTimeout(150);
          assert.equal(await o.isOpen(), false, `${k}: its own Esc closes it`);
          // (a dialog's Esc never panics: its name field has the focus, main.js escTyping / escModalOpen)
          assert.equal(await ev(() => window.__panics), esc && k !== 'dialog' ? 1 : 0,
            `${k}: the second Esc, escPanics ${esc}`);
          await armPanics();
        }
      }
    } finally {
      await ev(() => window.__rig.store.set('settings.escPanics', null));
      await ev(() => window.__rig.ctx.closeSettings());
      await ev(() => window.__rig.views.v6?.kb.pick(null));
    }
  });

  await T('polish2 O1: today’s Perform (flag off) unchanged: the Esc that closes Settings also closes its Quick '
    + 'sheet, as before', async () => {
    assert.equal(await ev(() => window.__rig.setUiV6(false)), false);
    try {
      await until(() => !!document.querySelector('#view-perform > .perform'));
      await toPerform();
      await ev(() => window.__rig.views.perform.openQuick());
      await until(() => window.__rig.views.perform.quickOpen);
      await ev(() => window.__rig.ctx.openSettings());
      await until(() => document.body.classList.contains('settings-open'));
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      assert.deepEqual({ settings: await settingsOpen(), quick: await ev(() => window.__rig.views.perform.quickOpen) },
        { settings: false, quick: false });
    } finally {
      await ev(() => window.__rig.ctx.closeSettings());
      await ev(() => window.__rig.setUiV6(true));
      await until(() => !!window.__rig.views.v6);
    }
  });
}
