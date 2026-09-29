'use strict';
// Worship Rig preload (sandboxed, CommonJS) → window.rig (SPEC §7).
// Every method returns a Promise; failures resolve to {error}. onMenu(cb) returns an unsubscribe function.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((err) => ({ error: (err && err.message) || String(err) }));

const toArrayBuffer = (data) => {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return data;
};

/** ipcRenderer.on wrapper: cb(payload); a throwing handler is logged, never kills the channel. Returns unsubscribe. */
const listen = (channel, cb) => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_e, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.warn(`[rig] ${channel} handler failed`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// Menu-bar mode: main.js reports main-window visibility (hide-on-close, openMain, dock click, focus…) as a DOM event,
// since with backgroundThrottling off `visibilitychange` may never fire. The controller listens for
// 'rig:window-visible' {detail:{visible}}. Non-boolean payloads are ignored.
ipcRenderer.on('rig:window-visible', (_e, visible) => {
  if (typeof visible !== 'boolean') return;
  window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible } }));
});

contextBridge.exposeInMainWorld('rig', {
  isElectron: true,
  platform: process.platform,
  /** @returns {Promise<{path}|null>} */
  saveFileDialog: (defaultName) => call('rig:saveFileDialog', defaultName),
  /** path: absolute (from saveFileDialog) or a bare file name (→ ~/Music/Worship Rig/). @returns {Promise<{id, path}>} */
  streamOpen: (p) => call('rig:streamOpen', p),
  streamWrite: (id, buf) => call('rig:streamWrite', id, toArrayBuffer(buf)),
  streamPatchHeader: (id, buf44) => call('rig:streamPatchHeader', id, toArrayBuffer(buf44)),
  /** @returns {Promise<{path, bytes}>} */
  streamClose: (id) => call('rig:streamClose', id),
  /** @returns {Promise<{path, baseUrl}|null>} */
  choosePadFolder: () => call('rig:choosePadFolder'),
  /** @returns {Promise<string>} '/pads/<token>/' */
  padsBaseUrl: () => call('rig:padsBaseUrl'),
  /** @returns {Promise<Array<{name, path, url}>|{error:'missing'}>} */
  listPads: () => call('rig:listPads'),
  /** kind: 'library' (default, rotated) | 'unreadable' (raw text of a library that could not be read; kept apart). @returns {Promise<{path}>} */
  backupNow: (json, kind) => call('rig:backupNow', json, kind),
  /** Newest library backup. @returns {Promise<{path, origin, savedAt, text}|{error}>} */
  latestBackup: () => call('rig:latestBackup'),
  /**
   * @returns {Promise<{version, electron, platform, userData, port, preferredPort, portChanged, reusedServer,
   *   otherLibrary:{path, origin, savedAt}|null, padsRoot, userSamplesDir, userSampleRoots, recordingsDir, backupsDir}>}
   */
  getInfo: () => call('rig:getInfo'),
  /** kind: 'recordings'|'backups'|'pads'|'userSamples' */
  openFolder: (kind) => call('rig:openFolder', kind),
  /**
   * "My Samples" folder (GarageBand conversions / your own packs): the folder the importer writes to and all scan roots.
   * @returns {Promise<{path:string, exists:boolean, roots:string[]}>}
   */
  userSamplesDir: () => call('rig:userSamplesDir'),
  /** Opens the My Samples folder in Finder (created, with a README.txt, if missing). @returns {Promise<{ok, path}|{error, path}>} */
  openUserSamplesFolder: () => call('rig:openUserSamplesFolder'),
  /**
   * Server re-scan of the My Samples roots (the engine still needs engine.reloadManifests() or a restart).
   * @returns {Promise<{count:number, instruments:{id,name,pack}[], packs:{slug,dir,count}[], roots:string[], errors:string[]}>}
   */
  rescanUserSamples: () => call('rig:rescanUserSamples'),
  revealFile: (p) => call('rig:revealFile', p),
  /** Open a bundled doc: 'garageband-import' | 'architecture' | … (docs/<name>.md) or 'readme'. @returns {Promise<{ok}|{error}>} */
  openDoc: (name) => call('rig:openDoc', name),
  /** cb(id) with id ∈ panic|fadeOutAll|nextSong|prevSong|toggleView|record|restartAudio|openSettings|importLatestBackup|rescanUserSamples */
  onMenu: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, id) => {
      try {
        cb(id);
      } catch (err) {
        console.warn('[rig] menu handler failed', err);
      }
    };
    ipcRenderer.on('rig:menu', listener);
    return () => ipcRenderer.removeListener('rig:menu', listener);
  },

  // ---- menu-bar mode bus (docs/menubar-mode.md; main.js relays). Messages are JSON strings: {"v":1, …}. ----
  /** Main renderer: publish the bus `state` (≤ 64 KB). @returns {Promise<{ok, seq}|{error}>} */
  busPublish: (stateJson) => call('rig:busPublish', stateJson),
  /** Main renderer: cb(commandJson) for every popover/tray command (never `openMain`). Returns an unsubscribe. */
  onBusCommand: (cb) => listen('rig:busCommand', cb),
  /**
   * Popover: cb(stateJson) for every published state, starting with the last one (if any) right away.
   * States arrive in order; a stale "last state" reply never overwrites a newer push. Returns an unsubscribe.
   */
  miniSubscribe: (cb) => {
    if (typeof cb !== 'function') return () => {};
    let seen = 0;
    let live = true;
    const deliver = (json, seq) => {
      if (!live || typeof json !== 'string' || !(seq > seen)) return;
      seen = seq;
      try {
        cb(json);
      } catch (err) {
        console.warn('[rig] miniSubscribe handler failed', err);
      }
    };
    const listener = (_e, json, seq) => deliver(json, seq);
    ipcRenderer.on('rig:miniState', listener);
    call('rig:miniLastState').then((r) => r && !r.error && deliver(r.json, r.seq));
    return () => {
      live = false;
      ipcRenderer.removeListener('rig:miniState', listener);
    };
  },
  /** Popover (or any page of ours): send a bus `command` (≤ 4 KB, validated). @returns {Promise<{ok}|{error}>} */
  miniCommand: (commandJson) => call('rig:miniCommand', commandJson),
  /** Mirror settings.menuBarMode to main (tray, hide-on-close, dock). @returns {Promise<MenuBarState|{error}>} */
  setMenuBarMode: (on) => call('rig:setMenuBarMode', on),
  /** @returns {Promise<{on, popoverOpen, loginItem, windowVisible, tray}>} */
  getMenuBarState: () => call('rig:getMenuBarState'),
  /** "Open at login" (packaged app only; opens hidden). @returns {Promise<MenuBarState|{error}>} */
  setLoginItem: (on) => call('rig:setLoginItem', on),
  /** cb({on, popoverOpen, loginItem, windowVisible, tray}) whenever one of them changes. Returns an unsubscribe. */
  onMenuBarState: (cb) => listen('rig:menuBarState', cb),
});
