#!/usr/bin/env node
/**
 * suggest-pins.mjs — the retired text-heuristic matcher, DEMOTED to a
 * candidate-link generator (dispatch migration strategy; findings 1, 5).
 *
 * Through wave 17, scripts/check-finding-regression-pins.mjs used four
 * line-local text heuristics (leading-comment / test-title / self-header /
 * same-line-assert-argument — see git history at 860ed73 for their full,
 * heavily-audited development across waves 6-16) to GRANT Class #14 credit.
 * That mechanism false-granted on seven consecutive adversarial audits — see
 * docs/pin-matcher-rewrite.dispatch.md finding 1: "IR-based traceability
 * recovery... never achieves high precision and high recall simultaneously,
 * and its own authors frame it as a candidate-link generator requiring
 * human vetting, never an autonomous gate."
 *
 * This file is that same logic, UNCHANGED in mechanism (still line-local
 * text heuristics, still capable of the same false positives it always
 * had), but stripped of all GRANTING authority. It now serves exactly the
 * role the literature says it is valid for:
 *
 *   1. `hasLegacyStructuralHit` / `findLegacyStructuralHits` — consumed by
 *      check-finding-regression-pins.mjs ONLY to decide GRANDFATHER
 *      exemption (an id with no declared @pins tag anywhere, but a legacy
 *      hit somewhere, is exempt from blocking but disclosed as
 *      "grandfathered — unverified" — never silently treated as equivalent
 *      to a declared, AST-verified pin). See that file's module docstring
 *      for the full grandfather-bucket contract.
 *   2. `suggestPinsForRepo` / the `--suggest-pins` CLI mode — proposes
 *      `@pins` tag insertions for orphaned ids that have a legacy hit, so a
 *      domain's own agent can VET and land the tag by hand (the
 *      human-review half of Defects4J's standard — dispatch finding 5).
 *      This tool NEVER writes into a test file itself; it prints/writes a
 *      report. Landing a tag is a per-domain decision, and this domain
 *      (ci-tooling) cannot edit files outside `.github/**`, `scripts/**`,
 *      `tsconfig*.json` even if it wanted to.
 *
 * Neither export can cause check-finding-regression-pins.mjs's `ok` verdict
 * to become true for an id that has no declared tag — only the grandfather
 * bucket (itself disclosed, non-silent) is downstream of this file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { F_ID_PATTERN, parseRegressionPins, toJSON } from '../packages/portfolio/lib/parse-regression-pins.js';
import { scanRepoForDeclaredPins } from './pin-declarations.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRepoRoot = resolve(here, '..');

// ── Ported verbatim (mechanism unchanged) from check-finding-regression-pins.mjs @ 860ed73 ──
// Full per-rule development history (waves 6-16, findings F-f0339e12 through
// F-234da564) lives in that commit, not re-transcribed here — see this
// file's own module docstring for why (the record is preserved in git
// history, not deleted; re-typing it would be redundant, not more honest).

const STRUCTURAL_COMMENT_DECORATION = /^\s*(?:[/*#-]+\s*)+/;
const TEST_CALL_OPEN = /\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*['"`]/;
const STRUCTURAL_ASSERT_LINE = /\bassert\b|\bexpect\s*\(/;
const STRUCTURAL_HEADER_LINE_LIMIT = 20;
const STRUCTURAL_TITLE_BODY_LINE_LIMIT = 400;

const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-',
  '*', '%', '<', '>', '~', '^',
]);
const REGEX_PRECEDER_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete',
  'void', 'do', 'else', 'yield', 'await', 'throw',
]);

function lastSignificantToken(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  if (j < 0) return { char: '', word: '' };
  const char = out[j];
  let k = j;
  while (k >= 0 && /[A-Za-z_$]/.test(out[k])) k--;
  return { char, word: out.slice(k + 1, j + 1) };
}

function regexFollows(out) {
  const { char, word } = lastSignificantToken(out);
  if (char === '') return true;
  if (REGEX_PRECEDER_KEYWORDS.has(word)) return true;
  return REGEX_PRECEDERS.has(char);
}

function scanNonCodeSpans(source) {
  const spans = [];
  let shape = '';
  let i = 0;
  const n = source.length;
  const frames = [];
  let braceDepth = 0;

  function consumeTemplateBody(from) {
    let j = from;
    while (j < n) {
      if (source[j] === '\\') { shape += source[j] + (source[j + 1] ?? ''); j += 2; continue; }
      if (source[j] === '`') { shape += source[j]; j++; return j; }
      if (source[j] === '$' && source[j + 1] === '{') {
        shape += '${';
        j += 2;
        frames.push({ braceDepth });
        braceDepth = 0;
        return j;
      }
      shape += source[j];
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : '';
    if (c === '/' && next === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      spans.push({ start, end: i, kind: 'comment' });
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') shape += '\n';
        i++;
      }
      i = Math.min(i + 2, n);
      spans.push({ start, end: i, kind: 'comment' });
      continue;
    }
    if (c === '/' && regexFollows(shape)) {
      const start = i;
      shape += c;
      i++;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') { shape += r + (source[i + 1] ?? ''); i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { shape += r; i++; break; }
        shape += r;
        i++;
      }
      while (i < n && /[a-z]/i.test(source[i])) { shape += source[i]; i++; }
      spans.push({ start, end: i, kind: 'regex' });
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      shape += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { shape += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        shape += source[i];
        i++;
      }
      if (i < n) { shape += source[i]; i++; }
      spans.push({ start, end: i, kind: 'string' });
      continue;
    }
    if (c === '`') {
      const start = i;
      shape += c;
      i = consumeTemplateBody(i + 1);
      spans.push({ start, end: i, kind: 'template' });
      continue;
    }
    if (c === '{') { braceDepth++; shape += c; i++; continue; }
    if (c === '}') {
      if (braceDepth === 0 && frames.length > 0) {
        shape += c;
        braceDepth = frames.pop().braceDepth;
        const bodyStart = i;
        i = consumeTemplateBody(i + 1);
        spans.push({ start: bodyStart, end: i, kind: 'template' });
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      shape += c;
      i++;
      continue;
    }
    shape += c;
    i++;
  }
  return spans;
}

function applyMask(source, spans, kindsToMask) {
  const out = source.split('');
  for (const { start, end, kind } of spans) {
    if (!kindsToMask.has(kind)) continue;
    for (let k = start; k < end; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  }
  return out.join('');
}

const CODE_ONLY_MASK_KINDS = new Set(['comment', 'string', 'template', 'regex']);
const PROSE_MASK_KINDS = new Set(['comment']);

function blankSpan(text, start, end) {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

function isLeadingCommentPin(line, id) {
  const m = STRUCTURAL_COMMENT_DECORATION.exec(line);
  if (m && m[0].replace(/\s/g, '') === '/') return false;
  return line.replace(STRUCTURAL_COMMENT_DECORATION, '').startsWith(id);
}

function matchTestCallStart(line) {
  const m = TEST_CALL_OPEN.exec(line);
  if (!m) return null;
  const openQuotePos = m.index + m[0].length - 1;
  const span = scanNonCodeSpans(line).find(
    (s) => s.start === openQuotePos && (s.kind === 'string' || s.kind === 'template'),
  );
  if (!span) return null;
  return {
    title: line.slice(span.start + 1, span.end - 1),
    openParenCol: m.index + m[0].indexOf('('),
    titleStart: span.start,
    titleEnd: span.end,
  };
}

function enclosingCallHasAssertBody(codeOnlyLines, callLineIndex, openParenCol) {
  if (codeOnlyLines[callLineIndex][openParenCol] !== '(') return false;
  let depth = 0;
  const lastLine = Math.min(codeOnlyLines.length - 1, callLineIndex + STRUCTURAL_TITLE_BODY_LINE_LIMIT);
  for (let i = callLineIndex; i <= lastLine; i++) {
    const masked = i === callLineIndex ? codeOnlyLines[i].slice(openParenCol) : codeOnlyLines[i];
    let closedAt = -1;
    for (let c = 0; c < masked.length; c++) {
      const ch = masked[c];
      if (ch === '(' || ch === '{') depth++;
      else if (ch === ')' || ch === '}') {
        depth--;
        if (depth <= 0) { closedAt = c; break; }
      }
    }
    const active = closedAt === -1 ? masked : masked.slice(0, closedAt + 1);
    if (STRUCTURAL_ASSERT_LINE.test(active)) return true;
    if (closedAt !== -1) return false;
  }
  return false;
}

function isTestTitlePin(rawLines, codeOnlyLines, lineIndex, id) {
  const call = matchTestCallStart(rawLines[lineIndex]);
  if (!call || !call.title.includes(id)) return false;
  return enclosingCallHasAssertBody(codeOnlyLines, lineIndex, call.openParenCol);
}

function isSelfReferencingHeaderPin(line, id, fileBasename, lineIndex) {
  if (lineIndex >= STRUCTURAL_HEADER_LINE_LIMIT) return false;
  const idPos = line.indexOf(id);
  if (idPos === -1) return false;
  const basePos = line.indexOf(fileBasename);
  if (basePos === -1 || basePos >= idPos) return false;
  F_ID_PATTERN.lastIndex = 0;
  let m;
  while ((m = F_ID_PATTERN.exec(line))) {
    if (m.index < idPos) return false;
    if (m.index === idPos) break;
  }
  return true;
}

function isSameLineAssertArgumentPin(rawLine, codeOnlyLine, proseMaskedLine, id) {
  const call = matchTestCallStart(rawLine);
  const proseChecked = call ? blankSpan(proseMaskedLine, call.titleStart, call.titleEnd) : proseMaskedLine;
  return STRUCTURAL_ASSERT_LINE.test(codeOnlyLine) && proseChecked.includes(id);
}

/**
 * @param {string} text
 * @param {string} id
 * @param {string} fileBasename
 * @returns {{ line: number, kind: 'leading-comment'|'title'|'self-header'|'assert-line'|'none' }[]}
 */
