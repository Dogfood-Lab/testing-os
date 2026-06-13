/**
 * stageA-uppercase-severity-gate.test.js
 *
 * d4-swarm-core-001 / 002 / NEW (Stage A amend wave):
 *
 * persist-results.js deriveVerdict() and buildAuditPayload() compared finding
 * severity against LOWERCASE literals ('critical'/'high'/'medium'/'low') while
 * the canonical in-flight severity is UPPERCASE — the agent-output schema enum
 * is ['CRITICAL','HIGH','MEDIUM','LOW'], the DB STATUS.severity enum is
 * uppercase, lib/templates.js instructs agents to emit "CRITICAL|HIGH|MEDIUM|LOW",
 * and every in-package sibling (dogfood-bridge.js, repoknowledge-bridge.js,
 * advance.js, receipt.js, findings-digest.js) keys on UPPERCASE.
 *
 * Consequence of the bug: in normal operation every lowercase comparison
 * matched ZERO findings — deriveVerdict returned 'pass' even with open
 * CRITICALs, and buildAuditPayload emitted critical_count=0, overall_status
 * 'pass', overall_posture 'healthy', blocking_release=false regardless of the
 * real finding set. The release-gating signal was silently inverted.
 *
 * The pre-existing fixtures in swarm.test.js / wave9-defensive-depth.test.js /
 * persist-results-schema-conformance.test.js all encoded LOWERCASE severity —
 * the case production never produces — so they pinned the bug and gave the gate
 * ZERO effective coverage. This file feeds the REAL (uppercase) agent-output
 * contract case and asserts the gate fires.
 *
 * The full invariant (both halves):
 *   1. An OPEN uppercase CRITICAL counts as critical_count=1 / blocking_release=true.
 *   2. A FIXED critical does NOT block (status gate still respected).
 * Plus deriveVerdict must classify the same way on the uppercase contract case.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveVerdict,
  buildAuditPayload,
} from './persist-results.js';

const MANIFEST = {
  repo: 'mcp-tool-shop-org/test-repo',
  commit_sha: 'c'.repeat(40),
};

describe('Stage A — UPPERCASE severity release gate (d4-swarm-core-001)', () => {
  it('buildAuditPayload counts an OPEN uppercase CRITICAL as critical_count=1 / blocking_release=true', () => {
    // This is the case real audit JSONs carry (agent-output enum is uppercase).
    const audits = [{
      component_id: 'core',
      controls: [],
      findings: [
        { id: 'f1', severity: 'CRITICAL', domain: 'security', status: 'open' },
      ],
    }];
    const payload = buildAuditPayload(MANIFEST, audits, []);
    assert.equal(payload.metrics.critical_count, 1,
      'an open CRITICAL must be counted — this is the release gate');
    assert.equal(payload.run.blocking_release, true,
      'an open CRITICAL must block release');
    assert.equal(payload.run.overall_status, 'fail');
    assert.equal(payload.run.overall_posture, 'critical');
  });

  it('buildAuditPayload counts the full uppercase severity ladder', () => {
    const audits = [{
      component_id: 'core',
      controls: [{ id: 'c1', domain: 'security', status: 'pass' }],
      findings: [
        { id: 'f1', severity: 'CRITICAL', domain: 'security', status: 'open' },
        { id: 'f2', severity: 'HIGH', domain: 'security', status: 'open' },
        { id: 'f3', severity: 'MEDIUM', domain: 'docs', status: 'open' },
        { id: 'f4', severity: 'LOW', domain: 'docs', status: 'open' },
      ],
    }];
    const payload = buildAuditPayload(MANIFEST, audits, []);
    assert.equal(payload.metrics.critical_count, 1);
    assert.equal(payload.metrics.high_count, 1);
    assert.equal(payload.metrics.medium_count, 1);
    assert.equal(payload.metrics.low_count, 1);
  });

  it('buildAuditPayload: a FIXED uppercase CRITICAL does NOT block release (status gate respected)', () => {
    const audits = [{
      component_id: 'core',
      controls: [],
      findings: [
        { id: 'f1', severity: 'CRITICAL', domain: 'security', status: 'open' },
      ],
    }];
    // Remediation marks f1 fixed → must drop out of the blocking count.
    const remediate = [{ component_id: 'core', fixes: [{ finding_id: 'f1' }] }];
    const payload = buildAuditPayload(MANIFEST, audits, remediate);
    assert.equal(payload.metrics.critical_count, 0,
      'a fixed CRITICAL must not count');
    assert.equal(payload.run.blocking_release, false);
  });

  it('deriveVerdict returns fail for an OPEN uppercase CRITICAL', () => {
    assert.equal(
      deriveVerdict([{ severity: 'CRITICAL', status: 'open' }]),
      'fail',
    );
  });

  it('deriveVerdict returns partial for an OPEN uppercase HIGH', () => {
    assert.equal(
      deriveVerdict([{ severity: 'HIGH', status: 'open' }]),
      'partial',
    );
  });

  it('deriveVerdict ignores a FIXED uppercase CRITICAL', () => {
    assert.equal(
      deriveVerdict([{ severity: 'CRITICAL', status: 'fixed' }]),
      'pass',
    );
  });

  it('deriveVerdict normalizes mixed-case severity defensively', () => {
    // Belt-and-suspenders: a stray lowercase/mixed-case severity must still be
    // classified by value, not pinned to one exact spelling. This is what makes
    // the gate robust to the very drift d4-swarm-core-001 was.
    assert.equal(deriveVerdict([{ severity: 'critical', status: 'open' }]), 'fail');
    assert.equal(deriveVerdict([{ severity: 'Critical', status: 'open' }]), 'fail');
  });
});
