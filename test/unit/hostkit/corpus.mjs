// Lane N1: generated inputs for the hostkit parity test (parity.test.mjs). Deterministic (seeded); nothing here is
// committed output, and no audio is involved: the "packs" are JSON files built in a temp folder at test time.
//   jsonCases(n)     byte strings for JSON.parse / JSON.stringify (valid, near-valid, broken, random bytes)
//   textCases(n)     byte strings for Node's UTF-8 decode, .length, .slice(0, 40), .trim()
//   nameCases(n, a)  file / folder names for localeCompare(numeric, base) from alphabet `a`
//   buildTree(dir, variant)  a My Samples tree of patch packs; returns its roots
import fs from 'node:fs';
import path from 'node:path';

/** mulberry32 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/** WTF-8 bytes of a JS string (a lone surrogate as its 3-byte form), the way hostkit holds text. */
export function wtf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Buffer.from(out);
}

const STR_PIECES = ['a', 'Z', ' ', 'é', 'ß', '漢', '🎹', '\\n', '\\t', '\\"', '\\\\', '\\/', '\\u0000', '\\u001f',
  '\\u00e9', '\\ud800', '\\udc00', '\\ud83c\\udfb9', '\\uD83C\\uDFB9', '\\ud83c', '\\u2028', ' ', '\u007f', '\\b',
  '\\f', '\\r', '\\u0041', '\\uFFFF', '\\ufeff', '﻿'];
const NUMS = ['0', '-0', '1', '-1', '5.0', '1.50', '1e2', '1E+2', '1e-2', '-0.0e-0', '0.1', '1e21', '1e-7', '123e-9',
  '1e400', '-1e400', '1e-400', '9007199254740993', '18446744073709551615', '18446744073709551616',
  '123456789012345678901234567890', '2.2250738585072011e-308', '4.9e-324', '1.7976931348623157e308',
  '1.7976931348623159e308', '0.30000000000000004', '100', '1e1000000', '0.000001', '0.0000001', '123456789012345680000'];
const KEYS = ['a', 'b', 'id', 'bank', 'patch', 'slots', '0', '1', '10', '01', '-1', '4294967294', '4294967295',
  '__proto__', 'constructor', 'é', '🎹', '', 'name', 'kind', 'song', 'schema', '\\u0061', 'a\\u0000'];

function randNumber(r) {
  const k = r();
  if (k < 0.3) return pick(r, NUMS);
  if (k < 0.6) {  // a random double, written several ways
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(0, Math.floor(r() * 2 ** 32));
    buf.setUint32(4, Math.floor(r() * 2 ** 32));
    let d = buf.getFloat64(0);
    if (!Number.isFinite(d)) d = r() * 1e10;
    const f = [() => String(d), () => d.toExponential(int(r, 0, 20)), () => d.toPrecision(int(r, 1, 21))];
    return pick(r, f)().replace('+', r() < 0.5 ? '+' : '');
  }
  // long digit strings and exponents
  let s = r() < 0.3 ? '-' : '';
  s += String(int(r, 1, 9));
  for (let i = int(r, 0, 40); i > 0; i--) s += String(int(r, 0, 9));
  if (r() < 0.5) {
    s += '.';
    for (let i = int(r, 1, 30); i > 0; i--) s += String(int(r, 0, 9));
  }
  if (r() < 0.5) s += pick(r, ['e', 'E']) + pick(r, ['', '+', '-']) + String(int(r, 0, 340));
  return s;
}

function randString(r) {
  let s = '"';
  for (let i = int(r, 0, 6); i > 0; i--) s += pick(r, STR_PIECES);
  return `${s}"`;
}

function ws(r) {
  return r() < 0.7 ? '' : pick(r, [' ', '\n', '\t', '\r\n ', '  ']);
}

