/**
 * Regression tests for the roadmap-artifact-schema check config entry
 * (F-7493be3c, wave 39 feature pass — docs/trajectory-and-closure.dispatch.md
 * T1). Lives in its own file rather than growing check-doc-drift.test.mjs
 * further, mirroring this repo's own convention of many focused
 * check-*.test.mjs files (check-accent-color, check-dashboard,
 * check-handbook-imagery, ...) rather than one monolith.
 *
 * SHAPE CORRECTION (made from ground truth, not left as a guess): the first
 * draft of this check assumed dogfood/roadmap/latest.json held the FULL
 * compiled roadmap document (run_id/sequence/compiled_at/operator_notes/...).
 * Reading packages/schemas/src/json/dogfood-roadmap.schema.json directly from
 * the backend lane's own worktree (w39-backend, already committed at 8a5d741
 * as of this fix — the schemas domain builds this file in the SAME parallel
 * wave) showed that assumption was wrong: latest.json is the SMALL
 * `{ run_id, sequence, path }` pointer shaped by that schema's own
 * $defs.latestPointer sub-schema (T5's "one mutable pointer to the newest
 * compiled roadmap version"); the full document lives at the path it names.
 * This is exactly the kind of thing this repo's own ethos (swarms/CLAUDE.md,
 * "read the source, don't recall it") argues for checking rather than
 * assuming — reachable here because reading another lane's already-committed
 * work is not restricted the way EDITING outside this domain is.
 *
 * Two things follow, both deliberate:
 *
 *   1. This file does NOT assert that running the live repoRoot's
 *      roadmap-artifact-schema check is clean — it structurally cannot be
 *      until the schemas-domain file MERGES into this tree (it already
 *      exists in the backend lane's own worktree, just not here yet). See
 *      the "static config shape" test below for what CAN be pinned
 *      permanently: the check entry's own wiring, independent of whether
 *      its schema dependency has landed in this specific tree.
 *   2. To prove the check config + this lane's fixtures are actually SOUND
 *      (not just present), this file builds an ISOLATED fixture root with
 *      its own stand-in schema — a $defs.latestPointer fragment transcribed
 *      from the real backend-lane file (field names, required list, and
 *      additionalProperties:false all matched deliberately) — and copies in
 *      the REAL committed fixtures from scripts/__roadmap-fixtures__/ by
 *      reading their actual file content, so a future edit to those
 *      fixtures is exercised by this test without a second hand-duplicated
 *      copy.
 *
 * Once the schemas domain's real file MERGES into this tree, the live-tree
 * tests in check-doc-drift.test.mjs (LIVE TREE: actual repo passes all drift
 * checks; the doublestarToRegex sentinel live-CLI test) resolve on their own
 * — no code change needed here, PROVIDED the merged file's $defs.latestPointer
 * still matches what this file transcribed. If it does not, that is a real
 * integration drift for the coordinator's serial verify to catch, not
 * something this test should paper over.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDriftChecks } from './check-doc-drift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const realFixturesDir = join(repoRoot, 'scripts/__roadmap-fixtures__');
const SCHEMA_POINTER = '#/$defs/latestPointer';

// A stand-in schema whose top-level $defs.latestPointer was transcribed
// field-for-field from the backend lane's real, already-committed
// packages/schemas/src/json/dogfood-roadmap.schema.json (required:
// ['run_id', 'sequence', 'path'], additionalProperties: false). The
// enclosing top-level object is NOT a copy of the real document (this check
// never validates the full document, only the latestPointer fragment via
// schemaPointer) — it exists only so the fixture has a schema FILE to load;
// $defs is the only part that matters here.
const STAND_IN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.test/dogfood-roadmap-stand-in.schema.json',
  title: 'Dogfood Roadmap (TEST STAND-IN for F-7493be3c seam proof — $defs.latestPointer transcribed from the real schema, the rest is not)',
  type: 'object',
  $defs: {
    latestPointer: {
      type: 'object',
      required: ['run_id', 'sequence', 'path'],
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },
        sequence: { type: 'integer', minimum: 1 },
        path: { type: 'string', minLength: 1 },
      },
    },
  },
};

/**
 * Build an isolated fixture root: the stand-in schema at the same relative
 * path the real config uses, plus copies (by content, not re-typed) of
 * whichever real committed fixtures match `namePattern`.
 */
