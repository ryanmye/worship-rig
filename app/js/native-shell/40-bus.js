// Native shell, document-start script 40 (remote lane, D45; native/docs/lanes/REMOTE.md §2.6): the Mac command bus
// and the browser remote. Swift side: RigBus (native/apple/Sources/Shared/RigBus.swift) over rig_bus.h / rig_remote.h.
//   rig.busPublish(stateJson)  → {ok:true} | {error}: Swift checks it (rig_bus_check_state, bus.js's rules and
//                                main.js's 64 KB cap) and hands it to the remote (later also N7's popover)
//   rig.onBusCommand(cb)       → cb(commandJson) for each command the shell relays; returns unsubscribe. Swift calls
//                                __rigShell.bus(json). shared/bus.js parses and checks it again, as with Electron.
//   rig.remote (macOS only)    = {info(), setEnabled(on), newCode(), forgetAll(), onInfo(cb)}: Settings › Remote.
//                                info() etc. resolve with the rig_remote_info_json object (or {error}); onInfo(cb) gets
//                                the same object whenever it changes (Swift calls __rigShell.remoteInfo(jsonText)).
// shared/bus.js picks its transport per method, so with busPublish / onBusCommand here the controller's bus goes
// through the shell instead of BroadcastChannel.
(function () {
  'use strict';
  var rig = window.rig;
  var shell = window.__rigShell;
  if (!rig || rig.shell !== 'native' || !shell || typeof shell.call !== 'function') return;
  if (typeof rig.busPublish === 'function') return; // injected twice into one document

  var commandCbs = [];
  rig.busPublish = function (json) {
    return shell.call('busPublish', { json: typeof json === 'string' ? json : JSON.stringify(json) });
  };
  rig.onBusCommand = function (cb) {
    if (typeof cb !== 'function') return function () {};
    commandCbs.push(cb);
    return function () { commandCbs = commandCbs.filter(function (f) { return f !== cb; }); };
  };
  shell.bus = function (json) {
    if (typeof json !== 'string') return;
    commandCbs.slice().forEach(function (cb) {
      try { cb(json); } catch (e) { console.warn('[rig] bus command handler failed', e); }
    });
  };

  if (rig.platform !== 'macos') return; // the browser remote is served by the Mac app (D34)
  var infoCbs = [];
  rig.remote = {
    info: function () { return shell.call('remoteInfo'); },
    setEnabled: function (on) { return shell.call('remoteSetEnabled', { on: on === true }); },
    newCode: function () { return shell.call('remoteNewCode'); },
    forgetAll: function () { return shell.call('remoteForgetAll'); },
    onInfo: function (cb) {
      if (typeof cb !== 'function') return function () {};
      infoCbs.push(cb);
      return function () { infoCbs = infoCbs.filter(function (f) { return f !== cb; }); };
    },
  };
  shell.remoteInfo = function (text) {
    var info;
    try { info = JSON.parse(text); } catch (e) { return; }
    infoCbs.slice().forEach(function (cb) {
      try { cb(info); } catch (e) { console.warn('[rig] remote info handler failed', e); }
    });
  };
})();
