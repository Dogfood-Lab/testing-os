/**
 * Regression tests for the roadmap-notes-integrity handler + its
 * roadmap-notes-integrity check config entry (F-8f9e3ea0, wave 39 feature
 * pass — docs/trajectory-and-closure.dispatch.md T3). Lives in its own file
 * per this repo's established convention (see check-doc-drift-roadmap.test.mjs's
 * sibling docstring for the same rationale).
 *
 * TWO-HOP SHAPE (corrected from ground truth, matching the sibling
 * roadmap-artifact-schema check's own correction): dogfood/roadmap/latest.json
 * is only the small { run_id, sequence, path } pointer — operator_notes lives
 * on the FULL document the pointer names, not on latest.json itself. Every
 * scenario below therefore constructs BOTH files via `makeRoot()`'s
 * `pointerOverrides` / `documentOverrides` params, rather than writing
 * operator_notes directly onto the pointer.
 *
 * Unlike roadmap-artifact-schema, there is no real committed fixture
 * directory to seed here — every scenario builds its own isolated fixture
 * root with a synthetic pointer + document pair, which also means (like the
 * schema check) this one carries NO pre-merge seam breakage: the live repo
 * tree has no dogfood/roadmap/latest.json yet, so the handler's
 * graceful-absence path returns [] and contributes nothing to the live-tree
 * "actual repo passes all checks" test, today or after this wave's
 * schemas/core lanes merge.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDriftChecks, REGISTERED_HANDLERS } from './check-doc-drift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const CHECK_ID = 'roadmap-notes-integrity-under-test';
const POINTER_REL = 'dogfood/roadmap/latest.json';
const DOCUMENT_REL = 'dogfood/roadmap/swarm-test-0001.json';

function writeJson(dir, rel, obj) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), JSON.stringify(obj, null, 2));
}

function writeConfig(dir) {
  const configObj = {
    checks: [{
      id: CHECK_ID,
      kind: 'roadmap-notes-integrity',
      title: 'test copy',
      target: POINTER_REL,
      targetPathField: 'path',
      notesPath: 'operator_notes',
    }],
  };
  const configPath = join(dir, 'doc-drift-config.json');
  writeFileSync(configPath, JSON.stringify(configObj, null, 2));
  return configPath;
}

/**
 * The common case: a well-formed pointer naming a document with the given
 * `operator_notes` array (or an arbitrary `documentOverrides` object when
 * testing a shape violation on the document itself).
 */
function makeRoot(t, operatorNotesOrDocumentOverrides) {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeJson(dir, POINTER_REL, { run_id: 'swarm-test-0001', sequence: 1, path: DOCUMENT_REL });
  const documentBody = Array.isArray(operatorNotesOrDocumentOverrides)
    ? { operator_notes: operatorNotesOrDocumentOverrides }
    : operatorNotesOrDocumentOverrides;
  writeJson(dir, DOCUMENT_REL, documentBody);

  return { dir, configPath: writeConfig(dir) };
}

test('graceful absence: no pointer file at all -> zero reports, clean', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = writeConfig(dir); // no pointer written
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true);
  assert.deepEqual(result.reports, []);
});

test('invalid JSON in the pointer file -> drift (blocking), not silently skipped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dirname(join(dir, POINTER_REL)), { recursive: true });
  writeFileSync(join(dir, POINTER_REL), '{ not json');
  const configPath = writeConfig(dir);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /invalid JSON/);
});

test('RED: a pointer missing its path field -> drift (T5\'s pointer promise broken)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJson(dir, POINTER_REL, { run_id: 'swarm-test-0001', sequence: 1 }); // no `path`
  const configPath = writeConfig(dir);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /no non-empty string at targetPathField 'path'/);
});

test('RED: a pointer naming a document that does not exist -> drift', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJson(dir, POINTER_REL, { run_id: 'swarm-test-0001', sequence: 1, path: 'dogfood/roadmap/does-not-exist.json' });
  const configPath = writeConfig(dir);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /does not exist at HEAD — T5's pointer promise is broken/);
});

