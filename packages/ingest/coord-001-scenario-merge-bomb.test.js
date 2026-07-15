/**
 * coord-001-scenario-merge-bomb.test.js
 *
 * COORD-001 — js-yaml 4.1.1 (the workspace floor; package.json pins
 * `"js-yaml": "^4.1.0"`) carries GHSA-h67p-54hq-rp68: chained `<<` merge
 * keys cost O(depth) per level, because `mergeMappings()`
 * (js-yaml lib/loader.js:304-321) re-copies `Object.keys(source)` for the
 * FULL accumulated mapping at every level of the chain — so an n-level
 * chain costs O(n^2) total to parse. The attack is small BY CONSTRUCTION
 * (each level only adds a couple of YAML lines), so the existing
 * GITHUB_SCENARIO_MAX_BYTES cap (1 MiB, a wire-size limit) does not defend
 * it at all: measured on the reference rig, a chain sized right at that
 * 1 MiB cap costs ~61s of CPU, and scaling is ~quadratic (68 KB -> 127ms,
 * 145 KB -> 656ms). Bumping js-yaml to v5 (which drops merge-key support
 * outright) is blocked — Dependabot #50 is held open because v5 breaks
 * two scripts/ gates — so `load-context.js`'s `parseUntrustedScenarioYaml`
 * defends by parsing with `{ schema: yaml.CORE_SCHEMA }` instead, which
 * omits the `merge` type DEFAULT_SCHEMA registers. See that function's
 * doc comment for the full mechanism.
 *
 * This file does NOT trust the option name. Every claim below is proven
 * behaviourally:
 *   1. A precondition check proves plain `yaml.load()` (DEFAULT_SCHEMA)
 *      really does resolve `<<` as a merge on our probe documents — so a
 *      later "still rejected" result is evidence of the guard, not an
 *      unrelated authoring mistake in the fixture.
 *   2. A direct test on `parseUntrustedScenarioYaml` proves the merge key
 *      structurally cannot fire (the literal `<<` property survives
 *      instead of being consumed) — deletion-provable: remove
 *      `{ schema: yaml.CORE_SCHEMA }` from that function and this test
 *      goes red.
 *   3. An END-TO-END test through the real `githubScenarioFetcher` public
 *      surface proves the WIRING, not just the helper in isolation — a
 *      document engineered so it is only a schema-valid scenario if `<<`
 *      gets merged stays rejected. This goes red even if someone reverts
 *      the call site in `attemptOnce()` back to plain `yaml.load(text)`
 *      while leaving `parseUntrustedScenarioYaml` itself untouched.
 *   4. A chained merge-key fixture shaped like the real attack (not a
 *      single-level probe) parses through the same real path in
 *      milliseconds, not seconds — see buildMergeChainYaml for why this
 *      fixture is deliberately tiny (n=400) rather than production-sized:
 *      the point is to prove the shape is handled, not to spend the
 *      suite's time re-deriving the 61s number.
 *   5. A GREEN path proves the guard has no false positive on an ordinary
 *      scenario document with no merge keys at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

import {
  githubScenarioFetcher,
  parseUntrustedScenarioYaml,
  GITHUB_SCENARIO_MAX_BYTES
} from './load-context.js';

const VALID_SHA = 'deadbeef';

function resp(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: undefined,
    async text() { return body; }
  };
}

/**
 * A chain of `levels` mappings, each merging in the FULL accumulated
 * result of the one before it plus one new key — the shape that drives
 * mergeMappings()'s O(depth) per-level cost (js-yaml copies
 * Object.keys(source) unconditionally, and `source` here is already the
 * fully-merged previous level). Kept tiny: n=400 measures ~17.9 KB /
 * ~13ms even fully UNPROTECTED on the reference rig — see the timing
 * test below for the live number this suite actually observes.
 */
function buildMergeChainYaml(levels) {
  const lines = ['base0: &base0', '  k0: v0'];
  for (let i = 1; i <= levels; i++) {
    lines.push(`base${i}: &base${i}`);
    lines.push(`  <<: *base${i - 1}`);
    lines.push(`  k${i}: v${i}`);
  }
  lines.push('scenario_id: bomb');
  lines.push(`<<: *base${levels}`);
  return lines.join('\n') + '\n';
}

// Single-level probe: `<<` merges in `legit_key` from an aliased mapping.
// Not a conforming scenario document either way (missing every required
// field) — used only to prove the merge mechanism itself, not routed
// through schema validation.
const SIMPLE_MERGE_PROBE = [
  'base: &base',
  '  legit_key: legit_value',
  'scenario_id: probe',
  '<<: *base',
  ''
].join('\n');

// Schema-flip probe: `execution_mode` (required, enum bot/human/mixed) is
// supplied ONLY via an inline flow-mapping merge value — no anchor needed,
// so there is no stray extra top-level key to confound the result. Every
// OTHER required field is present unconditionally. So:
//   - merge fires  -> execution_mode lands at top level -> fully schema-valid
//   - merge is inert -> execution_mode is missing AND `<<` is an unexpected
//     property (additionalProperties: false) -> invalid for two reasons
function schemaFlipProbe() {
  return [
    'scenario_id: probe',
    'scenario_name: Probe',
    'scenario_version: 1.0.0',
    'product_surface: cli',
    'description: probe',
    'steps:',
    '  - id: one',
    '    action: probe step',
    'success_criteria:',
    '  required_steps:',
    '    - one',
    '<<: { execution_mode: bot }',
    ''
  ].join('\n');
}

