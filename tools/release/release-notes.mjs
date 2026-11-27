#!/usr/bin/env node
// The GitHub release body for a 2.x tag (lane N10, MAC_CHECK.md "2.0 release checklist" step 3): the player-facing
// notes in docs/release-notes-<version>.md without the draft banner, the "Editor's notes" section and the
// `<!-- Editor: … -->` comments, relative links made absolute (a release page has no base path), plus a "Files"
// section with the sha256 of each asset. release-native.yml's release job runs it; it refuses notes that still say
// they are a draft, so a release can't go out with the banner by accident.
//
//   node tools/release/release-notes.mjs --tag v2.0.0 [--repo owner/name] [--sums <SHA256SUMS>] [--docs <dir>]
//                                        [--require-final]
//
// --require-final (the publish job): refuse a notes file that is still a draft (it starts with the banner, or has
// "Editor's notes"), i.e. MAC_CHECK step 7 wasn't done. Without it (the dry run's preview) they are stripped.
//
// Notes file: docs/release-notes-<X.Y.Z[-pre]>.md, else -<X.Y.Z>.md, else (only for X.Y.0) -<X.Y>.md.
// Pure functions are exported for test/unit/release/release-workflows.test.mjs.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Candidate notes file names for a tag, most specific first.
 * @param {string} tag e.g. 'v2.0.0'
 * @returns {string[]}
 */
export function notesCandidates(tag) {
  const m = TAG_RE.exec(tag);
  if (!m) throw new Error(`tag '${tag}' is not vX.Y.Z[-pre]`);
  const [, x, y, z, pre] = m;
  const out = [];
  if (pre) out.push(`release-notes-${x}.${y}.${z}-${pre}.md`);
  out.push(`release-notes-${x}.${y}.${z}.md`);
  if (z === '0') out.push(`release-notes-${x}.${y}.md`);
  return out;
}

/**
 * The bundle version a tag must match (CFBundleShortVersionString is numeric only): 'v2.0.0-beta.1' -> '2.0.0'.
 * @param {string} tag
 * @returns {string}
 */
export function bundleVersionForTag(tag) {
  const m = TAG_RE.exec(tag);
  if (!m) throw new Error(`tag '${tag}' is not vX.Y.Z[-pre]`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * A link of a repo markdown file as an absolute GitHub URL at `ref` (N10 skeptic F2). Absolute URLs (any scheme),
 * protocol-relative ones and `#anchors` are kept. `/x` is repo-root-relative, as GitHub renders it in a repo file
 * (WHATWG URL resolution made it https://github.com/x); a path that leaves the repository (`../` past the root, which
 * URL resolution turned into github.com/<repo>/blob/<file>, dropping the ref) throws instead of guessing.
 * @param {string} href
 * @param {{repo: string, ref: string, docPath: string}} o
 * @returns {string}
 */
export function absoluteLink(href, { repo, ref, docPath }) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  const [, path, rest] = /^([^?#]*)(.*)$/.exec(href);
  let joined = posix.join(posix.dirname(docPath), path);
  if (path === '') joined = docPath; // `?q` alone: the notes file itself
  else if (path.startsWith('/')) joined = path.slice(1);
  const norm = posix.normalize(joined || '.').replace(/^\.\/+/, '') || '.';
  if (norm === '..' || norm.startsWith('../')) {
    throw new Error(`link '${href}' in ${docPath} points outside the repository`);
  }
  return `https://github.com/${repo}/${norm === '.' ? 'tree' : 'blob'}/${ref}${norm === '.' ? '' : `/${norm}`}${rest}`;
}

/**
 * Strip the editorial parts of a notes draft and absolutise its links.
 * @param {string} md the notes file
 * @param {{repo: string, ref: string, docPath?: string}} o docPath: the file's repo path (for relative links)
 * @returns {string}
 */
export function releaseBody(md, { repo, ref, docPath = 'docs/release-notes.md' }) {
  let s = md.replace(/\r\n/g, '\n');
  // the draft banner: the blockquote the file starts with
  s = s.replace(/^(?:>[^\n]*\n)+\n*/, '');
  // editor comments, single or multi-line
  s = s.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*\n?/g, '');
  // "Editor's notes" (any heading level, ' or ’) up to the next heading of the same or a higher level, or the end
  const lines = s.split('\n');
  const kept = [];
  let skipLevel = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (skipLevel) {
      if (h && h[1].length <= skipLevel) skipLevel = 0;
      else continue;
    }
    if (h && /^editor['’]s notes\b/i.test(h[2].trim())) {
      skipLevel = h[1].length;
      continue;
    }
    kept.push(line);
  }
  s = kept.join('\n');
  // relative links -> https://github.com/<repo>/blob/<ref>/<resolved path>
  s = s.replace(/(\]\()([^)\s]+)(\))/g, (all, a, href, b) => a + absoluteLink(href, { repo, ref, docPath }) + b);
  s = s.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (/Draft, not released/i.test(s) || /<!--|Editor:/.test(s)) {
    throw new Error('the notes still carry draft or editor text after stripping (MAC_CHECK step 7)');
  }
  return s;
}

