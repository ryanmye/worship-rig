/* Worship Rig theme boot (themes-setup; OPTIONS.md §3.1 #7 "flash-free boot", app/themes/README.md).
   A classic script, no modules and no imports, so it runs synchronously in <head> before first paint.
   index.html and mini.html include it TWICE:
     1. first thing in <head>: reads the localStorage mirror of settings.theme, sets html[data-theme]/[data-mode] and
        color-scheme, starts fetching the theme file (rel=preload), and writes body[data-theme]/[data-mode] as soon as
        <body> exists;
     2. last thing in <head>: appends <link rel=stylesheet id=theme-css blocking=render>. Being last matters: themes
        use zero-specificity :where() rules that win on source order, so the theme file must follow the app's CSS.
        (A script can only add render-blocking sheets while <body> does not exist yet, so it can't wait for <body>.)
   A page that includes it once still gets the sheet, at DOMContentLoaded (not render-blocking).
   The id → {css, mode, body} map below is a COPY of app/js/shared/themes.js (THEMES); test/unit/shared/themes.test.mjs
   fails when the two drift. `body` = the legacy <body> attributes a theme file still guards on (see themes.js). */
(function () {
  'use strict';
  var w = window;
  var d = document;
  var root = d.documentElement;
  if (w.__rigThemeBoot) { // second include
    w.__rigThemeBoot.link();
    return;
  }
  var KEY = 'worship-rig.theme';
  var DEF = 'sanctuary';
  var MAP = {
    'classic': { css: null, mode: 'dark' },
    'sanctuary': { css: '/themes/sanctuary-v2/theme.css', mode: 'dark', body: ['sanctuary-v2', 'dark'] },
    'sanctuary-day': { css: '/themes/sanctuary-v2/theme.css', mode: 'light', body: ['sanctuary-v2', 'light'] },
    'daylight-stage': { css: '/themes/daylight-v2/theme.css', mode: 'dark', body: ['daylight-v2', 'dusk'] },
    'daylight-day': { css: '/themes/daylight-v2/theme.css', mode: 'light', body: ['daylight-v2', 'day'] },
    'studio': { css: '/themes/studio/theme.css', mode: 'dark', body: ['studio', 'dark'] },
    'ember': { css: '/themes/ember/theme.css', mode: 'dark', body: ['ember', 'dark'] },
    'nave': { css: '/themes/sanctuary/theme.css', mode: 'dark', body: ['sanctuary', 'dark'] }
  };
  var id = null;
  try {
    id = w.localStorage.getItem(KEY);
  } catch (e) { /* storage blocked: default */ }
  if (!id || !Object.prototype.hasOwnProperty.call(MAP, id)) id = DEF;
  var t = MAP[id];
  root.setAttribute('data-theme', id);
  root.setAttribute('data-mode', t.mode);
  root.style.colorScheme = t.mode;
  var bodyTheme = t.body ? t.body[0] : id;
  var bodyMode = t.body ? t.body[1] : t.mode;
  function setBody(b) {
    b.setAttribute('data-theme', bodyTheme);
    b.setAttribute('data-mode', bodyMode);
  }
  if (d.body) {
    setBody(d.body);
  } else if (typeof MutationObserver === 'function') {
    var mo = new MutationObserver(function () {
      if (!d.body) return;
      mo.disconnect();
      if (!d.body.hasAttribute('data-theme')) setBody(d.body);
    });
    mo.observe(root, { childList: true });
  }
  function link() {
    if (!t.css || d.getElementById('theme-css') || !d.head) return;
    var l = d.createElement('link');
    l.rel = 'stylesheet';
    l.id = 'theme-css';
    l.href = t.css;
    if (!d.body) l.setAttribute('blocking', 'render');
    d.head.appendChild(l);
  }
  if (t.css && d.head) {
    var pre = d.createElement('link');
    pre.rel = 'preload';
    pre.as = 'style';
    pre.href = t.css;
    d.head.appendChild(pre);
  }
  d.addEventListener('DOMContentLoaded', function () {
    if (d.body && !d.body.hasAttribute('data-theme')) setBody(d.body);
    link();
  });
  w.__rigThemeBoot = { key: KEY, def: DEF, map: MAP, id: id, link: link };
})();
