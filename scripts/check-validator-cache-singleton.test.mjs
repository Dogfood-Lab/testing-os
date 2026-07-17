/**
 * D2B-015 — Single canonical-validator cache invariant.
 *
 * H3 closes the C1 two-Ajv gap by migrating all four sibling schema
 * compile sites (synthesis/validate-artifacts.js, findings/validate.js,
 * verify/validators/schema.js, ingest/validate-record.js) to delegate
 * to `@dogfood-lab/schemas`'s `validatePayload` / `compileSchema`. The
 * canonical seam holds a module-scope `validatorCache` Map keyed by
 * SchemaName, so within a single Node process the SAME compiled
 * `ValidateFunction` is returned for the same schema name on every
 * call.
 *
 * But: npm workspace hoist resolution can split that cache. If
 * `@dogfood-lab/schemas` is symlinked into multiple packages'
 * `node_modules/` with different resolution paths, each package can
 * end up importing a SEPARATE module instance of `validate.js` — and
 * each instance carries its own `validatorCache` Map. The schema
 * names match, but the compiled validators are distinct references.
 * That is the C1 gap RELOCATED to the cache layer, not sealed: two
 * Ajv instances compiling the same schema, just hidden inside the
 * schemas package instead of inside the consumers.
 *
 * This test pins the structural invariant the migration claims:
 * single canonical compiled validator per schema per process,
 * shared across every consumer. The contract has two halves:
 *
 *   1. STATIC: no `new Ajv` outside `packages/schemas/`. This is the
 *      visible-source half — if any consumer regresses and adds its
 *      own Ajv instance back, this half trips immediately. (The
 *      agent-output schema validator in dogfood-swarm/lib/validate-
 *      agent-output.js compiles a local Ajv: the agent-output schema now
 *      ships via @dogfood-lab/schemas/json/ but is NOT one of the eight
 *      payload schemas wired through the canonical compileSchema/
 *      validatePayload seam — it is a swarm output envelope resolved as a
 *      raw JSON file. Allowlisted explicitly here; see that file's comment.)
 *
 *   2. DYNAMIC: import `compileSchema` from `@dogfood-lab/schemas`
 *      from this script's resolution path; trigger each consumer's
 *      validator (which internally calls `compileSchema` via
 *      `validatePayload`); then call `compileSchema` again from
 *      here. Assert the consumer-side trigger and the direct call
 *      return the SAME `ValidateFunction` reference. If the cache
 *      split, the two references differ and the test trips.
 *
 * Lifecycle: this is the test the audit (Stage A C1 finding) named
 * as the "structural seal" — without it, C1 isn't closed, only
 * relocated.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compileSchema,
  _resetValidatorCacheForTests,
  _schemasModuleInstanceCount,
} from '@dogfood-lab/schemas';

// Import every H3 consumer at TEST-FILE LOAD TIME. The single-instance
// assertion below depends on each consumer's `import` having already
// evaluated. If hoist split the package, the second module evaluation
// happens HERE (during the consumer's import resolution), and the
// counter at top-of-test reflects the post-split state.
import { validateRecord, RecordValidationError } from '@dogfood-lab/ingest/validate-record.js';
import { validateSubmissionSchema } from '@dogfood-lab/verify/validators/schema.js';
import { validateFinding } from '@dogfood-lab/findings/validate.js';
import {
  validatePattern,
  validateRecommendation,
  validateDoctrine,
} from '@dogfood-lab/findings/synthesis/validate-artifacts.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// ──────────────────────────────────────────────────────────────────────
// Part 1: STATIC invariant — no `new Ajv` outside packages/schemas/.
// ──────────────────────────────────────────────────────────────────────

test('D2B-015 STATIC: no `new Ajv` outside @dogfood-lab/schemas (single canonical compile site)', () => {
  // The agent-output schema validator (dogfood-swarm/lib/
  // validate-agent-output.js) compiles its own Ajv. The agent-output
  // schema now ships via @dogfood-lab/schemas/json/, but it is NOT one of
  // the eight payload schemas wired through the canonical compileSchema/
  // validatePayload seam — it is a swarm output envelope resolved as a raw
  // JSON file, so it is compiled with a local Ajv by design. Allowlisted by
  // path (see that file's header comment).
  //
  // The schemas package itself houses the SOLE permitted `new Ajv` call
  // (src/validate.ts + dist/validate.js). No other package may
  // instantiate one.
  const ALLOWLIST = new Set([
    'packages/dogfood-swarm/lib/validate-agent-output.js',
    // The case-file neutrality lint compiles the case-file envelope with a local
    // Ajv for the same reason agent-output does: the case-file is a swarm-internal
    // briefing envelope (docs/case-file-contract.md), NOT one of the eight
    // payload schemas wired through compileSchema/validatePayload. See that
    // file's header comment.
    'packages/dogfood-swarm/lib/case-file/schema.js',
    // The roadmap seed validator compiles dogfood-roadmap.schema.json — the
    // third swarm-internal envelope (CLAUDE.md names all three: agent-output,
    // case-file, dogfood-roadmap), resolved as a raw JSON file via the
    // ./json/* subpath, NOT wired through compileSchema/validatePayload.
    // Same class as the two entries above; added at the wave-43 merge when
    // `swarm init --seed-from-roadmap` (T4) shipped its fail-fast validation.
    'packages/dogfood-swarm/commands/lib/roadmap-seed.js',
  ]);
  const SCHEMA_PACKAGE_PREFIX = 'packages/schemas/';

  const violations = [];

  function walk(dirAbs, relPrefix) {
    const entries = readdirSync(dirAbs);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const abs = join(dirAbs, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.endsWith('.js') && !entry.endsWith('.ts')) continue;
      const text = readFileSync(abs, 'utf-8');
      // Bare-bones detection of an Ajv instantiation.
      if (!/\bnew\s+Ajv/.test(text)) continue;
      // packages/schemas/* is the canonical home — allowed.
      const relPosix = rel.replace(/\\/g, '/');
      if (relPosix.startsWith(SCHEMA_PACKAGE_PREFIX)) continue;
      if (ALLOWLIST.has(relPosix)) continue;
      violations.push(relPosix);
    }
  }

  walk(join(repoRoot, 'packages'), 'packages');

  assert.equal(
    violations.length,
    0,
    `D2B-015 STATIC invariant broken: ${violations.length} non-schema-package file(s) instantiate \`new Ajv\` directly:\n  ` +
    violations.join('\n  ') +
    `\n\nEvery consumer MUST go through @dogfood-lab/schemas's compileSchema/validatePayload. Adding a new Ajv instance in a sibling package re-opens the C1 two-Ajv gap that H3 closed. If a new schema legitimately requires a custom Ajv (formats, vocabulary), graduate it into @dogfood-lab/schemas first, OR add the file path to ALLOWLIST in this test with a comment naming the schema that doesn't fit the canonical seam.`,
  );
});

// ──────────────────────────────────────────────────────────────────────
// Part 2: DYNAMIC invariant — single module instance of
// `@dogfood-lab/schemas` across every consumer.
//
// Replaces an earlier "before === after compileSchema reference" check
// that was VACUOUS against the failure mode it claimed to guard. Trace:
//
//   1. _resetValidatorCacheForTests() clears M_test.cache (M_test = the
//      schemas instance THIS test imported).
//   2. before = compileSchema('record') → populates M_test.cache → V_test.
//   3. validateRecord(bad) runs ingest's code → calls compileSchema on
//      INGEST's schemas instance. If hoist split (M_ingest ≠ M_test),
//      this populates M_ingest.cache and leaves M_test.cache untouched.
//   4. after = compileSchema('record') → M_test.cache hit → returns
//      V_test (the same reference, because M_test was never touched).
//   5. assert.strictEqual(after, before) → V_test === V_test → always
//      true. The assertion holds whether or not the cache is split.
//
// That is exactly the L2-003 "gate that doesn't gate" pattern. It would
// have shipped a passing test that proves nothing about the C1 seal.
//
// The replacement uses a process-global module-instance counter (via
// `Symbol.for('@dogfood-lab/schemas.instances')` — the Symbol registry
// is shared across module instances, so a counter rooted there is
// visible from every load of `validate.ts`). Each time the module
// evaluates, it increments the counter. A workspace-hoist split that
// loads the module twice → counter goes from 1 to 2. The test asserts
// exactly 1, AFTER every consumer has been imported.
//
// Crucially: the assertion is read from globalThis, NOT from any
// specific module instance's local state. A split module's increment
// IS visible to this test, because both modules write to the same
// global Symbol slot.
//
// The non-vacuity proof (Part 4 below) demonstrates the detector trips
// on a forced second load — confirming GREEN here genuinely means
// one instance, not "test couldn't see the failure."
// ──────────────────────────────────────────────────────────────────────

test('D2B-015 DYNAMIC: exactly one @dogfood-lab/schemas module instance per process (real C1 seal)', () => {
  // Touch every consumer once so any lazy-loaded code path is forced
  // to evaluate. The imports at the top of this file should already
  // have loaded everything, but a defensive call ensures nothing is
  // skipped under tree-shaking or lazy-eval future changes.
  _resetValidatorCacheForTests();
  try { validateRecord({ schema_version: '1.0.0' }); } catch (e) {
    assert.ok(e instanceof RecordValidationError);
  }
  validateSubmissionSchema({ schema_version: '1.0.0' });
  validateFinding({ schema_version: '1.0.0' });
  validatePattern({ schema_version: '1.0.0' });
  validateRecommendation({ schema_version: '1.0.0' });
  validateDoctrine({ schema_version: '1.0.0' });

  const count = _schemasModuleInstanceCount();

  assert.equal(
    count,
    1,
    `D2B-015 BROKEN: @dogfood-lab/schemas evaluated ${count} times in this process — workspace-hoist split detected. ` +
    `Every duplicate evaluation owns its own validatorCache; consumers loading the split second instance compile a SEPARATE Ajv validator for the same schema. ` +
    `That is the C1 two-Ajv gap RELOCATED to the cache layer instead of sealed. ` +
    `Investigate the install: \`npm ls @dogfood-lab/schemas\` from the repo root should show exactly one symlinked path; any consumer with its own nested install is the suspect. ` +
    `Fix the install (deduplicate via workspace hoist OR explicit dep removal), do not silence this gate — its whole purpose is to detect what the previous before/after-strictEqual check could not.`,
  );
});

// ──────────────────────────────────────────────────────────────────────
// Part 3: per-consumer keyword preservation — the H3 contract that lets
// RecordValidationError keep its `keyword` field.
// ──────────────────────────────────────────────────────────────────────

test('D2B-015 KEYWORD: ingest.validateRecord preserves Ajv `keyword` on every error (the ingest pin)', () => {
  // Pin: packages/ingest/ingest.test.js:208-220 walks every error and
  // asserts `typeof e.keyword === 'string'`. The H3 ValidationError
  // keyword extension (validate.ts ValidationError type) is what makes
  // this preservable across the migration. If a future change strips
  // keyword from the canonical seam, this test trips before ingest's
  // does.
  try {
    validateRecord({ schema_version: '1.0.0' });
    assert.fail('expected RecordValidationError to throw on missing required fields');
  } catch (e) {
    assert.ok(e instanceof RecordValidationError);
    assert.ok(Array.isArray(e.errors));
    assert.ok(e.errors.length > 0, 'expected at least one validation error');
    for (const err of e.errors) {
      assert.equal(typeof err.keyword, 'string', `error missing keyword: ${JSON.stringify(err)}`);
      assert.ok(err.keyword.length > 0, `error has empty keyword: ${JSON.stringify(err)}`);
    }
  }
});

test('D2B-015 KEYWORD: findings.validateFinding forwards `keyword` on every error', () => {
  // Same forwarding pin one level up — findings has no in-package
  // keyword consumer today, but the migration committed to forwarding
  // keyword (not stripping it) so downstream review-time consumers can
  // lean on the same field ingest does. Pin the forwarding here.
  const result = validateFinding({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  for (const err of result.errors) {
    assert.equal(typeof err.keyword, 'string', `finding error missing keyword: ${JSON.stringify(err)}`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Part 4: NON-VACUITY PROOF — the detector trips on a forced split.
//
// A gate is only as strong as evidence that it can fail. The DYNAMIC
// test above asserts `count === 1`. If, for some reason, the counter
// could never go above 1, the green is meaningless — same vacuous-gate
// shape as the pre-fix-up version, just with different mechanism.
//
// This test forces a second evaluation of `@dogfood-lab/schemas`'s
// `validate.js` and asserts the counter actually ticks. Node ESM
// dedupes by resolved URL string: two `import()` calls with byte-
// identical URLs share one instance, but appending a query string
// makes the URL distinct and forces a second evaluation.
//
// We use `import()` with a `file://` URL + `?_force_second_instance=…`
// query. This is the canonical Node trick to bust the ESM module
// graph cache without modifying node_modules.
//
// If the second load increments the counter, the detector is real.
// If it doesn't, the detector is vacuous — the test fails LOUDLY
// rather than silently passing.
// ──────────────────────────────────────────────────────────────────────

test('D2B-015 DETECTOR PROOF: forcing a second module load increments the counter (non-vacuity)', async () => {
  const before = _schemasModuleInstanceCount();
  assert.ok(before >= 1, `precondition: counter is at least 1 (current: ${before})`);

  // Resolve the absolute path to the schemas package's compiled
  // validate.js. The package's `exports` map only exposes `.` (with
  // an `import` condition for ESM only — no `require` condition), so
  // `require.resolve('@dogfood-lab/schemas')` and `import.meta.resolve`
  // both REFUSE to return a path for `./dist/validate.js` directly.
  // Resolve the package root by walking from this test file's location
  // (workspace layout: `node_modules/@dogfood-lab/schemas/dist/validate.js`)
  // — every install variant (npm workspaces, npm ci with hoist) lands
  // the directory in the same place, so the path is stable.
  //
  // Then `import()` it via a file:// URL with a cachebust query so
  // Node's ESM loader treats it as a fresh URL and re-evaluates. The
  // cachebust string includes the current count so the URL is unique
  // even if some future test runs this assertion twice in one process.
  const validatePath = resolve(
    repoRoot,
    'node_modules/@dogfood-lab/schemas/dist/validate.js',
  );
  const cacheBustUrl = pathToFileURL(validatePath).href + '?_force_second_instance=' + before;

  const second = await import(cacheBustUrl);
  // Sanity: the second instance must expose the same API surface — if
  // the cachebust import returned a placeholder or empty module, the
  // counter wouldn't have ticked AND no useful function would be there.
  assert.equal(typeof second._schemasModuleInstanceCount, 'function',
    'second-instance import did not expose _schemasModuleInstanceCount — the detector cannot test what it cannot see');

  const after = _schemasModuleInstanceCount();
  assert.equal(
    after,
    before + 1,
    `Detector vacuity: forcing a second @dogfood-lab/schemas/dist/validate.js load did NOT increment the global counter (before=${before}, after=${after}). ` +
    `The DYNAMIC test's "count === 1" assertion would pass even in a real hoist-split scenario — same vacuous-gate failure mode the L2-003 lesson exists to prevent. ` +
    `Investigate: is the Symbol.for slot writable from this module instance? Did the cachebust URL actually trigger re-evaluation? Is the second instance's validate.js running its top-level statements?`,
  );

  // Also confirm both instances agree on the global count (they read
  // the same Symbol.for slot, so they MUST agree — if they disagree,
  // the Symbol registry itself is split, which is even more broken).
  const secondReportsAfter = second._schemasModuleInstanceCount();
  assert.equal(
    secondReportsAfter,
    after,
    `Symbol.for slot disagreement: this module reads ${after} but the second instance reads ${secondReportsAfter}. ` +
    `The cross-module Symbol registry should be process-global; a disagreement means a deeper isolation problem (vm context, worker thread, etc.) that this detector cannot model.`,
  );
});