/**
 * Why a notes file is not final yet, or '' when it is (MAC_CHECK step 7 removes the banner and "Editor's notes").
 * @param {string} md
 * @returns {string}
 */
export function draftReason(md) {
  const s = md.replace(/\r\n/g, '\n');
  if (/^>/.test(s) || /Draft, not released/i.test(s)) return 'it still starts with the draft banner';
  if (/^#{1,6}\s+editor['’]s notes\b/im.test(s)) return "it still has an \"Editor's notes\" section";
  return '';
}

/**
 * A "Files" section from a `shasum -a 256` file (`<hash>  <name>` lines).
 * @param {string} sums
 * @returns {string}
 */
export function filesSection(sums) {
  const rows = sums.split('\n').map((l) => /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(l.trim())).filter(Boolean);
  if (!rows.length) return '';
  return ['### Files (sha256)', '', ...rows.map(([, h, n]) => `- \`${n}\`: \`${h}\``), ''].join('\n');
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k === '--require-final') {
      args.requireFinal = true;
      i -= 1;
      continue;
    }
    if (!['--tag', '--repo', '--sums', '--docs'].includes(k) || argv[i + 1] === undefined) {
      const usage = 'release-notes.mjs --tag vX.Y.Z [--repo o/n] [--sums file] [--docs dir] [--require-final]';
      throw new Error(`usage: ${usage} (bad '${k}')`);
    }
    args[k.slice(2)] = argv[i + 1];
  }
  if (!args.tag) throw new Error('--tag is required');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const docs = args.docs || join(repoRoot, 'docs');
  const repo = args.repo || process.env.GITHUB_REPOSITORY || 'ryanmye/worship-rig';
  const name = notesCandidates(args.tag).find((n) => existsSync(join(docs, n)));
  if (!name) {
    throw new Error(`no notes file for ${args.tag} in ${docs} (tried ${notesCandidates(args.tag).join(', ')})`);
  }
  const md = readFileSync(join(docs, name), 'utf8');
  const why = draftReason(md);
  if (why && args.requireFinal) throw new Error(`docs/${name} is not final: ${why} (MAC_CHECK step 7)`);
  if (why) process.stderr.write(`release-notes: note: docs/${name} is a draft (${why}); stripped for the preview\n`);
  let body = releaseBody(md, { repo, ref: args.tag, docPath: `docs/${name}` });
  if (args.sums) body += '\n' + filesSection(readFileSync(args.sums, 'utf8'));
  process.stdout.write(body);
}

// Run as a script? Compare real paths: import.meta.url is the module's realpath but argv[1] is the path as typed, so a
// plain string compare silently skipped main() (empty stdout, exit 0, --require-final bypassed) when the script was
// reached through a symlink (N10 skeptic F1).
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`release-notes: ${e.message}\n`);
    process.exit(1);
  }
}
