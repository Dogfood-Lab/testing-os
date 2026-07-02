/**
 * Invariant: the `automation` block of every committed scenario under
 * dogfood/scenarios/ conforms to `scenario.schema.json`.
 *
 * `scenario.schema.json` declares `automation` with `additionalProperties:
 * false` and only allows `script` + `timeout_ms`. It is otherwise easy to add
 * a field that "feels reasonable" (retry policy, env vars, working dir) and
 * have the YAML look fine to a reader while silently failing any code path
 * that runs the schema validator in strict mode. This test makes that drift
 * fail loudly.
 *
 * Seeded by Stage C amend D5B-004 (advisor-verified MED): the committed
 * `swarm-audit.yaml` carried `automation.retry_on_failure: false`, which
 * violates the schema. The fix dropped the field; this test prevents
 * regression.
 *
 * Scope note: this test intentionally probes the `automation` block in
 * isolation (against an automation-block-shaped sub-schema) rather than the
 * whole scenario document. Other schema-mismatch siblings in committed
 * scenarios — e.g. `success_criteria.all_steps_pass` not being a documented
 * field — are out-of-domain for D5B-004 and should be filed separately.
 * Tightening to the full document is a one-line change (validatePayload
 * 'scenario', payload) once those siblings are reconciled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import yaml from 'js-yaml';
import Ajv from 'ajv';
import { scenarioSchema } from '@dogfood-lab/schemas';

const here = dirname(fileURLToPath(import.meta.url));

function loadScenarios() {
  return readdirSync(here)
    .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
    .map(name => {
      const filePath = join(here, name);
      const raw = readFileSync(filePath, 'utf8');
      return { name, filePath, payload: yaml.load(raw) };
    });
}

// Pull the `automation` sub-schema directly out of scenario.schema.json so the
// test stays in lockstep with the source of truth — if the schema relaxes its
// shape, this test relaxes with it automatically.
function buildAutomationValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(scenarioSchema.properties.automation);
}

test('every committed dogfood scenario has a schema-clean automation block', () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length > 0, 'expected at least one scenario file under dogfood/scenarios/');
  const validate = buildAutomationValidator();

  for (const { name, payload } of scenarios) {
    if (payload.automation === undefined) continue; // automation is optional
    const valid = validate(payload.automation);
    assert.equal(
      valid,
      true,
      `${name} has an invalid automation block. Errors: ${JSON.stringify(validate.errors, null, 2)}`
    );
  }

  // Vacuity floor: the D5B-004 invariant is only guarded if at least one
  // committed scenario actually carries an automation block. If every scenario
  // dropped (or renamed) the field, the loop above would validate zero blocks
  // and pass forever — the same zero-matched-inputs failure class D4-004
  // closed for schema-conformance fixtures.
  assert.ok(
    scenarios.some(s => s.payload.automation !== undefined),
    'D5B-004 invariant unguarded: no committed scenario under dogfood/scenarios/ has an automation block — the schema-conformance loop above validated nothing'
  );
});
