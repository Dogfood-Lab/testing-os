/**
 * f-de9c9160-confirm-id-reuse-banner.test.js — F-de9c9160 (MEDIUM, wave 37):
 * all four confirm_id_reuse_* events emitted by lib/fingerprint.js's
 * honorReusedFindingIds (confirm_id_reuse_skipped_approved,
 * confirm_id_reuse_file_mismatch, confirm_id_reuse_unowned,
 * confirm_id_reuse_applied) rendered as a content-free `(no fields)` human
 * banner, because buildSummary()'s recognized-field list did not include
 * any of declared_id / declaring_domain / file / finding_file / prior_file /
 * prior_status / prior_fingerprint / replaced_fingerprint — the entire
 * identity vocabulary this event family uses.
 *
 * Each test below builds the EXACT field shape the real call site in
 * fingerprint.js constructs (component/stage plus that site's own fields —
 * see the line-number citations in each test, verified live against a
 * genuine pre-fix `confirm_id_reuse_unowned` NDJSON line while proving
 * F-00d67cb6 in this same wave) and drives the real, unmutated
 * formatHumanBanner() — never a re-implementation of buildSummary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatHumanBanner } from './log-stage.js';

describe('F-de9c9160 — the four confirm_id_reuse_* events render actual fields, not "(no fields)"', () => {
  /** @pins F-de9c9160 */
  it('GATE: confirm_id_reuse_skipped_approved (fingerprint.js ~933-938) surfaces declared_id/declaring_domain/file', () => {
    const line = {
      ts: '2026-07-17T00:00:00.000Z',
      component: 'dogfood-swarm',
      stage: 'confirm_id_reuse_skipped_approved',
      declared_id: 'F-001',
      declaring_domain: 'swarm-cp-core',
      file: 'packages/dogfood-swarm/lib/log-stage.js',
    };
    const banner = formatHumanBanner(line);
    assert.doesNotMatch(banner, /\(no fields\)/,
      `pre-fix: this event rendered as a content-free banner — got: ${banner}`);
    assert.match(banner, /declared_id=F-001/);
    assert.match(banner, /declaring_domain=swarm-cp-core/);
    assert.match(banner, /file=packages\/dogfood-swarm\/lib\/log-stage\.js/);
  });

  /** @pins F-de9c9160 */
  it('GATE: confirm_id_reuse_file_mismatch (fingerprint.js ~944-951) surfaces BOTH finding_file and prior_file distinctly', () => {
    const line = {
      ts: '2026-07-17T00:00:00.000Z',
      component: 'dogfood-swarm',
      stage: 'confirm_id_reuse_file_mismatch',
      declared_id: 'F-002',
      declaring_domain: 'swarm-cp-core',
      finding_file: 'packages/dogfood-swarm/lib/a.js',
      prior_file: 'packages/dogfood-swarm/lib/b.js',
      prior_status: 'recurring',
    };
    const banner = formatHumanBanner(line);
    assert.doesNotMatch(banner, /\(no fields\)/,
      `pre-fix: this event rendered as a content-free banner — got: ${banner}`);
    assert.match(banner, /finding_file=packages\/dogfood-swarm\/lib\/a\.js/);
    assert.match(banner, /prior_file=packages\/dogfood-swarm\/lib\/b\.js/,
      'the mismatch IS the two file values disagreeing — both must be visible, not collapsed into one');
    assert.match(banner, /prior_status=recurring/);
  });

  /** @pins F-de9c9160 */
  it('GATE: confirm_id_reuse_unowned (fingerprint.js ~957-963) surfaces declared_id/prior_file/prior_status', () => {
    // Field shape verified live against the genuine pre-fix NDJSON line
    // while red-proving F-00d67cb6 in this same wave:
    // {"stage":"confirm_id_reuse_unowned","declared_id":"F-100","declaring_domain":"swarm-cp-core","prior_file":"Packages/Dogfood-Swarm/lib/log-stage.js","prior_status":"recurring"}
    const line = {
      ts: '2026-07-17T00:00:00.000Z',
      component: 'dogfood-swarm',
      stage: 'confirm_id_reuse_unowned',
      declared_id: 'F-003',
      declaring_domain: 'swarm-cp-verbs',
      prior_file: 'packages/dogfood-swarm/lib/log-stage.js',
      prior_status: 'new',
    };
    const banner = formatHumanBanner(line);
    assert.doesNotMatch(banner, /\(no fields\)/,
      `pre-fix: this event rendered as a content-free banner — got: ${banner}`);
    assert.match(banner, /declared_id=F-003/);
    assert.match(banner, /prior_file=packages\/dogfood-swarm\/lib\/log-stage\.js/);
    assert.match(banner, /prior_status=new/);
  });

  /** @pins F-de9c9160 */
  it('GATE: confirm_id_reuse_applied (fingerprint.js ~970-978) surfaces declared_id/prior_status/prior_fingerprint/replaced_fingerprint/file', () => {
    const line = {
      ts: '2026-07-17T00:00:00.000Z',
      component: 'dogfood-swarm',
      stage: 'confirm_id_reuse_applied',
      declared_id: 'F-004',
      declaring_domain: 'swarm-cp-core',
      prior_status: 'recurring',
      prior_fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      replaced_fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      file: 'packages/dogfood-swarm/lib/fingerprint.js',
    };
    const banner = formatHumanBanner(line);
    assert.doesNotMatch(banner, /\(no fields\)/,
      `pre-fix: this event rendered as a content-free banner — got: ${banner}`);
    assert.match(banner, /declared_id=F-004/);
    assert.match(banner, /prior_status=recurring/);
    assert.match(banner, /prior_fingerprint=aaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(banner, /replaced_fingerprint=bbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.match(banner, /file=packages\/dogfood-swarm\/lib\/fingerprint\.js/);
  });

  it('non-regression: an ordinary event with no id-reuse fields is unaffected (still falls through to "(no fields)")', () => {
    const banner = formatHumanBanner({ component: 'dogfood-swarm', stage: 'isolate_failed' });
    assert.match(banner, /\(no fields\)/);
  });

  it('non-regression: an ordinary event with pre-existing recognized fields (domain/run/reason) is unaffected', () => {
    const banner = formatHumanBanner({
      component: 'dogfood-swarm',
      stage: 'dispatch_received',
      domain: 'backend',
      run_id: 'r1',
      reason: 'timeout',
    });
    assert.doesNotMatch(banner, /\(no fields\)/);
    assert.match(banner, /domain=backend/);
    assert.match(banner, /run=r1/);
    assert.match(banner, /reason=timeout/);
  });
});