export function findLegacyStructuralHits(text, id, fileBasename) {
  const lines = text.split('\n');
  const spans = scanNonCodeSpans(text);
  const codeOnlyLines = applyMask(text, spans, CODE_ONLY_MASK_KINDS).split('\n');
  const proseMaskedLines = applyMask(text, spans, PROSE_MASK_KINDS).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(id)) continue;
    if (isTestTitlePin(lines, codeOnlyLines, i, id)) hits.push({ line: i + 1, kind: 'title' });
    else if (isLeadingCommentPin(line, id)) hits.push({ line: i + 1, kind: 'leading-comment' });
    else if (isSelfReferencingHeaderPin(line, id, fileBasename, i)) hits.push({ line: i + 1, kind: 'self-header' });
    else if (isSameLineAssertArgumentPin(line, codeOnlyLines[i], proseMaskedLines[i], id)) hits.push({ line: i + 1, kind: 'assert-line' });
    else hits.push({ line: i + 1, kind: 'none' });
  }
  return hits;
}

/**
 * @returns {boolean} true iff `id` has AT LEAST ONE legacy structural hit in
 *   `text` — GRANDFATHER-EXEMPTION SIGNAL ONLY (see module docstring). Never
 *   consumed as Tier-1 credit.
 */
export function hasLegacyStructuralHit(text, id, fileBasename) {
  return findLegacyStructuralHits(text, id, fileBasename).some((h) => h.kind !== 'none');
}

