// Native shell, document-start script 30: saving files (lane N3, release blocker B2; Swift: RigFiles, a
// RigShellFeature).
//   rig.saveText(name, text) → {saved:true, name, path?} | {canceled:true} | {error}
//       the Mac's save panel (NSSavePanel) or the iPad's Files export picker (UIDocumentPickerViewController
//       forExporting); the two download() helpers (views/settings.js, views/edit/lib.js) call it first, so Settings ›
//       Export library, Edit's Export library / Export song and the v6 song menu's Export never touch <a download>
//       here. `path` is the chosen file on the Mac, absent on the iPad (Files does not say where it went).
// The belt (NATIVE-GAPS finding 8, n0-skeptic O1): any other click on an <a download> whose href is blob: or data:
// is taken over here, before WebKit sees it. Its default is prevented, so WKWebView never starts a navigation for it
// (a main-frame commit would replace the UI and, since N0, send `play panic` + `rec stop`, ending a recording); the
// content is read at once (fetch resolves the blob URL synchronously, so a later revokeObjectURL cannot race the
// panel) and saved through the same `saveFile` call: text types as text, anything else as base64. Swift also
// cancels a main-frame blob: / data: navigation and turns a real download into a WKDownload (RigNavigation), for
// what this listener cannot see (an anchor clicked outside the document).
// Import needs nothing here: <input type=file> opens NSOpenPanel through the UI delegate's runOpenPanelWith (Mac) or
// WebKit's own picker (iPad), and the page reads the File as in Chrome.
(function () {
  'use strict';
  var w = window;
  var rig = w.rig;
  var shell = w.__rigShell;
  if (!rig || rig.shell !== 'native' || !shell || typeof shell.call !== 'function') return;
  if (typeof rig.saveText === 'function') return; // injected once per document
  /** RigFiles.maxBytes: the largest file the shell writes (a library export is a few MB). */
  var MAX_BYTES = 64 * 1024 * 1024;
  var TEXT_TYPE = /^(text\/|application\/(json|javascript|xml)\b|[a-z]+\/[a-z0-9.+-]*\+(json|xml)\b)/i;

  rig.saveText = function (name, text) {
    return shell.call('saveFile', {
      name: name === undefined || name === null ? '' : String(name),
      text: typeof text === 'string' ? text : String(text),
    });
  };

  function base64(buf) {
    var b = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return w.btoa(s);
  }

  /** Reads a blob: / data: URL and saves it as `name`. Resolves with the saveFile reply (never rejects). */
  function saveUrl(href, name) {
    var read;
    try {
      read = w.fetch(href).then(function (r) { return r.blob(); });
    } catch (e) {
      read = Promise.reject(e);
    }
    return read.then(function (blob) {
      if (blob.size > MAX_BYTES) return { error: 'file too large' };
      if (TEXT_TYPE.test(blob.type || '')) return blob.text().then(function (t) { return rig.saveText(name, t); });
      return blob.arrayBuffer().then(function (buf) {
        return shell.call('saveFile', { name: name, base64: base64(buf) });
      });
    }).then(function (r) {
      if (r && r.error) console.warn('[rig] could not save ' + name + ': ' + r.error);
      return r;
    }, function (e) {
      var msg = String((e && e.message) || e);
      console.warn('[rig] could not read ' + name + ' to save it: ' + msg);
      return { error: msg };
    });
  }

  /** The <a download> a click lands on (the target or an ancestor), or null. */
  function downloadAnchor(ev) {
    var path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n || n.nodeType !== 1) continue;
      if (String(n.tagName).toUpperCase() === 'A' && n.hasAttribute('download')) return n;
    }
    return null;
  }

  if (typeof w.addEventListener !== 'function') return;
  // window, capture phase: the first listener of every click, so nothing in the page can let one through
  w.addEventListener('click', function (ev) {
    if (ev.defaultPrevented) return; // nothing will be followed anyway
    var a = downloadAnchor(ev);
    if (!a) return;
    var href = String(a.href || a.getAttribute('href') || '');
    if (!/^(blob|data):/i.test(href)) return; // rig:// downloads are WKDownloads (RigNavigation)
    ev.preventDefault();
    saveUrl(href, a.getAttribute('download') || 'download');
  }, true);
})();