function makeIsolatedRoot(t, namePattern) {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-schema-seam-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const schemaRel = 'packages/schemas/src/json/dogfood-roadmap.schema.json';
  mkdirSync(dirname(join(dir, schemaRel)), { recursive: true });
  writeFileSync(join(dir, schemaRel), JSON.stringify(STAND_IN_SCHEMA, null, 2));

  const fixturesRel = 'scripts/__roadmap-fixtures__';
  mkdirSync(join(dir, fixturesRel), { recursive: true });
  const realNames = readdirSync(realFixturesDir).filter((n) => namePattern.test(n));
  assert.ok(realNames.length > 0, `expected at least one real fixture matching ${namePattern} in ${realFixturesDir}`);
  for (const name of realNames) {
    writeFileSync(join(dir, fixturesRel, name), readFileSync(join(realFixturesDir, name)));
  }

  const configObj = {
    checks: [{
      id: 'roadmap-artifact-schema',
      kind: 'schema-conformance',
      title: 'seam-proof copy of the real check',
      schema: schemaRel,
      schemaPointer: SCHEMA_POINTER,
      targets: [`${fixturesRel}/*.json`],
      allowlist: [],
      negativeFilenamePattern: '^invalid-',
    }],
  };
  const configPath = join(dir, 'doc-drift-config.json');
  writeFileSync(configPath, JSON.stringify(configObj, null, 2));

  return { dir, configPath };
}

/** @pins F-7493be3c */
test('F-7493be3c seam proof: the real valid-*.json fixtures validate against $defs.latestPointer transcribed from the real backend-lane schema', async (t) => {
  const { dir, configPath } = makeIsolatedRoot(t, /^valid-/);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
});

test('F-7493be3c seam proof: the real invalid-*.json fixtures correctly fail validation (negative-fixture-correctly-failed = silent pass, per the schema-conformance handler\'s own D4-004 convention)', async (t) => {
  const { dir, configPath } = makeIsolatedRoot(t, /^invalid-/);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  // A negative fixture that correctly fails validation produces NO report —
  // see schemaConformanceHandler's "Negative-fixture-correctly-failed: silent
  // pass, no report" branch. Zero reports here is the SUCCESS case; a report
  // would mean NEGATIVE_FIXTURE_PASSED (the fixture no longer violates
  // anything), which the direct-Ajv test below independently guards against.
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
});

test('F-7493be3c seam proof: all 4 real fixtures together (2 valid + 2 invalid) are clean end to end — the exact coexistence shape the agent-output-schema check already proves for its own fixture set', async (t) => {
  const { dir, configPath } = makeIsolatedRoot(t, /\.json$/);
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
});

test('F-7493be3c: direct-Ajv proof (via the same $id + $ref sub-schema mechanism schemaPointer uses) that each invalid-*.json fixture violates the SPECIFIC constraint its name claims, not just some incidental malformation', async () => {
  const Ajv2020Mod = await import('ajv/dist/2020.js');
  const Ajv2020 = Ajv2020Mod.default ?? Ajv2020Mod;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(STAND_IN_SCHEMA);
  const validate = ajv.compile({ $ref: `${STAND_IN_SCHEMA.$id}${SCHEMA_POINTER}` });

  const missingRunId = JSON.parse(readFileSync(join(realFixturesDir, 'invalid-missing-run-id.json'), 'utf8'));
  assert.equal(validate(missingRunId), false);
  assert.ok(validate.errors.some((e) => e.message === "must have required property 'run_id'"),
    `expected a missing-run_id error, got: ${JSON.stringify(validate.errors)}`);

  const extraProperty = JSON.parse(readFileSync(join(realFixturesDir, 'invalid-extra-property.json'), 'utf8'));
  assert.equal(validate(extraProperty), false);
  assert.ok(validate.errors.some((e) => e.keyword === 'additionalProperties'),
    `expected an additionalProperties error, got: ${JSON.stringify(validate.errors)}`);

  // Sanity check on the sanity check: fixing the ONE violation each fixture
  // claims to test makes it pass — proving the schema's requirement (not an
  // unrelated typo) is what rejected the original fixture.
  assert.equal(validate({ ...missingRunId, run_id: 'swarm-1784091637-5127' }), true);
  const { unexpected_field, ...withoutExtra } = extraProperty;
  assert.equal(validate(withoutExtra), true);
});