// ── New: suggestion generation (the migration enabler) ──

/**
 * For every id with a source pin but no declared `@pins` tag, look for a
 * legacy structural hit and propose inserting `/** @pins <id> *\/` on the
 * line immediately above it. Multiple hits for the same id (e.g. both a
 * title AND an assert-line match) each produce their own suggestion — a
 * human vets and picks (or writes their own placement), this tool does not
 * decide for them.
 *
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {(rootDir: string) => ReturnType<typeof parseRegressionPins>} [opts.parse]
 * @param {(rootDir: string) => ReturnType<typeof scanRepoForDeclaredPins>} [opts.scanDeclared]
 * @returns {{
 *   suggestions: { id: string, file: string, line: number, kind: string, insertAboveLine: string }[],
 *   coveredByDeclaredTag: string[],
 *   stillUnmigrated: string[],
 * }}
 */
export function suggestPinsForRepo(rootDir, { parse = parseRegressionPins, scanDeclared = scanRepoForDeclaredPins } = {}) {
  const json = toJSON(parse(rootDir));
  const declared = scanDeclared(rootDir);
  const sourceIds = Object.keys(json.source_pins);

  const suggestions = [];
  const coveredByDeclaredTag = [];
  const stillUnmigrated = [];
  const fileTextCache = new Map();
  const readCached = (file) => {
    if (fileTextCache.has(file)) return fileTextCache.get(file);
    let text = null;
    try { text = readFileSync(file, 'utf-8'); } catch { text = null; }
    fileTextCache.set(file, text);
    return text;
  };

  for (const id of sourceIds) {
    if (declared.byId.has(id)) {
      coveredByDeclaredTag.push(id);
      continue;
    }
    const candidateFiles = json.test_pins[id] ?? [];
    let foundHit = false;
    for (const file of candidateFiles) {
      const text = readCached(file);
      if (text === null) continue;
      const hits = findLegacyStructuralHits(text, id, basename(file)).filter((h) => h.kind !== 'none');
      for (const hit of hits) {
        foundHit = true;
        suggestions.push({
          id,
          file,
          line: hit.line,
          kind: hit.kind,
          insertAboveLine: `/** @pins ${id} */`,
        });
      }
    }
    if (!foundHit) stillUnmigrated.push(id);
  }

  return { suggestions, coveredByDeclaredTag, stillUnmigrated: stillUnmigrated.sort() };
}

