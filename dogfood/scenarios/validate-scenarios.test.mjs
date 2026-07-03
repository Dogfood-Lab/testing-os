/**
 * Invariant: every committed scenario under dogfood/scenarios/ validates clean
 * against the WHOLE `scenario.schema.json` — the same registered schema that
 * production ingest fetches and validates a committed scenario with, run here
 * through the canonical `validatePayload('scenario', …)` entry point.
 *
 * scenario.schema.json declares the document and several nested objects
 * (`success_criteria`, `automation`, each `steps[]` entry) with
 * `additionalProperties: false`. It is otherwise easy to add a field that
 * "feels reasonable" — a retry policy on `automation`, an `all_steps_pass`
 * flag on `success_criteria`, a working dir — and have the YAML look fine to a
 * reader while silently failing any code path that runs the schema validator in
 * strict mode. This test makes that drift fail loudly, across the whole document.
 *
 * History — this test used to probe the `automation` block in isolation because
 * a committed scenario carried an out-of-domain schema violation elsewhere:
 *   - Stage C amend D5B-004: `swarm-audit.yaml` carried
 *     `automation.retry_on_failure: false`. The fix dropped the field.
 *   - task_321f8a44: `swarm-audit.yaml` carried `success_criteria.all_steps_pass:
 *     true` — a redundant, unread field the scenario schema rejects (required_steps
 *     already listed all six steps). It was the last sibling forcing this test to
 *     validate a sub-schema rather than the whole document. With it reconciled, the
 *     scope note that lived here ("tightening to the full document is a one-line
 *     change once those siblings are reconciled") is now realized: this test
 *     validates the full scenario document.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import yaml from 'js-yaml';
import { validatePayload } from '@dogfood-lab/schemas';

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

// Negative-case pin: prove the full-document gate can go RED for the right
// reason. `success_criteria.all_steps_pass` is the exact field task_321f8a44
// removed from swarm-audit.yaml; if additionalProperties enforcement on
// success_criteria ever stops firing (dialect drift, strict-mode change), this
// fails before a real scenario regression can slip through green. The sibling
// case — `automation.retry_on_failure` from D5B-004 — is guarded by the same
// additionalProperties mechanism one object over.
test('validatePayload rejects a scenario carrying an undeclared success_criteria field', () => {
  const doc = {
    scenario_id: 'neg-pin',
    scenario_name: 'Negative pin',
    scenario_version: '1.0.0',
    product_surface: 'cli',
    execution_mode: 'bot',
    description: 'A structurally valid scenario with one undeclared field.',
    steps: [{ id: 'only-step', action: 'do the thing' }],
    success_criteria: {
      required_steps: ['only-step'],
      all_steps_pass: true, // the undeclared field
    },
  };
  const res = validatePayload('scenario', doc);
  assert.equal(
    res.valid,
    false,
    'validatePayload accepted a scenario with an undeclared success_criteria field — the schema gate cannot go RED'
  );
  assert.ok(
    res.errors.some(e => e.keyword === 'additionalProperties'),
    `expected an additionalProperties violation, got: ${JSON.stringify(res.errors)}`
  );
});

test('every committed dogfood scenario validates clean against scenario.schema.json', () => {
  const scenarios = loadScenarios();
  // Vacuity floor: the invariant is only guarded if at least one committed
  // scenario actually exists. If the directory emptied, the loop below would
  // validate zero documents and pass forever — the same zero-matched-inputs
  // failure class D4-004 closed for schema-conformance fixtures.
  assert.ok(scenarios.length > 0, 'expected at least one scenario file under dogfood/scenarios/');

  for (const { name, payload } of scenarios) {
    const res = validatePayload('scenario', payload);
    assert.equal(
      res.valid,
      true,
      `${name} does not validate against scenario.schema.json. Errors: ${JSON.stringify(res.errors, null, 2)}`
    );
  }
});
