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
 * SCOPE, STATED PLAINLY (a narrow, honest guard beats a broad, noisy one):
 *   - Catches: a string literal shaped like a Windows drive-letter path
 *     (`X:\` / `X:/`) or a POSIX-absolute path (`/something`) passed
 *     DIRECTLY as the argument to readFileSync(/readFile(/require(.
 *   - Does NOT catch: the same hardcoding one step removed through a
 *     variable (`const p = 'E:/...'; readFileSync(p)`) — that needs real
 *     data-flow analysis, not a text sweep. Known residual gap, not a
 *     silent claim of completeness.
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
const HARDCODED_ABSOLUTE_PATH_ARG =
  /\b(?:readFileSync|readFile|require)\(\s*['"](?:[A-Za-z]:[\\/]|\/[A-Za-z])/;

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
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (HARDCODED_ABSOLUTE_PATH_ARG.test(line)) {
          offenders.push(`${f.slice(PKG_ROOT.length + 1).split('\\').join('/')}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      `hardcoded absolute path literal(s) passed directly to readFileSync/readFile/require — this is ` +
      `the exact shape that shipped as F-2a8f4d17 (silent — a describe()-body throw does not fail ` +
      `node --test) and F-caeeb671 (loud — a module-top-level throw does). Resolve portably instead: ` +
      `join(dirname(fileURLToPath(import.meta.url)), ..., 'fixtures', 'case-files', ...), matching ` +
      `case-file.test.js's FIXTURES constant.\n  ${offenders.join('\n  ')}`);
  });
});