test('invalid JSON in the pointed-to document -> drift', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJson(dir, POINTER_REL, { run_id: 'swarm-test-0001', sequence: 1, path: DOCUMENT_REL });
  mkdirSync(dirname(join(dir, DOCUMENT_REL)), { recursive: true });
  writeFileSync(join(dir, DOCUMENT_REL), '{ not json either');
  const configPath = writeConfig(dir);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /invalid JSON/);
});

test('notesPath missing from the resolved document -> config-error (our shape assumption is wrong), not drift', async (t) => {
  const { dir, configPath } = makeRoot(t, { run_id: 'x', sequence: 1 }); // document has no operator_notes key at all
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /no value at notesPath/);
});

test('notesPath resolves to a non-array -> drift', async (t) => {
  const { dir, configPath } = makeRoot(t, { operator_notes: 'not-an-array' });
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /is not an array/);
});

test('empty operator_notes array -> clean, zero reports', async (t) => {
  const { dir, configPath } = makeRoot(t, []);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true);
  assert.deepEqual(result.reports, []);
});

/** @pins F-8f9e3ea0 */
test('RED: an invariant note with no enforced_by at all -> drift (blocks)', async (t) => {
  const { dir, configPath } = makeRoot(t, [
    { kind: 'invariant', text: 'must always hold', expires: '2099-01-01' },
  ]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /kind 'invariant' has no enforced_by/);
});

test('RED: an invariant note whose enforced_by path does not exist at HEAD -> drift (blocks)', async (t) => {
  const { dir, configPath } = makeRoot(t, [
    { kind: 'invariant', text: 'must always hold', expires: '2099-01-01', enforced_by: 'scripts/this-gate-does-not-exist.mjs' },
  ]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].severity, 'drift');
  assert.match(result.reports[0].message, /enforced_by 'scripts\/this-gate-does-not-exist\.mjs' does not exist at HEAD/);
});

test('GREEN: an invariant note whose enforced_by path DOES exist at HEAD -> no report', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJson(dir, POINTER_REL, { run_id: 'swarm-test-0001', sequence: 1, path: DOCUMENT_REL });
  writeJson(dir, DOCUMENT_REL, {
    operator_notes: [
      { kind: 'invariant', text: 'must always hold', expires: '2099-01-01', enforced_by: 'some-real-gate.mjs' },
    ],
  });
  // Self-contained stand-in gate file the note's enforced_by resolves
  // against — no dependency on the real repo's file layout.
  writeFileSync(join(dir, 'some-real-gate.mjs'), '// stand-in gate file\n');
  const configPath = writeConfig(dir);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.deepEqual(result.reports, []);
});

test('WARN (non-blocking): a theme note whose expires boundary already passed -> warn severity, clean stays true, but the report is NOT silent', async (t) => {
  const { dir, configPath } = makeRoot(t, [
    { kind: 'theme', text: 'stale advice from a past run', expires: '2000-01-01' },
  ]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true, 'an expired note alone must not block the build');
  assert.equal(result.reports.length, 1, 'the expiry must still be reported, not silently dropped');
  assert.equal(result.reports[0].severity, 'warn');
  assert.match(result.reports[0].message, /expires '2000-01-01' has already passed/);
});

test('a theme note whose expires boundary is still in the future -> no report at all', async (t) => {
  const { dir, configPath } = makeRoot(t, [
    { kind: 'theme', text: 'still-current advice', expires: '2099-01-01' },
  ]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true);
  assert.deepEqual(result.reports, []);
});

test('a note whose expires equals today exactly is NOT yet expired (strict-less-than, matches isDueForRevalidation semantics)', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const { dir, configPath } = makeRoot(t, [{ kind: 'theme', text: 'expires today', expires: today }]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true);
  assert.deepEqual(result.reports, []);
});

