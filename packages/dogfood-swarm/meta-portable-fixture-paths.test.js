/**
 * meta-portable-fixture-paths.test.js — closes the CLASS behind F-2a8f4d17 /
 * F-4a7309f9 (wave 4, health-amend-a): a hardcoded, machine-specific
 * absolute path passed directly to a file-reading call in a test file.
 *
 * Two real instances of this shape shipped in this package on the same day,
 * with two DIFFERENT failure modes, both independently reproduced on this
 * repo's own Node v22.22.3 (one of ci.yml's two matrixed versions):
 *
 *   - case-file-prism-jury-intent-cap.test.js:344 (F-2a8f4d17 / F-4a7309f9)
 *     — the literal sat inside a describe() callback body, reading this
 *     swarm's own gitignored wave-2 output. A describe()-body throw is
 *     reported as a `not ok` SUITE in the TAP stream, but `# fail` stays 0
 *     and the process EXITS 0 — `npm test` reports SUCCESS while an entire
 *     block of tests silently stops existing on every machine but the one
 *     that authored them.
 *   - case-file-criterion-ids-lint.test.js:29 (F-caeeb671 / F-9d3c61eb) —
 *     the same shape at MODULE top level instead, evaluated on import
 *     before any describe()/it() runs. That one fails LOUD instead
 *     (`# fail` increments, exit code 1) — a real break, but at least a
 *     visible one.
 *
 * Both instances are fixed: the intent-cap file now builds its case-file
 * fixture in-memory (no external read at all), and the criterion-ids-lint
 * file resolves its fixture portably via
 * join(dirname(fileURLToPath(import.meta.url)), ...), matching
 * case-file.test.js's FIXTURES constant and
 * wave2-4091637-5127-swarm-cp-pins.test.js's CASE_FILE_FIXTURES constant.
 *
 * This sweep is the class-level closure the wave-4 brief asked about: it
 * fails via a plain assert inside an it() — the one shape node:test never
 * swallows (verified directly against this repo's Node: a describe()-body
 * throw exits 0, a before()-hook throw exits 1, a plain it()-body assertion
 * failure exits 1) — if either shape reappears anywhere in this package's
 * test suite.
 *
 * The sweep itself shipped with two undocumented gaps of its own
 * (F-1c3fc4dd, wave 6): it tested each physical LINE independently
 * (text.split('\n'), then a per-line regex .test()), so a readFileSync(
 * call wrapped across lines put the identifier+paren and the string
 * literal on different lines and neither line matched on its own; and its
 * quote class was ['"] only, so a backtick-quoted (template-literal)
 * absolute path was invisible outright. Both are closed below: the sweep
 * now matches each file's WHOLE TEXT instead of one line at a time
 * (findHardcodedAbsolutePathOffenders), and the quote class covers
 * ['"`]. See SCOPE below and the two self-test fixtures at the bottom of
 * this describe block, which pin both shapes so neither gap can silently
 * reopen.
 *
 * SCOPE, STATED PLAINLY (a narrow, honest guard beats a broad, noisy one):
 *   - Catches: a single-quoted, double-quoted, or backtick-quoted string
 *     literal shaped like a Windows drive-letter path (`X:\` / `X:/`) or a
 *     POSIX-absolute path (`/something`) passed DIRECTLY as the argument
 *     to readFileSync(/readFile(/require(.
 *   - Catches it even when the call is wrapped across multiple lines —
 *     e.g. the identifier and open-paren on one line, the string literal
 *     on the next — because matching runs against each file's WHOLE TEXT
 *     (findHardcodedAbsolutePathOffenders), not one physical line at a
 *     time. Not a hypothetical shape: this exact package already has three
 *     precedents for wrapping a readFileSync( call across lines
 *     (amend1-state-machine-tx.test.js, meta-amendA-findings-persist.test.js,
 *     meta-amendA-readme-contract.test.js — all portable today via
 *     join(__dirname,...)/new URL(...), so none are current offenders).
 *   - Does NOT catch: the same hardcoding one step removed through a
 *     variable (`const p = 'E:/...'; readFileSync(p)`), through string
 *     concatenation, or through a template literal whose absolute-path
 *     prefix is itself interpolated rather than literal (the value comes
 *     from a variable, not from characters immediately after the opening
 *     backtick) — all three need real data-flow analysis, not a text
 *     sweep. Known residual gap, not a silent claim of completeness.
 *   - Does NOT catch: whether a referenced RELATIVE fixture path is itself
 *     git-tracked. That is a materially heavier check (shelling out to git,
 *     or reimplementing gitignore matching) — scoped OUT of this pass as
 *     not-cheap-enough; see wave-4 swarm-cp-tests output.json.
 *   - Deliberately anchored to the CALL SITE (readFileSync(/readFile(/
 *     require(, not just "an absolute-path-shaped literal anywhere in the
 *     file") so ordinary test data that happens to look path-shaped is
 *     never flagged. A file-wide scan for the bare shape was tried first
 *     during development of this guard and hit 60+ unrelated string
 *     literals across this package alone — SQL fixture values
 *     (`'/tmp/repo'` as a synthetic `local_path` column), synthetic env
 *     values (`'/usr/bin'`, `'C:\\Windows'`), JSON-pointer field names
 *     (`'/artifact_under_test/content'`) — which is exactly the noisy,
 *     ignorable guard the wave-4 brief warned is worse than none.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

function walkTestFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { walkTestFiles(p, files); continue; }
    if (entry.name.endsWith('.test.js')) files.push(p);
  }
  return files;
}

// Anchored to the call site so ordinary path-shaped test DATA (SQL fixture
// values, synthetic env values, JSON-pointer field names — all present
// elsewhere in this suite) is never flagged. See the header for why the
// unanchored version was rejected.
//
// Quote class covers '/"/` so a template-literal path is caught too
// (F-1c3fc4dd). \s* already matches '\n' in JS regexes, so this pattern
// was never the reason a wrapped call went unseen — that was purely the
// old per-line split, fixed below by matching whole-file text instead
// (findHardcodedAbsolutePathOffenders). The `g` flag is required for
// matchAll and is safe to share across every file and every call: matchAll
// scans with a clone of this regex's match state rather than mutating the
// module-level constant's lastIndex, unlike a manual global .exec()/.test()
// loop — which is exactly the footgun this refactor avoids reintroducing.
const HARDCODED_ABSOLUTE_PATH_ARG =
  /\b(?:readFileSync|readFile|require)\(\s*[`'"](?:[A-Za-z]:[\\/]|\/[A-Za-z])/g;

// Extracted so the two self-test fixtures below can exercise the exact
// detection logic the real sweep uses, without writing throwaway files to
// disk. Operates on whole-file TEXT rather than per-line so a call wrapped
// across lines is caught regardless of which line the string literal
// lands on; the reported line number is derived from the match index
// after the fact instead of from a line-by-line scan position.
function findHardcodedAbsolutePathOffenders(text) {
  const lines = text.split('\n');
  const offenders = [];
  for (const match of text.matchAll(HARDCODED_ABSOLUTE_PATH_ARG)) {
    const startLine = text.slice(0, match.index).split('\n').length;
    const endLine = text.slice(0, match.index + match[0].length).split('\n').length;
    const snippet = lines.slice(startLine - 1, endLine).map((l) => l.trim()).join(' ');
    offenders.push({ line: startLine, snippet });
  }
  return offenders;
}

describe('meta — no hardcoded absolute fixture paths in any test file (closes the F-2a8f4d17 / F-caeeb671 class)', () => {
  it('sweep must visit at least one test file', () => {
    // Anti-vacuity insurance, same shape as F-a02393b2's in
    // amend1-tx-discipline.test.js: PKG_ROOT is __dirname and always
    // contains *.test.js files today (this file included), so this is
    // currently unreachable — but a future refactor that hands
    // walkTestFiles the wrong root must not be able to pass this gate by
    // visiting nothing.
    assert.ok(walkTestFiles(PKG_ROOT).length > 0, 'sweep must visit at least one test file');
  });

  it('no *.test.js file passes a hardcoded absolute path literal directly to readFileSync/readFile/require', () => {
    const offenders = [];
    for (const f of walkTestFiles(PKG_ROOT)) {
      const text = readFileSync(f, 'utf-8');
      const relPath = f.slice(PKG_ROOT.length + 1).split('\\').join('/');
      for (const { line, snippet } of findHardcodedAbsolutePathOffenders(text)) {
        offenders.push(`${relPath}:${line}: ${snippet}`);
      }
    }
    assert.deepEqual(offenders, [],
      `hardcoded absolute path literal(s) passed directly to readFileSync/readFile/require — this is ` +
      `the exact shape that shipped as F-2a8f4d17 (silent — a describe()-body throw does not fail ` +
      `node --test) and F-caeeb671 (loud — a module-top-level throw does). Resolve portably instead: ` +
      `join(dirname(fileURLToPath(import.meta.url)), ..., 'fixtures', 'case-files', ...), matching ` +
      `case-file.test.js's FIXTURES constant.\n  ${offenders.join('\n  ')}`);
  });

  it('catches a hardcoded absolute path literal wrapped across multiple lines, which a per-line sweep cannot see (F-1c3fc4dd)', () => {
    // Built from parts rather than written as a literal call so this
    // fixture text does not itself match HARDCODED_ABSOLUTE_PATH_ARG when
    // the sweep above scans this very file's own source — this file is a
    // *.test.js under PKG_ROOT, so walkTestFiles() visits it too.
    const fn = 'readFileSync';
    const q = "'";
    const wrapped = [
      `${fn}(`,
      `  ${q}E:/AI/testing-os/fixtures/case-files/example.json${q},`,
      `  ${q}utf-8${q}`,
      `)`,
    ].join('\n');
    const offenders = findHardcodedAbsolutePathOffenders(wrapped);
    assert.equal(offenders.length, 1,
      `a readFileSync( call wrapped across lines with a hardcoded absolute path must be caught, not ` +
      `just its single-line-equivalent form; got ${JSON.stringify(offenders)}`);
    assert.equal(offenders[0].line, 1, 'offender should be reported at the line the call opens on');
  });

  it('catches a hardcoded absolute path literal in a backtick (template-literal) string, not just single/double-quoted (F-1c3fc4dd)', () => {
    // Same "built from parts" reasoning as the wrapped-call fixture above:
    // the backtick character is held in a variable so this file's own raw
    // source never contains the literal offending sequence.
    const fn = 'readFileSync';
    const bt = '`';
    const offending = `${fn}(${bt}E:/AI/testing-os/fixtures/case-files/example.json${bt})`;
    const offenders = findHardcodedAbsolutePathOffenders(offending);
    assert.equal(offenders.length, 1,
      `a readFileSync( call using a backtick-quoted hardcoded absolute path must be caught, not just ` +
      `single/double-quoted forms; got ${JSON.stringify(offenders)}`);
  });
});
