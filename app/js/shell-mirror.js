// v11-electron: mirror this machine's Electron-only settings to Electron main, the way main.js mirrors
// settings.menuBarMode: settings.hotkeys → rig.setHotkeys (globalShortcut) and settings.updateCheck →
// rig.setUpdateCheck (the once-a-day "update available" check). The store stays the source of truth; main only
// follows it, and does nothing before the first mirror arrives. In Chrome (no window.rig) this is a no-op.
import { hotkeysOf } from './shared/hotkeys.js';

/**
 * Start mirroring. Sends the current values once, then every change.
 * @param {{store: {get: Function, subscribe: Function}, rig?: object|null}} o
 * @returns {() => void} stop
 */
export function mirrorShellSettings({ store, rig = globalThis.rig || null }) {
  const canHotkeys = !!(rig && typeof rig.setHotkeys === 'function');
  const canUpdates = !!(rig && typeof rig.setUpdateCheck === 'function');
  if (!canHotkeys && !canUpdates) return () => {};
  let lastHotkeys = null;
  let lastUpdate = null;
  const warn = (what) => (r) => {
    if (r && r.error) console.warn(`[rig] ${what}:`, r.error);
  };
  function sync(state) {
    const s = state.settings;
    if (canHotkeys) {
      const hk = JSON.stringify(hotkeysOf(s));
      if (hk !== lastHotkeys) {
        lastHotkeys = hk;
        Promise.resolve(rig.setHotkeys(JSON.parse(hk))).then(warn('setHotkeys'), () => {});
      }
    }
    if (canUpdates) {
      const on = s.updateCheck !== false; // absent = on
      if (on !== lastUpdate) {
        lastUpdate = on;
        Promise.resolve(rig.setUpdateCheck(on)).then(warn('setUpdateCheck'), () => {});
      }
    }
  }
  const off = store.subscribe((state, paths) => {
    // cheap (a JSON compare), so any settings change re-checks; a replace-import reports deep paths
    if (!paths || paths.some((p) => p === 'settings' || p.startsWith('settings.'))) sync(state);
  });
  sync(store.get());
  return () => {
    if (typeof off === 'function') off();
  };
}
