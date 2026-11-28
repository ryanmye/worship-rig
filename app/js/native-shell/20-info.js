// Native shell, document-start script 20: app facts for Settings › About (Swift: RigInfo, a RigShellFeature).
//   rig.getInfo() → {version, build, shell:'native', platform, userData, port:0, portChanged:false, otherLibrary:null,
//                    padsRoot, userSamplesDir, userSampleRoots, recordingsDir, backupsDir} | {error}
// The 1.x shape (main.js 'rig:getInfo') minus `electron`; port 0 / portChanged false / otherLibrary null because the
// rig://app origin never changes (no M5 "other library"). padsRoot / userSamplesDir stay null until lanes N4 / N2:
// the D11 pad check and Settings › My Samples read them, and a null keeps both on their "not here" paths.
(function () {
  'use strict';
  var rig = window.rig;
  var shell = window.__rigShell;
  if (!rig || rig.shell !== 'native' || !shell || typeof shell.call !== 'function') return;
  rig.getInfo = function () { return shell.call('getInfo'); };
})();
