/**
 * F-508a5675: parsePolicy read max_age_days/warn_age_days at the surface's TOP
 * level, but policy.schema.json ($defs/surface_policy) nests them under
 * `freshness:` — the shape every real policy on disk uses. Number(undefined)
 * is NaN, so EVERY schema-valid policy silently fell back to the 30/14
 * defaults and the portfolio under-reported staleness against
 * operator-declared thresholds.
 *
 * Contract after the fix: nested `freshness:` is read FIRST; the legacy flat
 * shape remains as a fallback (pinned by the explicit legacy-fallback test in
 * generate.test.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePortfolio, parsePolicy } from './generate.js';

describe('parsePolicy freshness nesting (F-508a5675)', () => {
  it('reads thresholds from the schema-conformant nested freshness block', () => {
    const yamlText = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - scenario_a',
      '    freshness:',
      '      max_age_days: 14',
      '      warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yamlText);
    assert.equal(policy.surfaces.cli.max_age_days, 14,
      'nested freshness.max_age_days must be honored, not the 30-day default');
    assert.equal(policy.surfaces.cli.warn_age_days, 7);
  });

  it('nested shape wins when both nested and flat are present', () => {
    const yamlText = [
      'repo: org/example',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - scenario_a',
      '    max_age_days: 99',
      '    freshness:',
      '      max_age_days: 14',
      '      warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yamlText);
    assert.equal(policy.surfaces.cli.max_age_days, 14);
  });

  it('parses the REAL shipcheck policy on disk to 14/7, not the defaults', () => {
    const raw = readFileSync(
      resolve(import.meta.dirname, '../../policies/repos/mcp-tool-shop-org/shipcheck.yaml'),
      'utf-8'
    );
    const policy = parsePolicy(raw);
    assert.equal(policy.surfaces.cli.max_age_days, 14,
      'the real on-disk policy declares freshness.max_age_days: 14');
    assert.equal(policy.surfaces.cli.warn_age_days, 7);
  });

  it('end-to-end: a 20-day-old record is STALE against a nested 14-day policy', () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString();
    const index = {
      'org/nested-repo': {
        cli: {
          run_id: 'nested-1',
          verified: 'pass',
          verification_status: 'accepted',
          finished_at: twentyDaysAgo,
          path: 'records/org/nested-repo/run-nested-1.json'
        }
      }
    };
    const policies = {
      'org/nested-repo': parsePolicy([
        'repo: org/nested-repo',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios:',
        '      - scenario_a',
        '    freshness:',
        '      max_age_days: 14',
        '      warn_age_days: 7',
        ''
      ].join('\n'))
    };

    const result = generatePortfolio(index, policies);
    assert.equal(result.stale.length, 1,
      'a 20-day-old record must be stale against the declared 14-day threshold');
    assert.equal(result.stale[0].max_age_days, 14);
  });
});