function randValue(r, depth) {
  const k = r();
  if (depth > 5 || k < 0.35) {
    return pick(r, [() => randNumber(r), () => randString(r), () => 'true', () => 'false', () => 'null'])();
  }
  if (k < 0.65) {
    const n = int(r, 0, 5);
    const items = [];
    for (let i = 0; i < n; i++) items.push(ws(r) + randValue(r, depth + 1) + ws(r));
    return `[${items.join(',')}]`;
  }
  const n = int(r, 0, 9);
  const items = [];
  for (let i = 0; i < n; i++) {
    const key = r() < 0.7 ? pick(r, KEYS) : randString(r).slice(1, -1);
    items.push(`${ws(r)}"${key}"${ws(r)}:${ws(r)}${randValue(r, depth + 1)}${ws(r)}`);
  }
  return `{${items.join(',')}}`;
}

function mutate(r, s) {
  const b = Buffer.from(s, 'utf8');
  if (!b.length) return b;
  const out = [...b];
  for (let i = int(r, 1, 3); i > 0; i--) {
    const at = int(r, 0, out.length - 1);
    const m = r();
    if (m < 0.33) out.splice(at, 1);
    else if (m < 0.66) out.splice(at, 0, pick(r, [0x2c, 0x7d, 0x5d, 0x22, 0x5c, 0x30, 0x2d, 0x2e, 0x65, 0x01, 0xff, 0xed]));
    else out[at] = int(r, 0, 255);
  }
  return Buffer.from(out);
}

const FIXED_JSON = ['', ' ', '{}', '[]', 'null', 'true', 'false', '0', '-', '01', '1.', '.5', '+1', '1e', '1e+',
  '[1,]', '{"a":1,}', '{"a" 1}', '{,}', '[,1]', '"\\x"', '"\\u12"', '"\\u12G4"', '"a\u0001"', 'nul', 'tru', 'NaN',
  'Infinity', '[1]x', '[1] ', '﻿{}', '\f1', ' 1', '"\\ud800"', '"\\ud800\\u0041"', '"\\udc00\\ud800"',
  '"\\ud83c\\udfb9"', '{"b":1,"a":2,"b":3}', '{"2":1,"1":2,"b":3,"0":4,"4294967295":5,"01":6}',
  '{"__proto__":{"x":1},"a":1}', '[[[[[[[[]]]]]]]]', '{"a":{"a":{"a":{}}}}', '"  "', '[1e400,-1e400]',
  '[-0,0.0,-0.0]', '{"":1}', '"\\/"', '[true,false,null]', '{"a":1}{', '[1,2', '{"a":', '"abc'];

/** @returns {Buffer[]} */
export function jsonCases(n, seed = 1) {
  const r = rng(seed);
  const out = FIXED_JSON.map((s) => Buffer.from(s, 'utf8'));
  out.push(Buffer.from(`${'['.repeat(64)}${']'.repeat(64)}`), Buffer.from(`${'['.repeat(65)}${']'.repeat(65)}`));
  out.push(Buffer.from(`{"a":${'['.repeat(70)}1${']'.repeat(70)},"b":2}`), Buffer.from(`${'['.repeat(5000)}${']'.repeat(5000)}`));
  out.push(Buffer.from([0x22, 0xff, 0x22]), Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]), Buffer.from([0x22, 0xf0, 0x90, 0x22]));
  out.push(Buffer.from([0x22, 0xc3, 0x22]), Buffer.from([0x22, 0xe2, 0x82, 0x22]), Buffer.from([0x22, 0xf4, 0x90, 0x80, 0x80, 0x22]));
  out.push(Buffer.from([0x22, 0xc0, 0xaf, 0x22]), Buffer.from([0x22, 0xe0, 0x80, 0xaf, 0x22]), Buffer.from([0x22, 0x80, 0x22]));
  for (let i = 0; i < n; i++) {
    const v = ws(r) + randValue(r, 0) + ws(r);
    const k = r();
    if (k < 0.6) out.push(Buffer.from(v, 'utf8'));
    else if (k < 0.75) out.push(Buffer.from(`[${randNumber(r)}]`));
    else if (k < 0.95) out.push(mutate(r, v));
    else out.push(Buffer.from(Array.from({ length: int(r, 0, 12) }, () => int(r, 0, 255))));
  }
  return out;
}

