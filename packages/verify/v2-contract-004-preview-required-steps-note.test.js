/**
 * v2-contract-004-preview-required-steps-note.test.js
 *
 * V2-CONTRACT-004 / V2-CROSS-BO-004 (wave-2 fix-up, document-the-boundary
 * option per coordinator judge) — the preview CLI never loads scenario
 * definitions, so success_criteria.required_steps enforcement (F-3bfc2885)
 * runs ONLY in production ingest. A consumer whose preview prints
 * VERDICT: ACCEPTED can still be rejected by real ingest on required_steps.
 *
 * Wiring a fetcher is deferred to a feature pass; this pins the DOCUMENTED
 * gap with the same discipline run.js uses for GitLab:
 *   - --help carries a "NOT CHECKED IN PREVIEW" line naming required_steps;
 *   - every --explain rendering carries an explicit
 *     "not checked in preview: required_steps (needs scenario definitions)"
 *     note, so no preview verdict can be read as covering required_steps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { run, renderExplain } from './cli.js';

const NOTE = /not checked in preview: required_steps \(needs scenario definitions/i;

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

describe('V2-CONTRACT-004 — preview documents the required_steps enforcement gap', () => {
  it('--help names the gap', async () => {
    const { io, stdout } = captureIo();
    const code = await run(['--help'], io);
    assert.equal(code, 0);
    assert.match(stdout(), /required_steps/,
      '--help must name the unchecked surface');
    assert.match(stdout(), NOTE);
  });

  it('renderExplain carries the note on an ACCEPTED record', () => {
    const accepted = {
      verification: {
        status: 'accepted',
        schema_valid: true,
        policy_valid: true,
        provenance_confirmed: true,
        rejection_reasons: [],
      },
      overall_verdict: { verified: 'pass' },
    };
    const text = renderExplain(accepted);
    assert.match(text, NOTE,
      'an accepted preview verdict must disclaim required_steps coverage');
  });

  it('renderExplain carries the note on a REJECTED record too', () => {
    const rejected = {
      verification: {
        status: 'rejected',
        schema_valid: false,
        policy_valid: true,
        provenance_confirmed: true,
        rejection_reasons: ['schema: /repo must be string'],
      },
      overall_verdict: { verified: 'fail' },
    };
    assert.match(renderExplain(rejected), NOTE);
  });
});
