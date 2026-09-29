// Selector extraction for the theme coverage check (test/phase2/themes/run.mjs; OPTIONS.md §3.1 #8).
// Not a CSS parser: a brace/paren/string-aware walk that is enough for the theme files (native nesting, one guard
// block, @media/@supports inside it). Nested selectors are resolved the way CSS nesting does (`&` = :is(parent),
// no `&` = descendant of the parent). Pseudo-elements and user-action pseudo-classes (:hover, :focus…) are dropped,
// so the selector is checked against the element it styles. @font-face / @keyframes / @property bodies are skipped.
import fs from 'node:fs';
import path from 'node:path';

const GROUP_AT = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'document']);
const PSEUDO_EL = /::[\w-]+(\([^)]*\))?|:(?:before|after|first-line|first-letter)(?![\w-])/g;
const USER_ACTION = /:(?:hover|active|focus-visible|focus-within|focus|visited|target)(?![\w-])/g;

/** Split on top-level commas (not inside (), [] or strings). */
export function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A nested part → the selector the DOM is queried with (null = nothing to check), and why not. */
function resolvePart(part, parentList) {
  let p = part.replace(PSEUDO_EL, '');
  if (!p.trim()) return { match: null, why: 'pseudo-element only' };
  if (parentList !== null && parentList !== undefined) {
    if (!parentList) return { match: null, why: 'parent not checkable' };
    const par = `:is(${parentList})`;
    p = p.includes('&') ? p.replace(/&/g, par) : `${par} ${p}`;
  }
  let m = p.replace(USER_ACTION, '');
  for (let k = 0; k < 4; k++) m = m.replace(/:(?:not|is|where|has)\(\s*\)/g, '');
  m = m.trim();
  if (!m || /[>+~]$/.test(m)) m = `${m} *`.trim();
  return { match: m, why: null };
}

/**
 * @param {string} css a theme file
 * @returns {Array<{part:string, context:string, line:number, match:string|null, why:string|null}>} one entry per
 *   comma-separated selector of every style rule (top-level and nested)
 */
export function parseThemeSelectors(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const stack = []; // {kind:'rule', list:string|null, raw:string} | {kind:'group'} | {kind:'skip'}
  let buf = '';
  let paren = 0;
  let q = null;
  let line = 1;
  const nearestRule = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === 'rule') return stack[i];
    return null;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    if (q) {
      buf += c;
      if (c === '\\') buf += src[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      buf += c;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    if (paren > 0) {
      buf += c;
      continue;
    }
    if (c === ';') {
      buf = '';
      continue;
    }
    if (c === '}') {
      stack.pop();
      buf = '';
      continue;
    }
    if (c !== '{') {
      buf += c;
      continue;
    }
    const pre = buf.trim().replace(/\s+/g, ' ');
    buf = '';
    if (stack.some((s) => s.kind === 'skip')) {
      stack.push({ kind: 'skip' });
      continue;
    }
    if (pre.startsWith('@')) {
      const name = (/^@([\w-]+)/.exec(pre) || [])[1] || '';
      stack.push({ kind: GROUP_AT.has(name) ? 'group' : 'skip' });
      continue;
    }
    const parent = nearestRule();
    const parts = splitTop(pre);
    const resolved = [];
    for (const part of parts) {
      const r = resolvePart(part, parent ? parent.list : null);
      out.push({ part, context: parent ? parent.raw : '', line, match: r.match, why: r.why });
      if (r.match) resolved.push(r.match);
    }
    const raw = parent ? `${parent.raw} › ${pre}` : pre;
    stack.push({ kind: 'rule', list: resolved.join(', '), raw: raw.length > 160 ? `…${raw.slice(-157)}` : raw });
  }
  return out;
}

/** Class names a selector part names (attribute values and strings ignored). */
export function classesOf(part) {
  const s = part.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, '').replace(/\[[^\]]*\]/g, '');
  return [...new Set([...s.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
}

/**
 * @param {string} appDir the app/ folder
 * @returns {(cls:string) => boolean} true when the class still appears in app/ outside app/themes (JS, HTML or CSS),
 *   literally or as a built name (`slot-${i}`, 'is-' + x)
 */
export function deadClassFinder(appDir) {
  const skip = new Set(['themes', 'samples', 'fonts', 'assets', 'icons']);
  const texts = [];
  const walk = (dir, top) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (top && skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (/\.(m?js|html|css)$/.test(e.name)) texts.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(appDir, true);
  const corpus = texts.join('\n');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cache = new Map();
  return (cls) => {
    if (cache.has(cls)) return cache.get(cls);
    let ok = new RegExp(`(^|[^\\w-])${esc(cls)}([^\\w-]|$)`).test(corpus);
    for (let k = cls.lastIndexOf('-'); !ok && k >= 2; k = cls.lastIndexOf('-', k - 1)) {
      const prefix = cls.slice(0, k + 1);
      ok = new RegExp(`(^|[^\\w-])${esc(prefix)}(\\$\\{|['"\`]\\s*\\+)`).test(corpus);
    }
    cache.set(cls, ok);
    return ok;
  };
}
