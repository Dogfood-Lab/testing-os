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
 * A THIRD gap shipped undocumented too (F-fc8be6ed, wave 18): the call-site
 * alternation covered readFileSync/readFile/require but omitted dynamic
 * import(), even though import() is idiomatic in this exact package's
 * mutation-testing pattern (redrive.test.js's
 * importRedriveWithCompletePromotedToEligible, clean-claims.test.js's
 * loadCleanClaimsMutant — both do `await import(pathToFileURL(mutantPath).href)`,
 * a dynamically-constructed path one edit away from being hardcoded during a
 * debugging session, which is exactly how F-2a8f4d17/F-4a7309f9 themselves
 * shipped). No live instance existed when this was found — every direct
 * import('literal') call site in this package's root test files already used
 * a portable relative path — so this was a coverage gap in the guard, not a
 * live defect, matching how F-1c3fc4dd's two gaps above were rated. Closed
 * below: `import` joins the call-site alternation, with a third self-test
 * fixture pinning the shape so it cannot silently reopen.
 *
 * A FOURTH gap shipped undocumented too (F-c3034954, wave 20): the call-site
 * pattern required a quote character immediately (modulo whitespace) after
 * the call's opening paren, which missed the already-idiomatic composed form
 * `readFileSync(new URL(<literal>, import.meta.url), 'utf-8')` entirely —
 * the token immediately after the paren is `new`, not a quote. This is a
 * real hazard, not just a regex gap: the WHATWG URL spec's Windows-drive-
 * letter special case silently DISCARDS the import.meta.url base for a
 * drive-letter-shaped relative reference (confirmed directly against this
 * repo's own Node runtime: `new URL('E:/AI/testing-os/README.md',
 * 'file:///.../x.test.js')` resolves to `e:/AI/testing-os/README.md`,
 * dropping the base entirely) — reproducing the exact machine-specific-
 * absolute-path hazard this whole file exists to prevent, through a call
 * shape this file's own header already cites as "portable today." No live
 * instance existed when this was found — every real `new URL(...)` call
 * site in this package (meta-amendA-readme-contract.test.js x4) already uses
 * a genuine relative first argument — so this was a coverage gap in the
 * guard, not a live defect, matching how F-1c3fc4dd's and F-fc8be6ed's gaps
 * above were rated. Closed below: the call-site pattern now also matches an
 * optional `new URL(` immediately before the quoted literal — no new
 * alternation member needed, since readFileSync/readFile/require/import are
 * already named — with a self-test fixture pinning the shape and a negative
 * control proving the safe relative form stays unflagged. NOT extended to
 * import.meta.resolve(/require.resolve(/path.resolve( — see SCOPE below;
 * each would need a new, dotted alternation member (a materially bigger
 * detector change) and is scoped out of this fix as a disclosed residual,
 * not a silent claim of completeness.
 *
 * SCOPE, STATED PLAINLY (a narrow, honest guard beats a broad, noisy one):
 *   - Catches: a single-quoted, double-quoted, or backtick-quoted string
 *     literal shaped like a Windows drive-letter path (`X:\` / `X:/`) or a
 *     POSIX-absolute path (`/something`) passed DIRECTLY as the argument
 *     to readFileSync(/readFile(/require(/import(, OPTIONALLY wrapped one
 *     level in `new URL(<literal>, import.meta.url)` (F-c3034954, wave 20)
 *     — i.e. the literal may sit either immediately after the call's own
 *     paren, or immediately after a `new URL(` that itself immediately
 *     follows the call's paren. The last named call is a dynamic import()
 *     CALL EXPRESSION (`import('...')`), not a static
 *     `import ... from '...'` declaration — a static import never has an
 *     open-paren immediately after the `import` keyword, so it cannot match
 *     this alternation.
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
 *   - Does NOT catch: an absolute path resolved via import.meta.resolve(,
 *     require.resolve(, or path.resolve( with an absolute literal argument
 *     (F-c3034954, wave 20). Each would need its own new, dotted alternation
 *     member — a materially bigger detector change than the inline
 *     `new URL(...)` extension this fix made — and was scoped out rather
 *     than folded in unreviewed. Known residual gap, not a silent claim of
 *     completeness.
 *   - Deliberately anchored to the CALL SITE (readFileSync(/readFile(/
 *     require(/import(, not just "an absolute-path-shaped literal anywhere
 *     in the file") so ordinary test data that happens to look path-shaped is
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

// F-90ee1ab5 (wave 20, NOT fully closed — cross-domain, see below): this
// function is byte-for-byte identical to meta-wal-sidecar-teardown-guard.
// test.js's own walkTestFiles, and near-identical (different extension
// filter) to reason-escaping-discipline.test.js's walkSync. A fix to this
// copy's directory-walk logic has no mechanical reason to reach either
// sibling — mirror any such edit into BOTH. The established fix — extract
// to test-support/ alongside strip-comments.js (which the sibling
// meta-wal-sidecar-teardown-guard.test.js already imports) — is NOT done
// here: packages/dogfood-swarm/test-support/** matches no owned, shared, or
// bridge glob in this wave's frozen domain map (this domain's own bridge
// glob, packages/dogfood-swarm/*.test.js, does not cross the test-support/
// directory boundary), so a new file there would land unassigned and fail
// this agent's own ownership check. Needs a domain-map amendment before it
// can be extracted; see this wave's swarm-cp-tests output.json skipped[]
// entry for the full mechanical proof.
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
//
// `import` joins the alternation for F-fc8be6ed (wave 18): `\b` requires a
// word boundary immediately before, and the whole alternative still needs
// the immediately-following `(` this pattern requires of every alternative
// — so a static `import ... from '...'` declaration (keyword, whitespace,
// then `{`/an identifier/`*`, never `(`) cannot match this alternation; only
// the dynamic import(...) CALL EXPRESSION can.
//
// The optional `(?:new\s+URL\(\s*)?` group closes F-c3034954 (wave 20): the
// already-idiomatic composed form `readFileSync(new URL('<abs>',
// import.meta.url))` has `new`, not a quote, immediately after the call's
// paren, so without this the quote class below never got a chance to match.
// No new alternation member needed — the same four named calls already
// cover this, just with one optional extra hop before the literal. `\s+`/
// `\s*` here tolerate the same multi-line wrapping the rest of this pattern
// already does (see above).
const HARDCODED_ABSOLUTE_PATH_ARG =
  /\b(?:readFileSync|readFile|require|import)\(\s*(?:new\s+URL\(\s*)?[`'"](?:[A-Za-z]:[\\/]|\/[A-Za-z])/g;

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

  it('no *.test.js file passes a hardcoded absolute path literal directly to readFileSync/readFile/require/import', () => {
    const offenders = [];
    for (const f of walkTestFiles(PKG_ROOT)) {
      const text = readFileSync(f, 'utf-8');
      const relPath = f.slice(PKG_ROOT.length + 1).split('\\').join('/');
      for (const { line, snippet } of findHardcodedAbsolutePathOffenders(text)) {
        offenders.push(`${relPath}:${line}: ${snippet}`);
      }
    }
    assert.deepEqual(offenders, [],
      `hardcoded absolute path literal(s) passed directly to readFileSync/readFile/require/import — this ` +
      `is the exact shape that shipped as F-2a8f4d17 (silent — a describe()-body throw does not fail ` +
      `node --test) and F-caeeb671 (loud — a module-top-level throw does), and the dynamic-import() ` +
      `variant of the same shape F-fc8be6ed named as this exact package's live mutation-testing idiom. ` +
      `Resolve portably instead: join(dirname(fileURLToPath(import.meta.url)), ..., 'fixtures', ` +
      `'case-files', ...), matching case-file.test.js's FIXTURES constant.\n  ${offenders.join('\n  ')}`);
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

  it('catches a hardcoded absolute path literal passed directly to dynamic import(), the F-fc8be6ed gap (idiomatic in this package for mutation-testing: redrive.test.js, clean-claims.test.js)', () => {
    // Same "built from parts" reasoning as the two fixtures above: `fn` is
    // held in a variable so this file's own raw source never contains the
    // literal offending sequence (this file is itself a *.test.js under
    // PKG_ROOT, so walkTestFiles() visits it too).
    const fn = 'import';
    const q = "'";
    const offending = `await ${fn}(${q}E:/AI/testing-os/swarms/run-id/wave-1/mutant.mjs${q});`;
    const offenders = findHardcodedAbsolutePathOffenders(offending);
    assert.equal(offenders.length, 1,
      `a dynamic import( call with a hardcoded absolute path must be caught — this is the exact live ` +
      `pattern (await import(pathToFileURL(mutantPath).href)) one edit away from a hardcoded literal in ` +
      `redrive.test.js / clean-claims.test.js's mutation-testing helpers; got ${JSON.stringify(offenders)}`);

    // Negative control alongside the positive: a STATIC import declaration
    // (never a call — `\bimport\(` cannot match because no `(` immediately
    // follows the keyword) must not be flagged, so this guard cannot regress
    // into the "60+ unrelated string literals" noise the header rejects.
    const staticImport = `import { readFileSync } from 'node:fs';`;
    assert.deepEqual(findHardcodedAbsolutePathOffenders(staticImport), [],
      'a static import declaration must never be flagged, only the dynamic import(...) call expression');
  });

  it('catches a hardcoded absolute path literal wrapped in new URL(..., import.meta.url), the F-c3034954 gap (idiomatic in this package: meta-amendA-readme-contract.test.js)', () => {
    // Same "built from parts" reasoning as the fixtures above: `fn` is held
    // in a variable so this file's own raw source never contains the literal
    // offending sequence (this file is itself a *.test.js under PKG_ROOT, so
    // walkTestFiles() visits it too). This is the REAL idiom
    // (readFileSync(new URL('./README.md', import.meta.url), 'utf-8')) with
    // only the first URL argument changed from relative to absolute — proven
    // live-hazardous, not just a regex miss: new URL('E:/...', <base>)
    // silently discards <base> for a drive-letter-shaped reference (WHATWG
    // URL's own Windows special case), reproducing the exact
    // machine-specific-path hazard this file exists to prevent.
    const fn = 'readFileSync';
    const q = "'";
    const offending = `${fn}(new URL(${q}E:/AI/testing-os/README.md${q}, import.meta.url), ${q}utf-8${q})`;
    const offenders = findHardcodedAbsolutePathOffenders(offending);
    assert.equal(offenders.length, 1,
      `a readFileSync(new URL(<absolute literal>, import.meta.url)) call must be caught — the composed ` +
      `form the old call-site pattern missed entirely because the token immediately after the paren is ` +
      `'new', not a quote; got ${JSON.stringify(offenders)}`);

    // Negative control alongside the positive: the SAME composed shape with
    // a genuine RELATIVE first argument — the form all 7 real new URL(...)
    // call sites in this package actually use today — must stay unflagged,
    // so this guard cannot regress into flagging the portable idiom its own
    // header cites as the recommended fix.
    const safeRelative = `${fn}(new URL(${q}./README.md${q}, import.meta.url), ${q}utf-8${q})`;
    assert.deepEqual(findHardcodedAbsolutePathOffenders(safeRelative), [],
      'new URL(...) with a genuine relative first argument must never be flagged — that is the portable, recommended idiom');
  });
});
