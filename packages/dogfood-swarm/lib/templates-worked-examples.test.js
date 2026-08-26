/**
 * templates-worked-examples.test.js — F-18b3f76e regression + sibling sweep.
 *
 * templates.js's builder functions (buildAuditPrompt / buildAmendPrompt /
 * buildFeatureAuditPrompt) each embed a worked-example JSON block in the
 * dispatched prompt so an agent can see the expected shape at a glance.
 * F-18b3f76e found that buildFeatureAuditPrompt's example used
 * `"id": "FT-001"` for a feature object — which fails
 * `$defs.feature.properties.id`'s own pattern (`^F-[A-Za-z0-9-]+$`). That
 * pattern is enforced live, with no normalization, by
 * lib/validate-agent-output.js at collect time: an agent that mirrors the
 * example literally produces a schema-invalid output and is marked
 * invalid_output (a BLOCKED status per PROTOCOL.md).
 *
 * dispatch-prompt-schema.test.js (package root, out of this domain) already
 * pact-tests that the schema CONTRACT TEXT is embedded in every prompt; it
 * never JSON.parses the worked-example block itself, which is exactly how
 * this defect — and its sibling F-da5d9128 in PROTOCOL.md — went unnoticed.
 * This file closes that specific gap for the three prompt builders that live
 * in this domain (lib/templates.js).
 *
 * Scope, stated honestly (verified directly against
 * packages/schemas/src/json/agent-output.schema.json before writing this):
 * of the four $defs these three worked examples instantiate (finding, fix,
 * skip, feature), only `feature.properties.id` carries a `pattern`
 * constraint — `finding.id`, `fix.finding_id`, and `skip.finding_id` are all
 * `{type: string, minLength: 1}` with no pattern. The audit/amend examples
 * also use pipe-joined placeholder unions for enum fields (e.g.
 * `"severity": "CRITICAL|HIGH|MEDIUM|LOW"`) — that is a deliberate,
 * different convention (show every legal choice, not a literal to copy)
 * already covered by dispatch-prompt-schema.test.js's enum-substring
 * assertions, so it is intentionally NOT flagged as a pattern violation
 * here. The per-def sweep below is driven from the schema itself (it reads
 * `spec.pattern`, not a hand-copied regex), so a pattern added to any of
 * these fields in the future is automatically checked without editing this
 * file — this is the "sweep for siblings" the F-18b3f76e finding asked for,
 * generalized past the one field it happened to catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from './templates.js';

const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('@dogfood-lab/schemas/json/agent-output.schema.json');
const CANONICAL_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

const BASE_OPTS = {
  repoPath: '/tmp/repo',
  repo: 'org/repo',
  domainName: 'backend',
  globs: ['packages/**'],
  ownershipClass: 'owned',
  domainSnapshotId: 'deadbeef',
  waveNumber: 1,
};

/** Extracts and JSON.parses every ```json fenced block from a rendered prompt. */
function extractJsonBlocks(promptText) {
  const blocks = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(promptText))) {
    blocks.push(JSON.parse(m[1]));
  }
  return blocks;
}

const auditPrompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a' });
const amendPrompt = buildAmendPrompt({ ...BASE_OPTS, phase: 'health-amend-a', findings: [] });
const featurePrompt = buildFeatureAuditPrompt({ ...BASE_OPTS, phase: 'feature-audit' });