function formatSuggestionsHuman(result) {
  const lines = [];
  lines.push(`[suggest-pins] ${result.coveredByDeclaredTag.length} id(s) already have a declared @pins tag.`);
  lines.push(`[suggest-pins] ${result.suggestions.length} suggestion(s) generated from legacy structural hits:`);
  for (const s of result.suggestions) {
    lines.push(`  ${s.id} — ${s.file}:${s.line} (legacy signal: ${s.kind})`);
    lines.push(`    insert above line ${s.line}: ${s.insertAboveLine}`);
  }
  if (result.stillUnmigrated.length > 0) {
    lines.push(`[suggest-pins] ${result.stillUnmigrated.length} id(s) have NO declared tag and NO legacy signal at all — a human must locate the test manually:`);
    for (const id of result.stillUnmigrated) lines.push(`    ${id}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { json: false, root: null, writeReportPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--root') out.root = argv[++i] ?? null;
    else if (a === '--write-report') out.writeReportPath = argv[++i] ?? null;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/suggest-pins.mjs [options]

Proposes @pins tag insertions for orphaned finding ids that have a legacy
structural hit (the retired heuristic matcher, demoted to a candidate-link
generator — see module docstring). Grants nothing; a human vets and lands
each suggestion by hand.

Options:
  --json                  machine-readable JSON output
  --root <dir>            scan a directory other than the repo root
  --write-report <path>   also write the JSON report to <path>
  -h, --help              this message
`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  if (args.help) { printHelp(); process.exit(0); }
  const repoRoot = args.root ? resolve(args.root) : defaultRepoRoot;
  const result = suggestPinsForRepo(repoRoot);

  if (args.writeReportPath) {
    writeFileSync(resolve(repoRoot, args.writeReportPath), `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSuggestionsHuman(result)}\n`);
  }
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main();
}
