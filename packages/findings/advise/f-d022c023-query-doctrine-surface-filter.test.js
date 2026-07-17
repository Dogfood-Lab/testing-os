/**
 * f-d022c023-query-doctrine-surface-filter.test.js
 *
 * F-d022c023 (Stage C humanization) — queryDoctrine's surface-scoping filter
 * was a structural no-op: `d.transfer_scope === 'org_wide' ||
 * d.transfer_scope === 'execution_mode' || true` — the trailing bare `true`
 * made the whole expression unconditionally true for every doctrine record,
 * regardless of transfer_scope. Since transfer_scope is a closed 3-value
 * enum (packages/schemas/src/json/dogfood-doctrine.schema.json) and the code
 * already special-cased the other two values, this covered 100% of possible
 * values — not a rare edge case. The live, documented, user-facing CLI verb
 * `dogfood findings advise --surface <surface>` prints a "Relevant doctrine"
 * section built from exactly this path, so two DIFFERENT --surface values
 * printed the IDENTICAL doctrine list.
 *
 * Fix: surface_archetype doctrine now checks whether the requested surface
 * appears in the dimensions.product_surfaces of at least one pattern it is
 * based_on_pattern_ids-derived from — the only real per-record surface
 * signal this schema offers (doctrine itself carries no surface field).
 *
 * This suite adds the exact assertion the finding's own text says was
 * missing from the pre-existing test suite (packages/findings/advise/
 * advise.test.js's "Query: doctrine (F-742442-047)" block only ever calls
 * `queryDoctrine(TEST_ROOT, {})` with an EMPTY scope — it never sets
 * `scope.surface` at all, so it never exercised this filter branch, and its
 * one doctrine fixture is `transfer_scope: 'org_wide'`, which passes
 * unconditionally under both the old and new code): "two DIFFERENT surface
 * values on a mixed transfer_scope fixture produce DIFFERENT result sets."
 *
 * RED proof (reasoned + independently re-derived, not carried over from the
 * finding's own prose): with the bare `true` in place, EVERY assertion below
 * that expects two different surfaces to produce different result sets
 * would fail — `queryDoctrine(root, {surface:'cli'})` and
 * `queryDoctrine(root, {surface:'mcp-server'})` would return the IDENTICAL
 * three records both times (verified by reading the pre-fix filter
 * predicate directly: the `|| true` makes the callback return `true` for
 * every element regardless of the two literal branches before it).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { queryDoctrine } from './query.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_f_d022c023__');

function writeArtifact(rootDir, subdir, filename, data) {
  const dir = resolve(rootDir, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, filename), yaml.dump(data, { lineWidth: 120 }), 'utf-8');
}

function setupMixedScopeFixture() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });

  // ── Patterns: one CLI-surfaced, one mcp-server-surfaced ──
  writeArtifact(TEST_ROOT, 'patterns', 'dpat-cli-entrypoint.yaml', {
    schema_version: '1.0.0', pattern_id: 'dpat-cli-entrypoint',
    title: 'Entrypoint/build truth issues recur on CLI repos',
    status: 'accepted', pattern_kind: 'recurring_failure',
    summary: 'CLI repos frequently have scenario/entrypoint mismatch issues.',
    source_finding_ids: ['dfind-cli-1'],
    support: { finding_count: 2, repo_count: 2, surface_count: 1, execution_modes: ['bot'] },
    dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'], root_cause_kinds: ['docs_code_drift'] },
    transfer_scope: 'surface_archetype', pattern_strength: 'strong'
  });

  writeArtifact(TEST_ROOT, 'patterns', 'dpat-mcp-interface-truth.yaml', {
    schema_version: '1.0.0', pattern_id: 'dpat-mcp-interface-truth',
    title: 'Interface assumption recurs across repos on mcp-server',
    status: 'accepted', pattern_kind: 'recurring_failure',
    summary: 'Multiple MCP repos misclassified their runtime interface.',
    source_finding_ids: ['dfind-mcp-1'],
    support: { finding_count: 2, repo_count: 2, surface_count: 1, execution_modes: ['bot'] },
    dimensions: { product_surfaces: ['mcp-server'], issue_kinds: ['interface_assumption'], root_cause_kinds: ['surface_misclassification'] },
    transfer_scope: 'surface_archetype', pattern_strength: 'strong'
  });

  // ── Doctrine: org_wide, execution_mode, and TWO surface_archetype
  //    doctrines each backed by a DIFFERENT single-surface pattern ──
  writeArtifact(TEST_ROOT, 'doctrine', 'ddoc-org-wide.yaml', {
    schema_version: '1.0.0', doctrine_id: 'ddoc-org-wide',
    title: 'A doctrine that genuinely applies everywhere, any surface',
    status: 'accepted', doctrine_kind: 'rollout_law',
    statement: 'This doctrine applies org-wide regardless of surface. It exists to prove org_wide is unaffected by this fix.',
    rationale: 'Backed by cross-cutting evidence spanning every surface in the portfolio.',
    based_on_pattern_ids: ['dpat-cli-entrypoint'],
    transfer_scope: 'org_wide', strength: 'foundational'
  });

  writeArtifact(TEST_ROOT, 'doctrine', 'ddoc-execution-mode.yaml', {
    schema_version: '1.0.0', doctrine_id: 'ddoc-execution-mode',
    title: 'A doctrine scoped to an execution mode, not a surface',
    status: 'accepted', doctrine_kind: 'verification_law',
    statement: 'This doctrine applies to every bot-executed surface. It exists to prove execution_mode is unaffected by this fix.',
    rationale: 'Backed by evidence spanning multiple surfaces under the same execution mode.',
    based_on_pattern_ids: ['dpat-mcp-interface-truth'],
    transfer_scope: 'execution_mode', strength: 'proven'
  });

  writeArtifact(TEST_ROOT, 'doctrine', 'ddoc-archetype-cli.yaml', {
    schema_version: '1.0.0', doctrine_id: 'ddoc-archetype-cli',
    title: 'A surface_archetype doctrine backed ONLY by a CLI-surfaced pattern',
    status: 'accepted', doctrine_kind: 'surface_law',
    statement: 'Verify CLI entrypoints before authoring rollout scenarios for CLI repos.',
    rationale: 'Backed by the CLI entrypoint pattern, which is scoped to the cli surface only.',
    based_on_pattern_ids: ['dpat-cli-entrypoint'],
    transfer_scope: 'surface_archetype', strength: 'proven'
  });

  writeArtifact(TEST_ROOT, 'doctrine', 'ddoc-archetype-mcp.yaml', {
    schema_version: '1.0.0', doctrine_id: 'ddoc-archetype-mcp',
    title: 'A surface_archetype doctrine backed ONLY by an mcp-server-surfaced pattern',
    status: 'accepted', doctrine_kind: 'surface_law',
    statement: 'Verify MCP server runtime interface before authoring rollout scenarios.',
    rationale: 'Backed by the MCP interface pattern, which is scoped to the mcp-server surface only.',
    based_on_pattern_ids: ['dpat-mcp-interface-truth'],
    transfer_scope: 'surface_archetype', strength: 'proven'
  });

  writeArtifact(TEST_ROOT, 'doctrine', 'ddoc-dangling-pattern-ref.yaml', {
    schema_version: '1.0.0', doctrine_id: 'ddoc-dangling-pattern-ref',
    title: 'A surface_archetype doctrine whose pattern reference no longer resolves',
    status: 'accepted', doctrine_kind: 'surface_law',
    statement: 'This exercises the case where based_on_pattern_ids names a pattern id that is not (or no longer) loadable.',
    rationale: 'A pattern can be pruned/archived after a doctrine cites it; this must not crash the query.',
    based_on_pattern_ids: ['dpat-does-not-exist'],
    transfer_scope: 'surface_archetype', strength: 'emerging'
  });
}

/** @pins F-d022c023 */
describe('F-d022c023: queryDoctrine surface filter actually discriminates by surface', () => {
  before(() => setupMixedScopeFixture());
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('no surface filter (empty scope): returns all 5 accepted doctrine, unaffected by this fix', () => {
    const results = queryDoctrine(TEST_ROOT, {});
    assert.equal(results.length, 5);
  });

  it('surface="cli": includes org_wide + execution_mode + the CLI-backed archetype, excludes the mcp-server-backed archetype and the dangling ref', () => {
    const ids = queryDoctrine(TEST_ROOT, { surface: 'cli' }).map(d => d.doctrine_id).sort();
    assert.deepEqual(ids, ['ddoc-archetype-cli', 'ddoc-execution-mode', 'ddoc-org-wide']);
  });

  it('surface="mcp-server": includes org_wide + execution_mode + the mcp-server-backed archetype, excludes the CLI-backed archetype and the dangling ref', () => {
    const ids = queryDoctrine(TEST_ROOT, { surface: 'mcp-server' }).map(d => d.doctrine_id).sort();
    assert.deepEqual(ids, ['ddoc-archetype-mcp', 'ddoc-execution-mode', 'ddoc-org-wide']);
  });

  // THE finding's own required assertion, verbatim: two different surface
  // values on a mixed transfer_scope fixture must produce DIFFERENT result
  // sets. Pre-fix (bare `true`) these two arrays were IDENTICAL.
  it('two different surface values produce DIFFERENT result sets (the exact regression the bare `true` masked)', () => {
    const cliIds = queryDoctrine(TEST_ROOT, { surface: 'cli' }).map(d => d.doctrine_id).sort();
    const mcpIds = queryDoctrine(TEST_ROOT, { surface: 'mcp-server' }).map(d => d.doctrine_id).sort();
    assert.notDeepEqual(cliIds, mcpIds,
      `expected different surfaces to yield different doctrine sets; both returned ${JSON.stringify(cliIds)}`);
  });

  it('a surface with NO matching pattern anywhere returns only the surface-agnostic doctrine (org_wide + execution_mode)', () => {
    const ids = queryDoctrine(TEST_ROOT, { surface: 'totally-bogus-surface-xyz' }).map(d => d.doctrine_id).sort();
    assert.deepEqual(ids, ['ddoc-execution-mode', 'ddoc-org-wide']);
  });

  it('a surface_archetype doctrine whose based_on_pattern_ids references a non-existent pattern does not crash and is excluded (fails closed, not open)', () => {
    const ids = queryDoctrine(TEST_ROOT, { surface: 'cli' }).map(d => d.doctrine_id);
    assert.ok(!ids.includes('ddoc-dangling-pattern-ref'),
      'a dangling pattern reference must not grant surface credit');
  });
});