test('F-7493be3c: a negative fixture that stops violating anything is caught as NEGATIVE_FIXTURE_PASSED, not silently accepted', async (t) => {
  const { dir, configPath } = makeIsolatedRoot(t, /^invalid-missing-run-id/);
  // Repair the fixture's one violation in place, keeping its invalid-*
  // filename — this is exactly the "schema loosened or fixture went stale"
  // scenario the handler's negative-fixture convention exists to catch.
  const fixturePath = join(dir, 'scripts/__roadmap-fixtures__/invalid-missing-run-id.json');
  const repaired = { ...JSON.parse(readFileSync(fixturePath, 'utf8')), run_id: 'swarm-1784091637-5127' };
  writeFileSync(fixturePath, JSON.stringify(repaired, null, 2));

  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.match(result.reports[0].message, /NEGATIVE fixture passed validation but must fail/);
});

test('F-7493be3c: the real doc-drift-patterns.json wires roadmap-artifact-schema with the shape the finding specifies (permanent — independent of the schemas-domain merge)', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8'));
  const entry = config.checks.find((c) => c.id === 'roadmap-artifact-schema');
  assert.ok(entry, 'expected a roadmap-artifact-schema check entry in scripts/doc-drift-patterns.json');
  assert.equal(entry.kind, 'schema-conformance');
  assert.equal(entry.schema, 'packages/schemas/src/json/dogfood-roadmap.schema.json');
  assert.equal(entry.schemaPointer, SCHEMA_POINTER, 'latest.json is the small pointer shape, not the full roadmap document — must validate against the $defs fragment, not the schema top level');
  assert.deepEqual(entry.targets, ['scripts/__roadmap-fixtures__/*.json', 'dogfood/roadmap/latest.json']);
  assert.deepEqual(entry.allowEmptyGlobs, ['dogfood/roadmap/latest.json'],
    'dogfood/roadmap/latest.json must be allowed to be absent (graceful pre-first-compile / pre-merge state), never a vacuous pass');
  assert.equal(entry.negativeFilenamePattern, '^invalid-');
  // F-7493be3c explicitly rules out globbing the per-run history archive —
  // only latest.json, never dogfood/roadmap/**/*.json or a run-id glob.
  for (const t of entry.targets) {
    assert.doesNotMatch(t, /roadmap\/\*\*/, 'must never glob the per-run roadmap history — see the companion growth-guard finding');
  }
});

test('F-7493be3c: the committed fixtures directory has both a valid and an invalid convention-named fixture', () => {
  const names = readdirSync(realFixturesDir);
  assert.ok(names.some((n) => n.startsWith('valid-')), 'expected at least one valid-*.json fixture');
  assert.ok(names.some((n) => n.startsWith('invalid-')), 'expected at least one invalid-*.json fixture (negativeFilenamePattern default is ^invalid-)');
});