describe('templates worked examples — schema field-pattern conformance', () => {
  it('every worked-example JSON block parses (a malformed literal defeats the copy-paste contract)', () => {
    assert.equal(extractJsonBlocks(auditPrompt).length, 1, 'buildAuditPrompt must emit exactly one fenced JSON block');
    assert.equal(extractJsonBlocks(amendPrompt).length, 1, 'buildAmendPrompt must emit exactly one fenced JSON block');
    assert.equal(extractJsonBlocks(featurePrompt).length, 1, 'buildFeatureAuditPrompt must emit exactly one fenced JSON block');
  });

  const cases = [
    { defName: 'finding', promptText: auditPrompt, arrayKey: 'findings' },
    { defName: 'fix', promptText: amendPrompt, arrayKey: 'fixes' },
    { defName: 'skip', promptText: amendPrompt, arrayKey: 'skipped' },
    { defName: 'feature', promptText: featurePrompt, arrayKey: 'features' },
  ];

  for (const { defName, promptText, arrayKey } of cases) {
    it(`${defName} worked example: every pattern-constrained field satisfies its schema pattern`, () => {
      const [block] = extractJsonBlocks(promptText);
      const examples = block[arrayKey];
      assert.ok(
        Array.isArray(examples) && examples.length > 0,
        `worked example must contain a non-empty ${arrayKey}[] array to check`,
      );

      const def = CANONICAL_SCHEMA.$defs[defName];
      const patternFields = Object.entries(def.properties).filter(([, spec]) => spec.pattern);

      for (const example of examples) {
        for (const [field, spec] of patternFields) {
          const value = example[field];
          if (typeof value !== 'string') continue; // field absent from this particular literal
          assert.ok(
            new RegExp(spec.pattern).test(value),
            `${defName}.${field} worked-example literal ${JSON.stringify(value)} must satisfy pattern ` +
              `${spec.pattern} — a real agent output copying this literal fails ` +
              'lib/validate-agent-output.js with no normalization at collect time (F-18b3f76e defect class)',
          );
        }
      }
    });
  }
});

/** Non-copyable placeholder shape: F-xxxxxxxx, F-<8hex>, or DOMAIN-B-NNN. */
const CANONICAL_EXAMPLE_ID = /^(F-xxxxxxxx|F-[a-f0-9]{8}|[A-Z]+-B-\d{3})$/;
const FORBIDDEN_LOCAL_IDS = new Set(['F-001', 'F-002', 'F-003']);

describe('audit/feature worked-example id discipline (F-35fdf791)', () => {
  /** @pins F-35fdf791 */
  it('buildAuditPrompt findings[].id is F-xxxxxxxx/DOMAIN-B-001, never F-001; prose forbids F-001/F-002/F-003', () => {
    const [block] = extractJsonBlocks(auditPrompt);
    assert.ok(Array.isArray(block.findings) && block.findings.length > 0,
      'audit worked example must include findings[]');

    for (const finding of block.findings) {
      assert.equal(typeof finding.id, 'string');
      assert.ok(!FORBIDDEN_LOCAL_IDS.has(finding.id),
        `audit findings[].id must not teach local placeholder ${finding.id}`);
      assert.match(
        finding.id,
        CANONICAL_EXAMPLE_ID,
        `audit findings[].id ${JSON.stringify(finding.id)} must be F-xxxxxxxx, F-<8hex>, or DOMAIN-B-NNN`,
      );
    }

    assert.match(
      auditPrompt,
      /never F-001\/F-002\/F-003/,
      'audit Output Format prose must forbid F-001/F-002/F-003 the way amend already does',
    );
  });

  /** @pins F-35fdf791 */
  it('buildFeatureAuditPrompt features[].id and confirmed[] never teach F-001/F-002; prose forbids them', () => {
    const [block] = extractJsonBlocks(featurePrompt);
    assert.ok(Array.isArray(block.features) && block.features.length > 0,
      'feature-audit worked example must include features[]');

    for (const feature of block.features) {
      assert.equal(typeof feature.id, 'string');
      assert.ok(!FORBIDDEN_LOCAL_IDS.has(feature.id),
        `feature-audit features[].id must not teach local placeholder ${feature.id}`);
      assert.match(
        feature.id,
        CANONICAL_EXAMPLE_ID,
        `feature-audit features[].id ${JSON.stringify(feature.id)} must be F-xxxxxxxx or F-<8hex>`,
      );
    }

    assert.ok(Array.isArray(block.confirmed), 'feature-audit worked example must include confirmed[]');
    for (const id of block.confirmed) {
      assert.equal(typeof id, 'string');
      assert.ok(!FORBIDDEN_LOCAL_IDS.has(id),
        `feature-audit confirmed[] must not teach local placeholder ${id}`);
      assert.match(
        id,
        CANONICAL_EXAMPLE_ID,
        `feature-audit confirmed[] entry ${JSON.stringify(id)} must be F-xxxxxxxx or F-<8hex>`,
      );
    }

    assert.match(
      featurePrompt,
      /never F-001\/F-002\/F-003/,
      'feature-audit Output Format prose must forbid F-001/F-002/F-003 the way amend already does',
    );
  });
});
