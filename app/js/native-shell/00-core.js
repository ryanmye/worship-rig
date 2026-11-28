// Native shell (2.0, lane N0), document-start script 00: the core of `window.rig` in the Mac / iPad app's WKWebView.
// A classic script, not a module: RigHost (native/apple/Sources/Shared/RigShellRouter.swift, RigShellScripts)
// concatenates every app/js/native-shell/NN-*.js in name order after one config line
//   window.__rigShellConfig = {platform, menuOwnsShortcuts, keepsAwake}
// and injects the result at document start, before any page script. Nothing in Chrome or Electron loads these files
// (no page imports them), so their requests, DOM and listeners are unchanged (UI6 purity).
//
// What this file sets up (every feature file builds on it):
//   window.__rigNative            the native → JS queue that webkitTransport() replays (engine-bridge/transports.js)
//   window.__rigShell             merged, never replaced (NATIVE-GAPS §0 finding 3): {native, platform, shellVersion,
//                                 menu(id), menuReady(), call(m, args)}. Swift calls menu(id) (RigLibrary.emitMenu,
//                                 later the menu bar); the controller adds recording() / library() beside them.
//   window.rig                    {isElectron:false, shell:'native', platform, menuOwnsShortcuts, keepsAwake, onMenu}
//                                 - shell: 'native' is the capability flag the app tests where it means "the Mac / iPad
//                                   app" (isElectron keeps meaning "the Electron process": recorder sinks, ports, …)
//                                 - menuOwnsShortcuts: the native menu binds ⌘. ⌘E ⌘R ⌘⇧F, so the page must not
//                                   (controller keydown); false until lane N5 binds them
//                                 - keepsAwake: the shell holds a display-sleep assertion, so the controller skips
//                                   navigator.wakeLock; false until lane N5
// call(m, args) posts {m, ...args} to webkit.messageHandlers.rigShell (a WKScriptMessageHandlerWithReply; Swift's
// RigShellRouter hands it to the feature that owns `m`) and resolves with the reply, or {error} (never rejects).
(function () {
  'use strict';
  var w = window;
  var cfg = w.__rigShellConfig || {};
  if (!w.__rigNative) w.__rigNative = { queue: [], receive: function (b) { this.queue.push(b); } };
  var shell = w.__rigShell = w.__rigShell || {};
  shell.native = true;
  shell.platform = cfg.platform === 'ipados' ? 'ipados' : 'macos';
  shell.shellVersion = 2;
  if (typeof shell.call === 'function') return; // injected once per document

  var menu = [];
  shell.menu = function (id) {
    menu.slice().forEach(function (cb) {
      try { cb(id); } catch (e) { console.warn(e); }
    });
  };
  shell.menuReady = function () { return menu.length > 0; };
  shell.call = function (m, a) {
    var h = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.rigShell;
    if (!h || typeof h.postMessage !== 'function') return Promise.resolve({ error: 'shell unavailable' });
    var p;
    try {
      p = h.postMessage(Object.assign({}, a || {}, { m: m }));
    } catch (e) {
      return Promise.resolve({ error: String((e && e.message) || e) });
    }
    return Promise.resolve(p).then(function (r) {
      return r === undefined || r === null ? { error: 'no reply' } : r;
    }, function (e) {
      return { error: String((e && e.message) || e) };
    });
  };

  if (w.rig) return; // a window.rig that is not ours: leave it alone (the feature files check rig.shell too)
  w.rig = {
    isElectron: false,
    shell: 'native',
    platform: shell.platform,
    menuOwnsShortcuts: cfg.menuOwnsShortcuts === true,
    keepsAwake: cfg.keepsAwake === true,
    onMenu: function (cb) {
      if (typeof cb !== 'function') return function () {};
      menu.push(cb);
      return function () { menu = menu.filter(function (f) { return f !== cb; }); };
    },
  };
})();