const TEXT_PIECES = ['a', ' ', '\t', ' ', ' ', '　', '﻿', ' ', '​', 'é', '漢', '🎹', '👍🏽',
  'x'.repeat(37), '᠎', '\u0085', '\n'];

/** @returns {Buffer[]} */
export function textCases(n, seed = 2) {
  const r = rng(seed);
  const out = [Buffer.from(''), Buffer.from('  '), Buffer.from(`${'a'.repeat(39)}🎹b`), Buffer.from(`${'a'.repeat(40)}🎹`)];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let j = int(r, 0, 8); j > 0; j--) s += pick(r, TEXT_PIECES);
    const b = Buffer.from(s, 'utf8');
    out.push(r() < 0.2 ? mutate(r, s) : b);
  }
  return out;
}

/** Realistic song and pack names: what the order must match exactly. */
export const REAL_ALPHABET = [...'abcxyzABCXYZ0123456789 -_.()&\'!,', 'é', 'É', 'è', 'ñ', 'ü', 'Ü', 'ö', 'ç', 'ã', 'õ',
  'ß', 'æ', 'ø', 'å', 'œ', '漢', '字', '主', '耶', '稣', '赞', '美', '诗', '歌', '가', '나', '다', '찬', '양', 'あ', 'ア', 'か', 'カ',
  'ä', 'Ä', 'ő', 'ł', 'ś', 'ž', 'č', 'Я', 'я', 'б', 'Б', 'α', 'Ω', '🎹', '🎸', '♪', '#', '+', '’', '“', '”', '—', '–', '…',
  '01', '02', '10', '2', '007', 'é', '١', '٢', '０', '１'];

/** @returns {string[]} */
export function nameCases(n, alphabet, seed = 3) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let j = int(r, 1, 8); j > 0; j--) s += pick(r, alphabet);
    out.push(s);
  }
  return out;
}

/** Code points from everywhere the table models, and some it does not (these may sort differently). */
export function exoticAlphabet(seed = 4) {
  const r = rng(seed);
  const ranges = [[0x20, 0x7e], [0xa0, 0x24f], [0x370, 0x3ff], [0x400, 0x4ff], [0x590, 0x6ff], [0x1e00, 0x1fff],
    [0x2000, 0x206f], [0x20a0, 0x20cf], [0x2100, 0x218f], [0x2190, 0x27bf], [0x3000, 0x30ff], [0x3130, 0x318f],
    [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xff00, 0xffef], [0x1f300, 0x1faff]];
  const out = [];
  for (let i = 0; i < 400; i++) {
    const [lo, hi] = pick(r, ranges);
    out.push(String.fromCodePoint(int(r, lo, hi)));
  }
  return out;
}

// ---- pack trees ----------------------------------------------------------------------------------------------------

const song = (name, extra = {}) => ({ name, tempo: 72, key: 'Eb', patch: { slots: [{ instrument: { kind: 'synth', id: 'pad' } }] }, ...extra });
const envelope = (s, more = {}) => ({ app: 'worship-rig', kind: 'song', schema: 2, song: s, ...more });

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 1));
}

/**
 * Build a My Samples tree under `dir`. variant 'main' covers the rules and messages; 'caps' the size and count caps.
 * @returns {string[]} the roots, as server.js gets them (absolute; some missing or not folders)
 */