const VALID_SCENARIO_YAML = [
  'scenario_id: sanity',
  'scenario_name: Sanity smoke',
  'scenario_version: 1.0.0',
  'product_surface: cli',
  'execution_mode: bot',
  'description: Smoke-checks the CLI happy path.',
  'steps:',
  '  - id: one',
  '    action: run the CLI once',
  'success_criteria:',
  '  required_steps:',
  '    - one',
  ''
].join('\n');

describe('COORD-001 — scenario YAML merge-key DoS (GHSA-h67p-54hq-rp68)', () => {
  it('PRECONDITION: DEFAULT_SCHEMA really does merge `<<` on both probes (or the tests below are vacuous)', () => {
    const simple = yaml.load(SIMPLE_MERGE_PROBE);
    assert.equal(simple.legit_key, 'legit_value',
      'precondition failed: DEFAULT_SCHEMA must merge legit_key in for the simple probe to be meaningful');

    const flip = yaml.load(schemaFlipProbe());
    assert.equal(flip.execution_mode, 'bot',
      'precondition failed: DEFAULT_SCHEMA must merge execution_mode in for the schema-flip probe to be meaningful');
  });

  it('parseUntrustedScenarioYaml does not resolve `<<` as a merge key', () => {
    const result = parseUntrustedScenarioYaml(SIMPLE_MERGE_PROBE);

    // Deletion/emptiness proof: remove `{ schema: yaml.CORE_SCHEMA }` from
    // parseUntrustedScenarioYaml and this goes red — legit_key would leak
    // to the top level exactly as the precondition test above shows it
    // does under plain yaml.load().
    assert.equal(result.legit_key, undefined,
      'merge key resolved — legit_key leaked from the merge source, CORE_SCHEMA guard is not firing');
    assert.ok(Object.hasOwn(result, '<<'),
      'the `<<` key must survive as a literal, unmerged property when merge is disabled');
  });

  it('END-TO-END: a document only made schema-valid by a merge key stays rejected through the real fetch path', async () => {
    const fetchImpl = async () => resp(200, schemaFlipProbe());
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl, attempts: 1 });

    const result = await fetcher.fetchWithReason('probe');

    // This is sensitive to BOTH regressions: a helper that stops using
    // CORE_SCHEMA, or an attemptOnce() call site that stops calling the
    // helper at all (e.g. reverted to plain yaml.load(text)) — either way
    // execution_mode would merge in, the document would become fully
    // schema-valid, and this assertion would flip to a truthy scenario.
    assert.equal(result.scenario, null,
      `a document only valid via merge must be rejected; got ${JSON.stringify(result)}`);
    assert.equal(result.reason, 'schema_invalid');
  });

  it('a small (n=400) merge-key chain parses through the real fetch path in well under a second', async () => {
    const bomb = buildMergeChainYaml(400);

    // "Small by construction" is the whole point of COORD-001: this is
    // roughly 2% of the 1 MiB byte cap, so the cap gives zero coverage
    // against it.
    assert.ok(bomb.length < GITHUB_SCENARIO_MAX_BYTES / 10,
      `fixture must stay small by construction; got ${bomb.length} bytes`);

    const fetchImpl = async () => resp(200, bomb);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl, attempts: 1 });

    const start = process.hrtime.bigint();
    const result = await fetcher.fetchWithReason('bomb');
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Generous ceiling (measured ~13ms UNPROTECTED at n=400 on the
    // reference rig; CORE_SCHEMA parses it in ~1ms). This is a sanity
    // backstop against a gross regression, not a precision timing
    // assertion — quadratic scaling means even a 10x-larger accidental
    // fixture would still land an order of magnitude under this bound.
    assert.ok(elapsedMs < 1000,
      `merge-key chain took ${elapsedMs.toFixed(1)}ms — expected well under 1000ms`);

    // The chain is not a conforming scenario document either way (stray
    // base*/`<<` keys), so both the protected and unprotected parse would
    // fail schema — this assertion exists to prove the call completes
    // cleanly (no hang, no thrown parse error), not to distinguish the
    // two states. That distinction is what the END-TO-END test above
    // proves.
    assert.equal(result.scenario, null);
    assert.equal(result.reason, 'schema_invalid',
      `expected a clean schema rejection, not a parse failure or hang; got ${JSON.stringify(result)}`);
  });

  it('GREEN: an ordinary scenario with no merge keys still loads (no false positive)', async () => {
    const fetchImpl = async () => resp(200, VALID_SCENARIO_YAML);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl, attempts: 1 });

    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, `valid scenario must still load; got ${JSON.stringify(result)}`);
    assert.equal(result.scenario.scenario_id, 'sanity');
    assert.equal(result.scenario.execution_mode, 'bot');
    assert.ok(result.reason == null, 'success path carries no reason');
  });
});
