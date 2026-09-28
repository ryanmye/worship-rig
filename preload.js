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
});