export function buildTree(dir, variant = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  if (variant === 'caps') {
    const a = path.join(dir, 'Caps Root');
    const pad = ' '.repeat(1000 * 1000);  // a ~1 MB file under the 1 MiB cap
    for (let i = 0; i < 9; i++) write(path.join(a, 'Heavy', 'songs', `h${i}.json`), `${JSON.stringify(envelope(song(`H${i}`)))}${pad}`);
    const hundred = Array.from({ length: 100 }, (_, i) => ({ name: `S${i}`, patch: {} }));
    for (let i = 0; i < 21; i++) write(path.join(a, 'Many', 'songs', `m${String(i).padStart(2, '0')}.json`), hundred);
    for (let i = 0; i < 3; i++) write(path.join(a, 'Zed After', 'songs', `z${i}.json`), envelope(song(`Z${i}`)));
    return [a];
  }
  const a = path.join(dir, 'Music', 'Worship Rig', 'Samples Ä');
  const b = path.join(dir, 'second root');
  const outside = path.join(dir, 'outside');
  write(path.join(outside, 'stray.json'), envelope(song('Stray')));
  fs.mkdirSync(path.join(outside, 'Elsewhere', 'songs'), { recursive: true });
  write(path.join(outside, 'Elsewhere', 'songs', 'e.json'), envelope(song('E')));

  const cedar = path.join(a, 'Cedar Keys');
  write(path.join(cedar, 'pack.json'), { name: '  Cedar Keys 　', mode: 'auto' });
  write(path.join(cedar, 'manifest.json'), { instruments: [] });
  const s = (f, data) => write(path.join(cedar, 'songs', f), data);
  s('lantern-hymn.json', envelope(song('Lantern Hymn'), { bank: { title: 'Lantern Hymn', artist: 'Trad.', bpm: 72, tags: ['slow'] } }));
  s('sunday-set.json', [envelope(song('One')), { ...song('Two', { id: 'lib-1', bank: { title: 'Two' } }) }, 'not a song',
    { kind: 'library', songs: [] }, { songs: null }, envelope({ name: 'No patch' }), envelope(song('Bank null'), { bank: null })]);
  s('song10.json', envelope(song('Ten')));
  s('song2.json', envelope(song('Two again')));
  s('Ünïcode Sóng 🎹.json', envelope(song('Ünïcode 🎹   "q" \\ \u0007')));
  s('a b.json', envelope(song('Spaced')));
  s('B.JSON', envelope(song('Upper ext')));
  s('.hidden.json', envelope(song('Hidden')));
  s('notjson.txt', 'x');
  s('bad.json', '{"kind": "song", ');
  s('bom.json', `﻿${JSON.stringify(envelope(song('BOM')))}`);
  s('deep.json', `{"kind":"song","song":{"patch":{},"x":${'['.repeat(70)}${']'.repeat(70)}}}`);
  s('deep63.json', `{"kind":"song","song":{"patch":{},"x":${'['.repeat(61)}${']'.repeat(61)}}}`);
  s('empty-array.json', '[]');
  s('library.json', { kind: 'library', songs: [] });
  s('slots0.json', envelope({ name: 'S0', patch: { slots: [] } }));
  s('slots17.json', envelope({ name: 'S17', patch: { slots: Array(17).fill({}) } }));
  s('slots-obj.json', envelope({ name: 'Sobj', patch: { slots: {} } }));
  s('badname.json', envelope({ name: 5, patch: {} }));
  s('schema-weird.json', '{"kind":"song","schema":1e400,"song":{"patch":{}}}');
  s('schema-str.json', '{"kind":"song","schema":"2","song":{"patch":{}}}');
  fs.mkdirSync(path.join(cedar, 'songs', 'dir.json'), { recursive: true });
  fs.symlinkSync('song2.json', path.join(cedar, 'songs', 'link-in.json'));
  fs.symlinkSync(path.join(outside, 'stray.json'), path.join(cedar, 'songs', 'link-out.json'));
  fs.symlinkSync('nowhere.json', path.join(cedar, 'songs', 'dangling.json'));
  fs.symlinkSync('loop.json', path.join(cedar, 'songs', 'loop.json'));
  s('big.json', `${JSON.stringify(envelope(song('Big')))}${' '.repeat(1100 * 1000)}`);
  s('numbers.json', '{"kind":"song","schema":2.0,"song":{"name":"N\\ud800\\u00e9\\ud83c\\udfb9","tempo":72.50,"b":1,'
    + '"a":2,"b":3,"10":1,"2":2,"01":3,"4294967295":4,"__proto__":{"x":1e400},"patch":{"slots":[{"gain":-0.0,'
    + '"big":123456789012345678901234,"tiny":1e-7,"e":1E21,"f":0.1e1,"ctl":"\\u0001\\b\\f\\n\\r\\t\\/\\u2028",'
    + '"instrument":{"id":"factory:x"}}]}},"bank":{"title":"Numbers","bpm":72.0}}');
  s('invalid-utf8.json', Buffer.concat([Buffer.from('{"kind":"song","song":{"name":"bad '), Buffer.from([0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80]),
    Buffer.from('","patch":{}}}')]));
  s('user-ref.json', [envelope({ name: 'U', patch: { slots: [{ instrument: { id: 'user:missing' } }, { instrument: { id: 'user:here' } },
    { instrument: 'user:str' }, 0, null, { instrument: { id: 'user:missing' } }] } })]);
  s('bare.json', { name: 'Bare', patch: {}, bank: { title: 'Bare bank' }, id: 'x' });
  s('long-'.padEnd(246, 'n') + '.json', envelope(song('Long name')));

  write(path.join(a, 'Bank Pack', 'pack.json'), { mode: 'bank', name: 'The Bank'.padEnd(130, '!') });
  for (const [i, t] of ['Amazing', 'Be Thou', 'Come Thou'].entries()) {
    write(path.join(a, 'Bank Pack', 'songs', `${i + 1}-${t}.json`), envelope(song(t), { bank: { title: t, originalKey: 'G', ccli: '123' } }));
  }
  const one = (slug, pj) => {
    if (pj !== undefined) write(path.join(a, slug, 'pack.json'), pj);
    write(path.join(a, slug, 'songs', 'x.json'), envelope(song(slug)));
  };
  one('bad-mode', { mode: 'weird' });
  one('packjson-array', '[]');
  one('packjson-invalid', '{');
  one('packjson-bom', '﻿{"mode":"bank"}');
  one('packjson-big', `{"mode":"bank"}${' '.repeat(70000)}`);
  one('packjson-deep', `{"mode":"bank","name":"Deep","x":${'['.repeat(80)}${']'.repeat(80)}}`);
  one('packjson-name', { name: 5 });
  one('packjson-blank', { name: ' \t ' });
  one('packjson-mode-null', { mode: null });
  one('packjson-dir');
  fs.mkdirSync(path.join(a, 'packjson-dir', 'pack.json'));
  one('packjson-dangling');
  fs.symlinkSync('missing.json', path.join(a, 'packjson-dangling', 'pack.json'));
  one('colon:pack');
  one(`${'L'.repeat(38)}🎹${'x'.repeat(170)}`);
  one('Pack 10');
  one('pack 2');
  one('Pack 1');
  one('Alpha');
  one('alpha');
  one('Étude');
  one('etude');
  one('.dotpack');
  write(path.join(a, 'no-songs', 'manifest.json'), { instruments: [] });
  fs.mkdirSync(path.join(a, 'empty-songs', 'songs'), { recursive: true });
  write(path.join(a, 'empty-songs', 'songs', 'readme.txt'), 'x');
  fs.symlinkSync(path.join(outside, 'Elsewhere'), path.join(a, 'outside-link'));
  fs.symlinkSync('Bank Pack', path.join(a, 'zz-inside-link'));
  write(path.join(a, 'a-file'), 'not a folder');
  for (let i = 0; i < 205; i++) write(path.join(a, 'many-files', 'songs', `f${i}.json`), { name: `F${i}`, patch: {} });
  write(path.join(a, 'many-songs', 'songs', 'list.json'), Array.from({ length: 105 }, (_, i) => ({ name: `M${i}`, patch: {} })));
  fs.mkdirSync(path.join(a, 'songs-link'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'Elsewhere', 'songs'), path.join(a, 'songs-link', 'songs'));

  write(path.join(b, 'Cedar Keys', 'songs', 'dup.json'), envelope(song('Dup')));
  write(path.join(b, 'Only In B', 'songs', 'b.json'), envelope(song('B')));
  write(path.join(b, 'Instruments Only', 'manifest.json'), { instruments: [] });
  write(path.join(b, 'Bank Pack', 'manifest.json'), { instruments: [] });  // a duplicate without songs: no message
  write(path.join(dir, 'a file root'), 'x');
  return [a, b, path.join(dir, 'missing root'), path.join(dir, 'a file root'), `${a}/`];
}
