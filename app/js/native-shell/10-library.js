// Native shell, document-start script 10: library backups (Swift: RigLibrary, a RigShellFeature).
//   rig.backupNow(json, kind)  → {path} | {error}   the rotation in the shell's backups folder ('library' newest 10,
//                                                   'unreadable' newest 5), as main.js
//   rig.latestBackup()         → {path, origin, savedAt, text, via} | {error}   a staged file (picker / AirDrop /
//                                                   first-launch offer) once, else the newest good library file
// Moved verbatim (behaviour) from the Swift string RigLibrary.polyfill (lane N0).
(function () {
  'use strict';
  var rig = window.rig;
  var shell = window.__rigShell;
  if (!rig || rig.shell !== 'native' || !shell || typeof shell.call !== 'function') return;
  rig.backupNow = function (json, kind) {
    return shell.call('backupNow', { json: typeof json === 'string' ? json : JSON.stringify(json), kind: kind });
  };
  rig.latestBackup = function () { return shell.call('latestBackup'); };
})();
