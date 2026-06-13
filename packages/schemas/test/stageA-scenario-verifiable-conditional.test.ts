/**
 * stageA-scenario-verifiable-conditional.test.ts — Contract spine: a scenario
 * step that claims to be verifiable MUST state what a passing result looks
 * like.
 *
 * d1-schemas-NEW (third instance of the d1-schemas-003 family) — the scenario
 * schema's own description has always said
 *   step.expected "What a passing result looks like. Required if verifiable is true."
 * but the schema enforced NO such constraint (no allOf/if/then/
 * dependentRequired on the step object), and no verify-side code backstops it.
 * So a step could be authored with verifiable:true and no `expected` text and
 * validate clean — a verifiable step with no pass condition.
 *
 * AFTER FIX: the step object carries a dependentRequired (verifiable ⇒
 * expected). dependentRequired fires only when the key is present, and
 * verifiable defaults false, so a step that omits verifiable (or sets it
 * false) is unaffected. Mirrors the H4 precedent
 * (dogfood-finding.schema.json allOf/if/then).
 */

import { describe, expect, it } from 'vitest';
import { validatePayload } from '../src/index.js';

/** A minimal valid scenario with a single step we can mutate. */
function makeScenario(step: Record<string, unknown>): Record<string, unknown> {
  return {
    scenario_id: 'verifiable-conditional-test',
    scenario_name: 'Verifiable conditional test scenario',
    scenario_version: '1.0.0',
    product_surface: 'cli',
    execution_mode: 'human',
    description: 'Exercises the verifiable⇒expected conditional added in stage A.',
    steps: [step],
    success_criteria: { required_steps: [String(step.id)] },
  };
}

describe('scenario schema — verifiable step requires expected (if/then)', () => {
  it('accepts a step with verifiable omitted (defaults false) and no expected', () => {
    const result = validatePayload('scenario', makeScenario({ id: 's1', action: 'run the CLI' }));
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts a step with verifiable:false and no expected', () => {
    const result = validatePayload(
      'scenario',
      makeScenario({ id: 's1', action: 'observe', verifiable: false }),
    );
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('REJECTS a step with verifiable:true and no expected', () => {
    const result = validatePayload(
      'scenario',
      makeScenario({ id: 's1', action: 'run the CLI', verifiable: true }),
    );
    expect(result.valid, 'expected verifiable-without-expected to be invalid').toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/expected/);
  });

  it('accepts a step with verifiable:true AND expected set', () => {
    const result = validatePayload(
      'scenario',
      makeScenario({
        id: 's1',
        action: 'run the CLI',
        verifiable: true,
        expected: 'exit code 0 and the version string is printed',
      }),
    );
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
});
