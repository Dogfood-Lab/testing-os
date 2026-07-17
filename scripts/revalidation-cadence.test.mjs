// F-875708f9 (wave 39 feature pass) — the shared cadence/overdue helper
// extracted from check-finding-regression-pins.mjs's inline dueForRevalidation
// computation. These tests pin the pure-function contract directly; the
// parity test in check-finding-regression-pins.test.mjs proves the gate's own
// output is unchanged after the refactor consumes this module.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDueForRevalidation,
  defaultToday,
  selectDueForRevalidation,
} from './lib/revalidation-cadence.mjs';

test('isDueForRevalidation: true when revalidate_by is strictly before today', () => {
  assert.equal(isDueForRevalidation({ revalidate_by: '2026-01-01' }, '2026-07-17'), true);
});

test('isDueForRevalidation: false when revalidate_by equals today (not yet overdue)', () => {
  assert.equal(isDueForRevalidation({ revalidate_by: '2026-07-17' }, '2026-07-17'), false);
});

test('isDueForRevalidation: false when revalidate_by is after today', () => {
  assert.equal(isDueForRevalidation({ revalidate_by: '2026-12-31' }, '2026-07-17'), false);
});

test('defaultToday: returns an ISO YYYY-MM-DD string', () => {
  const today = defaultToday();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  // Sanity: matches what `new Date().toISOString().slice(0, 10)` would
  // produce right now, within the same UTC day this test runs in.
  assert.equal(today, new Date().toISOString().slice(0, 10));
});

/** @pins F-875708f9 */
test('selectDueForRevalidation: projects only overdue ids to { id, revalidate_by, owner }', () => {
  const ids = ['F-aaa', 'F-bbb', 'F-ccc'];
  const entryById = {
    'F-aaa': { revalidate_by: '2020-01-01', owner: 'alice' },
    'F-bbb': { revalidate_by: '2099-01-01', owner: 'bob' },
    'F-ccc': { revalidate_by: '2020-06-15', owner: 'carol' },
  };
  const result = selectDueForRevalidation(ids, entryById, '2026-07-17');
  assert.deepEqual(result, [
    { id: 'F-aaa', revalidate_by: '2020-01-01', owner: 'alice' },
    { id: 'F-ccc', revalidate_by: '2020-06-15', owner: 'carol' },
  ]);
});

test('selectDueForRevalidation: empty ids list yields empty result', () => {
  assert.deepEqual(selectDueForRevalidation([], {}, '2026-07-17'), []);
});

test('selectDueForRevalidation: an id missing from entryById is silently skipped, not thrown', () => {
  const result = selectDueForRevalidation(['F-missing'], {}, '2026-07-17');
  assert.deepEqual(result, []);
});

test('selectDueForRevalidation: defaults `today` to defaultToday() when omitted', () => {
  const entryById = { 'F-past': { revalidate_by: '2000-01-01', owner: 'alice' } };
  const result = selectDueForRevalidation(['F-past'], entryById);
  assert.deepEqual(result, [{ id: 'F-past', revalidate_by: '2000-01-01', owner: 'alice' }]);
});