test('COMBINATION: a drift (missing enforced_by) and a warn (expired) on two different notes coexist — clean is false because of the drift, both reports present', async (t) => {
  const { dir, configPath } = makeRoot(t, [
    { kind: 'invariant', text: 'unenforced invariant', expires: '2099-01-01' },
    { kind: 'theme', text: 'expired theme', expires: '2000-01-01' },
  ]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 2);
  const severities = result.reports.map((r) => r.severity).sort();
  assert.deepEqual(severities, ['drift', 'warn']);
});

test('an invariant note that is BOTH missing enforced_by AND expired reports both violations for the same note', async (t) => {
  const { dir, configPath } = makeRoot(t, [
    { kind: 'invariant', text: 'unenforced and expired', expires: '2000-01-01' },
  ]);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 2);
  const severities = result.reports.map((r) => r.severity).sort();
  assert.deepEqual(severities, ['drift', 'warn']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Framework wiring
// ─────────────────────────────────────────────────────────────────────────────

test('roadmap-notes-integrity is registered with the framework and declares its required fields', () => {
  const handler = REGISTERED_HANDLERS['roadmap-notes-integrity'];
  assert.ok(handler, 'expected roadmap-notes-integrity in REGISTERED_HANDLERS');
  assert.equal(handler.kind, 'roadmap-notes-integrity');
  assert.equal(typeof handler.run, 'function');
  assert.deepEqual(handler.requiredFields, ['target', 'targetPathField', 'notesPath']);
});

test('framework-self-test catches a roadmap-notes-integrity check missing a required field', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-notes-integrity-selftest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configObj = {
    checks: [
      { id: 'incomplete-notes-check', kind: 'roadmap-notes-integrity', title: 'missing targetPathField and notesPath' }, // target present, the other two missing
      { id: 'self-test', kind: 'framework-self-test', title: 'self-test', configPath: 'doc-drift-config.json' },
    ],
  };
  const configPath = join(dir, 'doc-drift-config.json');
  writeFileSync(configPath, JSON.stringify(configObj, null, 2));
  const result = await runDriftChecks({ repoRoot: dir, configPath, checkId: 'self-test' });
  assert.equal(result.clean, false);
  const messages = result.reports.map((r) => r.message).join('\n');
  assert.match(messages, /missing required field 'targetPathField'/);
  assert.match(messages, /missing required field 'notesPath'/);
});

test('the real doc-drift-patterns.json wires roadmap-notes-integrity with the two-hop pointer shape the finding specifies', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8'));
  const entry = config.checks.find((c) => c.id === 'roadmap-notes-integrity');
  assert.ok(entry, 'expected a roadmap-notes-integrity check entry in scripts/doc-drift-patterns.json');
  assert.equal(entry.kind, 'roadmap-notes-integrity');
  assert.equal(entry.target, 'dogfood/roadmap/latest.json');
  assert.equal(entry.targetPathField, 'path', 'latest.json is the pointer — targetPathField names the field that points at the real document');
  // ADJUDICATED at the wave-39 merge: this pin's draft said 'operator_notes'
  // (the schema vocabulary, F-fe05c6d7) — but the first REAL compiled
  // artifact carries its notes at a flat top-level 'notes' array (the CLI
  // envelope, post-reconciliation). The document-schema-vs-CLI-envelope
  // field reconciliation LANDED at the wave-43 merge (Amendment 3): the
  // envelope now emits the schema-named `operator_notes`, the sequence-3
  // artifact carries it, and the config's pointer followed in the same
  // reconciliation commit. The config — and this pin — track the live shape,
  // because a gate aimed at a vocabulary the writer does not emit checks
  // nothing; pre-A3 that meant 'notes', post-A3 it means 'operator_notes'.
  assert.equal(entry.notesPath, 'operator_notes');
});

test('LIVE TREE: the real roadmap-notes-integrity check contributes zero reports against the actual repo today (graceful absence before the first compile; zero note violations after it — the inaugural artifact has an empty notes array)', async () => {
  const result = await runDriftChecks({ repoRoot, checkId: 'roadmap-notes-integrity' });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.deepEqual(result.reports, []);
});