test('F-7493be3c: every committed fixture is pointer-shaped ({ run_id, sequence, path }), never the full roadmap document shape', () => {
  const names = readdirSync(realFixturesDir);
  for (const name of names) {
    const parsed = JSON.parse(readFileSync(join(realFixturesDir, name), 'utf8'));
    assert.ok(!('operator_notes' in parsed) && !('compiled_at' in parsed),
      `${name} looks like the FULL roadmap document, not the latestPointer shape — dogfood/roadmap/latest.json only ever holds { run_id, sequence, path }`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F-f52fc700 (wave 41 amend, HIGH): roadmap-artifact-full-document-schema —
// the FULL document's other half. roadmap-artifact-schema above only ever
// validates the small latestPointer; nothing validated the full compiled
// document (dogfood/roadmap/<run-id>.json / <run-id>.<seq>.json) against the
// schema's TOP LEVEL until this check. Same seam shape as F-7493be3c above,
// ONE LEVEL WORSE: F-7493be3c's schema dependency simply hadn't merged yet at
// authoring time (a timing gap); this check's dependency is genuinely
// UNRESOLVED even once merged — the schema and the compiler's real output are
// PROVEN to disagree on 16 points (see scripts/doc-drift-patterns.json's
// roadmap-artifact-full-document-schema description for the live Ajv proof),
// and which side moves is a cross-domain decision still in flight this same
// wave (backend may amend the schema; core/verbs may conform the emitters).
//
// RESCOPED 2026-07-17 (post-wave-41 merge; tracked to WAVE 42): the paragraph
// that used to sit here said this file could not assert the live check clean
// "until that reconciliation lands AND the affected run is recompiled" — and
// predicted the coordinator's end-of-wave recompile would be what turned it
// green. That prediction did not survive contact with the merge: the emitter
// reconciliation was PARTIAL (four axes landed — compiled_at rename, sections
// dropped, notesPath relativized, content_hash — but the schema's full
// vocabulary was adopted by neither compiler, and the residual gap is
// SEMANTIC: $defs/drainEntry cadence-in-RUNS vs both implementations'
// cadence-in-DATES). That decision is a wave-42 cross-domain finding, so the
// check was rescoped for the transitional state: `targets` narrowed to the
// fixtures glob (still fully enforcing — the non-vacuous half), and the live
// dogfood/roadmap/swarm-*.json glob moved to `suspendedTargets`, which skips
// validation but emits a non-blocking WARN on every run until wave 42
// deletes it. This file NOW pins that rescoped design: the live check IS
// clean (warn-only) against the real tree, the suspension is loud, and the
// fixtures half still fails red when a fixture stops conforming.
// ─────────────────────────────────────────────────────────────────────────────

const documentFixturesDir = join(repoRoot, 'scripts/__roadmap-document-fixtures__');
const realSchemaRel = 'packages/schemas/src/json/dogfood-roadmap.schema.json';

/**
 * Unlike makeIsolatedRoot() above (F-7493be3c), this does not need a
 * stand-in schema — packages/schemas/src/json/dogfood-roadmap.schema.json
 * already exists, complete, in this worktree. What needs isolating is the
 * TARGET GLOB: the real check also targets the live dogfood/roadmap/*.json
 * artifacts, which are proven-live nonconformant pending a cross-domain fix
 * this file does not own. This helper builds a config that reuses the REAL
 * schema file (by resolving repoRoot to the real repo) but restricts targets
 * to ONLY the committed fixtures directory, so the fixture-soundness proof
 * below is decoupled from the live artifacts' current, expected-to-change
 * conformance state.
 */
function makeFixturesOnlyConfig(t, namePattern) {
  const names = readdirSync(documentFixturesDir).filter((n) => namePattern.test(n));
  assert.ok(names.length > 0, `expected at least one document fixture matching ${namePattern} in ${documentFixturesDir}`);

  const dir = mkdtempSync(join(tmpdir(), 'roadmap-document-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configObj = {
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'fixtures-only isolation of the real check (F-f52fc700)',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      allowlist: [],
      negativeFilenamePattern: '^invalid-',
    }],
  };
  // namePattern narrows via a temp copy so valid-only / invalid-only runs
  // don't have to reason about the OTHER bucket's expected outcome.
  const scopedDir = mkdtempSync(join(tmpdir(), 'roadmap-document-schema-scope-'));
  t.after(() => rmSync(scopedDir, { recursive: true, force: true }));
  mkdirSync(join(scopedDir, 'scripts/__roadmap-document-fixtures__'), { recursive: true });
  mkdirSync(dirname(join(scopedDir, realSchemaRel)), { recursive: true });
  writeFileSync(join(scopedDir, realSchemaRel), readFileSync(join(repoRoot, realSchemaRel)));
  for (const name of names) {
    writeFileSync(
      join(scopedDir, 'scripts/__roadmap-document-fixtures__', name),
      readFileSync(join(documentFixturesDir, name)),
    );
  }
  const configPath = join(dir, 'doc-drift-config.json');
  writeFileSync(configPath, JSON.stringify(configObj, null, 2));
  return { repoRoot: scopedDir, configPath };
}

/** @pins F-f52fc700 */
test('F-f52fc700 seam proof: the committed valid-*.json document fixtures validate against the real, current dogfood-roadmap.schema.json top level', async (t) => {
  const { repoRoot: scopedRoot, configPath } = makeFixturesOnlyConfig(t, /^valid-/);
  const result = await runDriftChecks({ repoRoot: scopedRoot, configPath });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
});

test('F-f52fc700 seam proof: the committed invalid-*.json document fixtures correctly fail validation', async (t) => {
  const { repoRoot: scopedRoot, configPath } = makeFixturesOnlyConfig(t, /^invalid-/);
  const result = await runDriftChecks({ repoRoot: scopedRoot, configPath });
  // Negative-fixture-correctly-failed is a silent pass (no report) — see
  // schemaConformanceHandler. A report here would mean NEGATIVE_FIXTURE_PASSED.
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
});

test('F-f52fc700: direct-Ajv proof that each invalid document fixture violates the SPECIFIC constraint its name claims', async () => {
  const Ajv2020Mod = await import('ajv/dist/2020.js');
  const Ajv2020 = Ajv2020Mod.default ?? Ajv2020Mod;
  const addFormatsMod = await import('ajv-formats');
  const addFormats = addFormatsMod.default ?? addFormatsMod;
  const schema = JSON.parse(readFileSync(join(repoRoot, realSchemaRel), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const missingRequired = JSON.parse(readFileSync(join(documentFixturesDir, 'invalid-missing-required-field.json'), 'utf8'));
  assert.equal(validate(missingRequired), false);
  assert.ok(validate.errors.some((e) => e.keyword === 'required' && e.params.missingProperty === 'drain_queue'),
    `expected a missing drain_queue error, got: ${JSON.stringify(validate.errors)}`);
  assert.equal(validate({ ...missingRequired, drain_queue: [] }), true,
    'fixing the ONE claimed violation must make it pass — proves the schema requirement, not an unrelated typo, rejected it');

  // RESCOPE 2026-07-17 (wave-41 seam repair, tracked with the wave-42 items):
  // this fixture originally used `notesPath` as its unknown extra property.
  // The backend lane's same-wave schema amendment (F-c7b0f47b) LEGALIZED
  // notesPath as an optional, repo-relative-only top-level property, so the
  // old fixture stopped violating additionalProperties and started violating
  // the new pattern instead — failing for a different reason than its name
  // claims, which is exactly what this test exists to catch. The extra
  // property is now `sections`, the CLI-envelope key the amended schema
  // deliberately dropped (and therefore the most valuable additionalProperties
  // pin available: it asserts the old envelope vocabulary stays unrecognized).
  // The absolute-notesPath shape moved to its own correctly-named fixture,
  // asserted below.
  const extraProperty = JSON.parse(readFileSync(join(documentFixturesDir, 'invalid-extra-top-level-property.json'), 'utf8'));
  assert.equal(validate(extraProperty), false);
  assert.ok(validate.errors.some((e) => e.keyword === 'additionalProperties' && e.params.additionalProperty === 'sections'),
    `expected an additionalProperties(sections) error, got: ${JSON.stringify(validate.errors)}`);
  const { sections, ...withoutExtra } = extraProperty;
  assert.equal(validate(withoutExtra), true);

  // RESCOPE 2026-07-17: the schema-side half of the F-cec640b1 absolute-path
  // story — notesPath is legal ONLY when repo-relative; a drive-letter value
  // must fail on the pattern, and relativizing that ONE value must make the
  // whole document pass.
  const absoluteNotesPath = JSON.parse(readFileSync(join(documentFixturesDir, 'invalid-absolute-notes-path.json'), 'utf8'));
  assert.equal(validate(absoluteNotesPath), false);
  assert.ok(validate.errors.some((e) => e.keyword === 'pattern' && e.instancePath === '/notesPath'),
    `expected a pattern violation at /notesPath, got: ${JSON.stringify(validate.errors)}`);
  assert.equal(validate({ ...absoluteNotesPath, notesPath: 'dogfood/roadmap-notes.json' }), true,
    'relativizing the one offending value must make the document pass — proves the pattern, not an unrelated defect, rejected it');

  const missingEnforcedBy = JSON.parse(readFileSync(join(documentFixturesDir, 'invalid-invariant-note-missing-enforced-by.json'), 'utf8'));
  assert.equal(validate(missingEnforcedBy), false);
  assert.ok(validate.errors.some((e) => e.schemaPath.includes('allOf/0/then') && e.params.missingProperty === 'enforced_by'),
    `expected the invariant-requires-enforced_by conditional to fire, got: ${JSON.stringify(validate.errors)}`);
  const repaired = {
    ...missingEnforcedBy,
    operator_notes: missingEnforcedBy.operator_notes.map((n) => ({ ...n, enforced_by: 'scripts/check-finding-regression-pins.mjs' })),
  };
  assert.equal(validate(repaired), true);
});

test('F-f52fc700: the real doc-drift-patterns.json wires roadmap-artifact-full-document-schema with the RESCOPED shape (2026-07-17 transitional design — fixtures enforcing, live artifacts suspended-with-WARN until wave 42)', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8'));
  const entry = config.checks.find((c) => c.id === 'roadmap-artifact-full-document-schema');
  assert.ok(entry, 'expected a roadmap-artifact-full-document-schema check entry in scripts/doc-drift-patterns.json');
  assert.equal(entry.kind, 'schema-conformance');
  assert.equal(entry.schema, realSchemaRel);
  assert.equal(entry.schemaPointer, undefined,
    'this check validates the FULL document against the schema TOP LEVEL — unlike roadmap-artifact-schema, it must not set schemaPointer');
  // RESCOPE 2026-07-17 (wave 42 revisit): this assertion used to require
  // entry.targets to INCLUDE 'dogfood/roadmap/*.json'. The wave-41 emitter
  // reconciliation landed only four of the schema's axes, the residual
  // drainEntry runs-vs-dates gap is a wave-42 cross-domain decision, and no
  // live artifact can pass the current schema until it resolves — so the
  // live glob is now REQUIRED to be absent from targets and present in
  // suspendedTargets instead. When wave 42 lands, flip these assertions back.
  assert.ok(!entry.targets.some((t) => t.startsWith('dogfood/roadmap/')),
    'during the wave-42 suspension, no live dogfood/roadmap glob may sit in targets — it belongs in suspendedTargets so the skip stays loud');
  assert.ok(entry.targets.some((t) => t.includes('__roadmap-document-fixtures__')),
    'must target committed fixtures, so the gate has a guaranteed-non-vacuous, still-enforcing target throughout the suspension');
  assert.ok(Array.isArray(entry.suspendedTargets) && entry.suspendedTargets.length === 1,
    'exactly one transitional suspension — the live per-run artifacts');
  const susp = entry.suspendedTargets[0];
  assert.equal(susp.glob, 'dogfood/roadmap/swarm-*.json',
    'the suspension covers the per-run artifacts only — latest.json is matched by neither this glob nor the fixtures glob, so it needs no allowlist mechanism');
  assert.equal(susp.until, 'wave 42', 'the suspension names its end state — this is the tracked-to-wave-42 marker');
  assert.match(susp.reason, /2026-07-17/, 'the suspension is dated');
  assert.match(susp.reason, /wave 42/i, 'the suspension names the owning wave in its reason');
  assert.match(susp.reason, /runs?.*dates?|dates?.*runs?/i,
    'the reason records the SEMANTIC residual (drainEntry cadence-in-RUNS vs implementations\' cadence-in-DATES), not just a vague "not reconciled yet"');
  // RESCOPE 2026-07-17 (wave 42 revisit): allowlist used to carry
  // latest.json; with the live glob out of targets there is nothing for an
  // allowlist to exclude, and dead config would misdescribe the mechanism.
  assert.deepEqual(entry.allowlist, [],
    'no allowlist entries during the suspension — latest.json exclusion is structural now (see the suspension-glob assertion above)');
  assert.equal(entry.negativeFilenamePattern, '^invalid-');
  assert.notEqual(entry.allowEmpty, true, 'a zero-match glob here must fail loud, not silently pass');
});

test('F-f52fc700: the document-fixtures directory has both valid- and invalid-*.json convention-named fixtures, and none are pointer-shaped', () => {
  const names = readdirSync(documentFixturesDir);
  assert.ok(names.some((n) => n.startsWith('valid-')), 'expected at least one valid-*.json fixture');
  assert.ok(names.filter((n) => n.startsWith('invalid-')).length >= 3,
    'expected at least 3 invalid-*.json fixtures — one per distinct constraint class exercised above (missing required, additionalProperties, the invariant/enforced_by conditional)');
  for (const name of names) {
    const parsed = JSON.parse(readFileSync(join(documentFixturesDir, name), 'utf8'));
    assert.ok('operator_notes' in parsed || name.startsWith('invalid-missing-required'),
      `${name} should look like the FULL roadmap document shape (operator_notes present), not the latestPointer shape — these fixtures target the OTHER check`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-17 rescope pins (WAVE 42 revisit): the transitional suspension
// itself. Three properties, each independently red-able: (1) the live check
// runs clean-with-WARN against the real tree; (2) a suspension genuinely
// suspends (a nonconformant file under a suspended glob does not drift —
// proven against the same file drifting once the suspension is removed);
// (3) a malformed suspension entry fails loud as config-error rather than
// silently widening or narrowing the gate. When wave 42 deletes the
// suspendedTargets entry, test (1) must be updated in the same commit — that
// is deliberate: this pin is the forcing function that keeps the check's
// config and its documented scope moving together.
// ─────────────────────────────────────────────────────────────────────────────

/** @pins F-f52fc700 */
test('rescope 2026-07-17: the LIVE full-document check is clean against the real tree, with exactly one loud wave-42 suspension WARN and zero drift/config-error', async () => {
  const result = await runDriftChecks({ repoRoot, checkId: 'roadmap-artifact-full-document-schema' });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  const warns = result.reports.filter((r) => r.severity === 'warn');
  const blocking = result.reports.filter((r) => r.severity !== 'warn');
  assert.equal(blocking.length, 0,
    `the fixtures half must pass and nothing else may report: ${JSON.stringify(blocking, null, 2)}`);
  assert.equal(warns.length, 1, 'exactly one suspension entry, so exactly one WARN per run');
  assert.match(warns[0].message, /SUSPENDED until wave 42/,
    'the WARN names its end state — the tracked-to-wave-42 surfacing the rescope requires');
  assert.match(warns[0].message, /dogfood\/roadmap\/swarm-\*\.json/,
    'the WARN names the suspended glob so a CI reader can see exactly what is not being validated');
});

test('rescope 2026-07-17: suspendedTargets genuinely suspends — a nonconformant live-shaped artifact under the suspended glob does not drift, and the SAME file drifts once the suspension is removed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-suspension-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Real schema, one conforming fixture (keeps the targets glob non-vacuous),
  // and one deliberately nonconformant camelCase artifact — the exact live
  // shape the wave-41 partial reconciliation left behind.
  mkdirSync(dirname(join(dir, realSchemaRel)), { recursive: true });
  writeFileSync(join(dir, realSchemaRel), readFileSync(join(repoRoot, realSchemaRel)));
  mkdirSync(join(dir, 'scripts/__roadmap-document-fixtures__'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts/__roadmap-document-fixtures__/valid-minimal.json'),
    readFileSync(join(documentFixturesDir, 'valid-minimal.json')),
  );
  mkdirSync(join(dir, 'dogfood/roadmap'), { recursive: true });
  writeFileSync(join(dir, 'dogfood/roadmap/swarm-test-1.2.json'), JSON.stringify({
    runId: 'swarm-test-1', repo: 'o/r', compiled_at: '2026-07-15T09:00:38.000Z',
    notes: [], expired: [], attention: [], drain: {}, notesPath: 'dogfood/roadmap-notes.json',
  }, null, 2));

  const baseCheck = {
    id: 'roadmap-artifact-full-document-schema',
    kind: 'schema-conformance',
    title: 'suspension semantics probe',
    schema: realSchemaRel,
    targets: ['scripts/__roadmap-document-fixtures__/*.json'],
    negativeFilenamePattern: '^invalid-',
  };
  const writeConfig = (check) => {
    const p = join(dir, 'doc-drift-config.json');
    writeFileSync(p, JSON.stringify({ checks: [check] }, null, 2));
    return p;
  };

  // WITH the suspension: clean, one warn, the nonconformant file untouched.
  let result = await runDriftChecks({
    repoRoot: dir,
    configPath: writeConfig({
      ...baseCheck,
      suspendedTargets: [{ glob: 'dogfood/roadmap/swarm-*.json', reason: 'probe of the 2026-07-17 rescope semantics', until: 'wave 42' }],
    }),
  });
  assert.equal(result.clean, true, JSON.stringify(result.reports, null, 2));
  assert.equal(result.reports.filter((r) => r.severity === 'warn').length, 1);

  // WITHOUT the suspension, same tree, live glob back in targets: the same
  // file must drift — proof the suspension was doing real work, not that the
  // check was vacuous all along.
  result = await runDriftChecks({
    repoRoot: dir,
    configPath: writeConfig({
      ...baseCheck,
      targets: [...baseCheck.targets, 'dogfood/roadmap/swarm-*.json'],
    }),
  });
  assert.equal(result.clean, false, 'removing the suspension must expose the nonconformant artifact');
  assert.ok(result.reports.some((r) => r.severity === 'drift' && /swarm-test-1\.2\.json/.test(r.message)));
});

test('rescope 2026-07-17: a malformed suspendedTargets entry (missing until) is a config-error, never a silent scope change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-suspension-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dirname(join(dir, realSchemaRel)), { recursive: true });
  writeFileSync(join(dir, realSchemaRel), readFileSync(join(repoRoot, realSchemaRel)));
  mkdirSync(join(dir, 'scripts/__roadmap-document-fixtures__'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts/__roadmap-document-fixtures__/valid-minimal.json'),
    readFileSync(join(documentFixturesDir, 'valid-minimal.json')),
  );
  const configPath = join(dir, 'doc-drift-config.json');
  writeFileSync(configPath, JSON.stringify({
    checks: [{
      id: 'roadmap-artifact-full-document-schema',
      kind: 'schema-conformance',
      title: 'malformed suspension probe',
      schema: realSchemaRel,
      targets: ['scripts/__roadmap-document-fixtures__/*.json'],
      suspendedTargets: [{ glob: 'dogfood/roadmap/swarm-*.json', reason: 'no end state named' }],
    }],
  }, null, 2));
  const result = await runDriftChecks({ repoRoot: dir, configPath });
  assert.equal(result.clean, false);
  assert.ok(result.reports.some((r) => r.severity === 'config-error' && /malformed suspendedTargets entry/.test(r.message)),
    JSON.stringify(result.reports, null, 2));
});
