/**
 * F-8c6c0deb: allowlist-staleness detection for check-doc-drift.mjs's
 * by-name file allowlists.
 *
 * THE DEFECT. `allowlist` (schema-conformance, forbidden-pattern-in-targets,
 * helper-adoption-sweep) is a PERMANENT, SILENT structural exclusion — a
 * named file is skipped from validation forever, with nothing checking
 * whether the reason for the exemption still holds. forbidden-pattern-in-
 * targets already closed this gap for itself (2026-07-17 rescope —
 * allowlistDidWork + a stale-exemption warn block, see that handler in
 * check-doc-drift.mjs). F-8c6c0deb named the schema-conformance handler as
 * the still-open sibling; the sibling sweep this fix's own dispatch required
 * (swarms/PROTOCOL.md, "Fixing a class, not an instance") found a SECOND
 * still-open sibling — helper-adoption-sweep's own `allowlist.has(file)`
 * skip. Both are fixed here, both tested here, both mirroring
 * forbidden-pattern-in-targets' already-proven shape.
 *
 * source-vs-target-coverage's OWN `allowlist` (the first of the three
 * `allowlist.has` sites named in the finding) was assessed and is NOT a
 * sibling — it exempts a TOKEN from a "must be documented somewhere"
 * requirement, not a FILE from a pass/fail check, so there is no "started
 * conforming" event to detect. See the comment at that handler's
 * declaration in check-doc-drift.mjs for the full assessment; not
 * re-tested here since nothing changed there.
 *
 * Both fixes share one shape: WARN (never block) when an allowlisted entry
 * no longer needs its exemption. 'warn' does not flip result.clean false
 * (check-doc-drift.mjs's own `clean = reports.every(r => r.severity ===
 * 'warn')`, F-8f9e3ea0), so landing the detector cannot turn any
 * currently-green check red — a live config that happens to have a stale
 * entry today gets a new WARN line, never a new failure. Verified directly
 * against the real repo: all 3 live roadmap-artifact-full-document-schema
 * allowlist entries were Ajv-validated against the real schema before this
 * fix landed and all 3 still fail (17, 13, and 1 errors respectively) — the
 * "now VALIDATES" branch this file tests is exercised only by synthetic
 * fixtures here, never by the real committed artifacts today.
 *
 * A REAL FALSE POSITIVE, CAUGHT BEFORE SHIPPING. The helper-adoption-sweep
 * fix's first draft flagged every one of this repo's 5 real
 * helper-adoption-sweep checks as having a stale allowlist entry — because
 * every one of them lists its OWN HELPER FILE in its own allowlist, and the
 * handler's own module docstring names that explicitly as a legitimate,
 * permanent reason ("files that legitimately use the primitive (e.g. the
 * helper itself, test fixtures)") — orthogonal to "hasn't adopted the
 * helper yet." Caught by running the fix against the LIVE
 * scripts/doc-drift-patterns.json, not just synthetic fixtures (this
 * file's own two "never warns" tests below regression-guard both halves of
 * that docstring line: the helper file, and a test-fixture file). After the
 * fix, the real config surfaces exactly 4 genuine, previously-invisible
 * stale entries — non-blocking WARNs, left in place for a human to act on,
 * not fixed here (scripts/doc-drift-patterns.json is outside this file's
 * ownership; see the amend's own file-ownership boundary):
 *   - packages/findings/review/event-log.js (helper-adoption--atomic-write)
 *   - packages/portfolio/generate.js (helper-adoption--atomic-write)
 *   - packages/report/build-submission.js (helper-adoption--atomic-write)
 *   - packages/ingest/persist.js (helper-adoption--unsafe-segment)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDriftChecks } from './check-doc-drift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const documentFixturesDir = join(repoRoot, 'scripts/__roadmap-document-fixtures__');
const realSchemaRel = 'packages/schemas/src/json/dogfood-roadmap.schema.json';

/** Mirrors check-doc-drift.test.mjs's own makeFixture() — not exported there, so re-derived here (each focused *.test.mjs file in this family owns its own small fixture helper; see check-doc-drift-roadmap.test.mjs's makeIsolatedRoot for the same convention). */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-doc-drift-allowlist-staleness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    config(obj) {
      const p = join(dir, 'doc-drift-config.json');
      writeFileSync(p, JSON.stringify(obj, null, 2));
      return p;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// schema-conformance (F-8c6c0deb primary target)
// ─────────────────────────────────────────────────────────────────────────────

function makeSchemaFixture(t) {
  const fx = makeFixture(t);
  fx.write(realSchemaRel, readFileSync(join(repoRoot, realSchemaRel)));
  // Keeps the targets glob non-vacuous with a real, currently-conforming,
  // NON-allowlisted fixture — isolates "does the staleness pass fire" from
  // "did the check's own zero-match config-error guard fire instead."
  fx.write(
    'scripts/__roadmap-document-fixtures__/valid-minimal.json',
    readFileSync(join(documentFixturesDir, 'valid-minimal.json')),
  );
  return fx;
}

test('F-8c6c0deb: an allowlisted file that STILL does not conform stays completely silent — the pre-existing permanent-silent contract is unchanged', async (t) => {
  const fx = makeSchemaFixture(t);
  // The exact live shape this finding's own evidence used: a legacy
  // camelCase roadmap artifact (see check-doc-drift-roadmap.test.mjs's A3.6
  // widening probe for the same shape), proven throughout this suite to
  // violate the real schema on multiple required fields.
  const legacyShape = {
    runId: 'swarm-test-1', repo: 'o/r', compiled_at: '2026-07-15T09:00:38.000Z',
    notes: [], expired: [], attention: [], drain: {}, notesPath: 'dogfood/roadmap-notes.json',
  };
  fx.write('dogfood/roadmap/swarm-staleness-1.1.json', JSON.stringify(legacyShape, null, 2));
  const configPath = fx.config({
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'F-8c6c0deb probe: still-nonconforming stays silent',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      allowlist: ['dogfood/roadmap/swarm-staleness-1.1.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0,
    'a still-nonconforming allowlisted file must produce zero reports of any severity');
});

/** @pins F-8c6c0deb */
test('F-8c6c0deb: an allowlisted file that STARTS conforming gets a non-blocking WARN naming it, without flipping the gate red', async (t) => {
  const fx = makeSchemaFixture(t);
  // Byte-identical to a fixture already proven (the F-f52fc700 seam-proof
  // tests in check-doc-drift-roadmap.test.mjs) to validate against the real,
  // current schema — i.e. exactly the "started conforming" event this
  // finding describes.
  fx.write(
    'dogfood/roadmap/swarm-staleness-2.1.json',
    readFileSync(join(documentFixturesDir, 'valid-minimal.json')),
  );
  const configPath = fx.config({
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'F-8c6c0deb probe: now-conforming warns',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      allowlist: ['dogfood/roadmap/swarm-staleness-2.1.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  // 'warn' is non-blocking: check-doc-drift.mjs's own
  // `clean = reports.every(r => r.severity === 'warn')` (F-8f9e3ea0).
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 1, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports[0].severity, 'warn');
  assert.match(result.reports[0].message, /swarm-staleness-2\.1\.json/);
  // Factual, not a demand — an allowlist entry can be permanent for a reason
  // unrelated to conformance (e.g. T5 immutability). Coordinator correction
  // (this run): phrase as "now validates," never "exemption is unneeded."
  assert.match(result.reports[0].message, /now VALIDATES/);
  assert.doesNotMatch(result.reports[0].message, /unneeded|no longer needed/i);
});

test('F-8c6c0deb: an allowlist entry whose file no longer exists on disk is silently skipped by the staleness pass (not a crash, not a report)', async (t) => {
  const fx = makeSchemaFixture(t);
  const configPath = fx.config({
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'F-8c6c0deb probe: dangling entry',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      allowlist: ['dogfood/roadmap/swarm-does-not-exist.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0);
});

test('F-8c6c0deb: an allowlisted file with malformed JSON is silently skipped by the staleness pass — invalid JSON cannot be a false grant', async (t) => {
  const fx = makeSchemaFixture(t);
  fx.write('dogfood/roadmap/swarm-staleness-3.1.json', '{ not valid json');
  const configPath = fx.config({
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'F-8c6c0deb probe: malformed JSON allowlisted entry',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      allowlist: ['dogfood/roadmap/swarm-staleness-3.1.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0);
});

test('F-8c6c0deb: the companion pass is a no-op for a check with an empty allowlist (the agent-output-schema / roadmap-artifact-schema shape today) — the shared-handler generalization does not spuriously warn where nothing is allowlisted', async (t) => {
  const fx = makeSchemaFixture(t);
  const configPath = fx.config({
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'F-8c6c0deb probe: empty allowlist is a no-op',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      allowlist: [],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0);
});

test('F-8c6c0deb: the real doc-drift-patterns.json check entries stay wired the way the class fix relies on — schema-conformance is a SHARED handler, so the companion pass covers every check of that kind automatically', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8'));
  const schemaConformanceChecks = config.checks.filter((c) => c.kind === 'schema-conformance');
  assert.ok(schemaConformanceChecks.length >= 3, 'expected at least the 3 known schema-conformance checks (agent-output-schema, roadmap-artifact-schema, roadmap-artifact-full-document-schema)');
  const withAllowlist = schemaConformanceChecks.filter((c) => (c.allowlist ?? []).length > 0);
  assert.deepEqual(
    withAllowlist.map((c) => c.id),
    ['roadmap-artifact-full-document-schema'],
    'today, exactly one schema-conformance check carries a non-empty allowlist — this is the check the finding scoped its evidence to, and the ONLY one this fix has live reports to test against; the other schema-conformance checks (empty allowlist) get the staleness pass for free the moment they ever add one, because the pass lives in the one shared schemaConformanceHandler function, not per-check config',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// helper-adoption-sweep (F-8c6c0deb sibling sweep — true sibling, same fix).
// This handler's `allowlist.has(file)` skip (check-doc-drift.mjs, formerly
// line ~625) is the SAME permanent-silent-file-skip shape the finding named
// at schema-conformance: an allowlisted caller is never re-checked for
// whether it has since adopted the helper import or dropped the raw call.
// source-vs-target-coverage (assessed above, NOT a sibling) is the only one
// of the three named `allowlist.has` sites that stays unfixed by design.
// ─────────────────────────────────────────────────────────────────────────────

function makeHelperFixture(t) {
  const fx = makeFixture(t);
  fx.write('packages/findings/lib/atomic-write.js', `
    export function atomicWriteFileSync(p, c) {}
  `);
  return fx;
}

test('F-8c6c0deb sibling (helper-adoption-sweep): an allowlisted file that STILL uses the raw primitive without importing the helper stays silent — unchanged prior behavior', async (t) => {
  const fx = makeHelperFixture(t);
  fx.write('packages/legacy/old.js', `
    import { writeFileSync } from 'node:fs';
    writeFileSync('x', 'y');
  `);
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/legacy/old.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0);
});

/** @pins F-8c6c0deb */
test('F-8c6c0deb sibling (helper-adoption-sweep): an allowlisted file that ADOPTED the helper import gets a non-blocking WARN, without flipping the gate red', async (t) => {
  const fx = makeHelperFixture(t);
  // Same shape as old.js, but now ALSO imports the helper — the exact
  // "quietly did the right thing" event this finding's staleness class
  // describes. Still contains the raw call too (a realistic in-progress
  // migration state), which is why this must WARN rather than silently
  // pass: the entry is not doing what it was added for.
  fx.write('packages/legacy/reformed.js', `
    import { writeFileSync } from 'node:fs';
    import { atomicWriteFileSync } from '../findings/lib/atomic-write.js';
    writeFileSync('x', 'y'); // still raw, but the import now exists too
  `);
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/legacy/reformed.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 1, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports[0].severity, 'warn');
  assert.match(result.reports[0].message, /reformed\.js/);
  assert.match(result.reports[0].message, /exempted nothing/);
});

test('F-8c6c0deb sibling (helper-adoption-sweep): an allowlisted file that dropped the raw call entirely also gets a non-blocking WARN', async (t) => {
  const fx = makeHelperFixture(t);
  fx.write('packages/legacy/clean-now.js', `
    import { atomicWriteFileSync } from '../findings/lib/atomic-write.js';
    atomicWriteFileSync('x', 'y');
  `);
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/legacy/clean-now.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 1, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports[0].severity, 'warn');
  assert.match(result.reports[0].message, /clean-now\.js/);
});

test('F-8c6c0deb sibling (helper-adoption-sweep): an allowlist entry naming a file no longer matched by the callers glob also gets a non-blocking WARN (file missing / outside callers)', async (t) => {
  const fx = makeHelperFixture(t);
  // No file written at packages/legacy/gone.js at all — the entry names a
  // caller that no longer exists (deleted, renamed, or never matched by the
  // callers glob to begin with).
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/legacy/gone.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 1, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports[0].severity, 'warn');
  assert.match(result.reports[0].message, /gone\.js/);
});

test('F-8c6c0deb sibling (helper-adoption-sweep): the check\'s OWN HELPER FILE listed in its own allowlist never warns — this is a documented legitimate reason, not staleness (regression guard for a real false-positive this fix shipped with and then caught by running against the live repo config)', async (t) => {
  const fx = makeHelperFixture(t);
  // No OTHER caller at all — the only file in scope is the helper itself,
  // which necessarily contains the raw primitive internally. This is the
  // EXACT live shape of all 5 real helper-adoption-sweep checks in this
  // repo's own scripts/doc-drift-patterns.json (each lists its own helper
  // in its own allowlist) — before the fix below, this synthetic case (and
  // the real config) both produced a spurious WARN.
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/findings/lib/atomic-write.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0,
    'the helper file must never be flagged stale — "the helper itself" is an explicitly documented legitimate allowlist reason (see this handler\'s own JSDoc: "files that legitimately use the primitive (e.g. the helper itself, test fixtures)"), structurally permanent and unrelated to whether a CALLER adopted the import');
});

test('F-8c6c0deb sibling (helper-adoption-sweep): a TEST FILE listed in its own allowlist never warns either — the module docstring names "test fixtures" as the other documented legitimate allowlist reason, alongside "the helper itself"', async (t) => {
  const fx = makeHelperFixture(t);
  fx.write('packages/legacy/old.test.js', `
    import { writeFileSync } from 'node:fs';
    writeFileSync('fixture', 'data');
  `);
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/legacy/old.test.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0,
    'a test-file allowlist entry must never be flagged stale — same reasoning as the helper-file case above, and the same class of false positive would have shipped for this category too had it not been special-cased identically');
});

test('F-8c6c0deb sibling (helper-adoption-sweep): the companion pass is a no-op when the check has no allowlist at all', async (t) => {
  const fx = makeHelperFixture(t);
  fx.write('packages/dogfood-swarm/commands/dispatch.js', `
    import { atomicWriteFileSync } from '../../findings/lib/atomic-write.js';
    atomicWriteFileSync('out', 'data');
  `);
  const configPath = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.length, 0);
});

test('F-8c6c0deb sibling: the real doc-drift-patterns.json helper-adoption-sweep entries all still resolve — a live sanity check that this fix has real config to run against, not just synthetic fixtures', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8'));
  const helperChecks = config.checks.filter((c) => c.kind === 'helper-adoption-sweep');
  const withAllowlist = helperChecks.filter((c) => (c.allowlist ?? []).length > 0);
  assert.ok(withAllowlist.length >= 5, `expected at least 5 helper-adoption-sweep checks with a non-empty allowlist; got ${withAllowlist.length}`);
});
