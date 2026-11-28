// Native shell, document-start script 20: app facts for Settings › About (Swift: RigInfo, a RigShellFeature).
//   rig.getInfo() → {version, build, shell:'native', platform, userData, port:0, portChanged:false, otherLibrary:null,
//                    padsRoot, userSamplesDir, userSampleRoots, recordingsDir, backupsDir} | {error}
// The 1.x shape (main.js 'rig:getInfo') minus `electron`; port 0 / portChanged false / otherLibrary null because the
// rig://app origin never changes (no M5 "other library"). padsRoot stays null until lane N4 (the D11 pad check reads
// it). userSamplesDir stays null so Settings › My Samples asks /api/user-samples (lane N1: the iPad's Files name).
(function () {
  'use strict';
  var rig = window.rig;
  var shell = window.__rigShell;
  if (!rig || rig.shell !== 'native' || !shell || typeof shell.call !== 'function') return;
  rig.getInfo = function () { return shell.call('getInfo'); };
})();
