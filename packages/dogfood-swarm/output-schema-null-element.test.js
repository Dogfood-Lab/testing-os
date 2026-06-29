/**
 * output-schema-null-element.test.js
 *
 * F-VERIFYCLI-002 — validateFeatureOutput and validateAmendOutput
 * dereferenced array elements (f.id / output.fixes[i].finding_id) without
 * the null/object guard their sibling validateFinding has. A null array
 * element crashed them with a raw TypeError instead of honoring the
 * validators' contract: always return {valid, errors}.
 *
 * These tests pin the contract — a [null] or [{...}, null] array must yield
 * {valid:false, errors:[...]} with no throw, matching validateFinding's
 * behavior on a null finding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFeatureOutput,
  validateAmendOutput,
} from './lib/output-schema.js';

describe('output-schema null array elements (F-VERIFYCLI-002)', () => {
  it('validateFeatureOutput returns {valid:false} on a [null] features array (no throw)', () => {
    let result;
    assert.doesNotThrow(() => {
      result = validateFeatureOutput({ domain: 'backend', features: [null], summary: 'x' });
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('features[0]')), `errors: ${result.errors.join('; ')}`);
  });

  it('validateFeatureOutput flags a null element among valid ones (no throw)', () => {
    let result;
    assert.doesNotThrow(() => {
      result = validateFeatureOutput({
        domain: 'backend',
        features: [
          { id: 'FT-1', priority: 'HIGH', category: 'missing-feature', description: 'ok' },
          null,
        ],
        summary: 'x',
      });
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('features[1]')), `errors: ${result.errors.join('; ')}`);
  });

  it('validateAmendOutput returns {valid:false} on a [null] fixes array (no throw)', () => {
    let result;
    assert.doesNotThrow(() => {
      result = validateAmendOutput({ domain: 'backend', fixes: [null], files_changed: [] });
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('fixes[0]')), `errors: ${result.errors.join('; ')}`);
  });

  it('validateAmendOutput flags a null element among valid ones (no throw)', () => {
    let result;
    assert.doesNotThrow(() => {
      result = validateAmendOutput({
        domain: 'backend',
        fixes: [
          { finding_id: 'F-001', file: 'src/a.js', description: 'fix' },
          null,
        ],
        files_changed: ['src/a.js'],
      });
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('fixes[1]')), `errors: ${result.errors.join('; ')}`);
  });
});
