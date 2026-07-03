import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { run, parseArgs, renderExplain, buildJsonResult } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
// The CLI resolves policies relative to repoRoot (../.. from the package).
// We pass it explicitly so the test is anchored regardless of cwd.
const REPO_ROOT = resolve(__dirname, '../..');

/** Collect CLI output into a buffer so we can assert on what the consumer sees. */
function makeIo(repoRoot = REPO_ROOT) {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      repoRoot
    },
    out,
    err,
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n')
  };
}

let pilot0;
let tmpDir;
let goodFile;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
  // Write the known-good submission to a temp --file so we exercise the real
  // file-read path, not just --payload.
  tmpDir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
  goodFile = join(tmpDir, 'good-submission.json');
  writeFileSync(goodFile, JSON.stringify(pilot0), 'utf-8');
});

// ── --explain on a known-good submission → accepted, exit 0 ──────────

describe('verify --explain on a known-good submission', () => {
  it('reports accepted and exits 0 (stub provenance, from --file)', async () => {
    const { io, stdout } = makeIo();
    const code = await run(['--file', goodFile, '--explain'], io);
    assert.equal(code, 0, `expected exit 0, got ${code}\n${stdout()}`);
    assert.match(stdout(), /VERDICT: ACCEPTED/);
    assert.match(stdout(), /No rejection reasons/);
  });

  it('defaults to --explain and --provenance=stub when neither is given', async () => {
    const { io, stdout } = makeIo();
    const code = await run(['--file', goodFile], io);
    assert.equal(code, 0);
    assert.match(stdout(), /VERDICT: ACCEPTED/);
  });
});

// ── --explain on a known-bad submission → rejected, exit 1, classed ──

describe('verify --explain on a known-bad submission', () => {
  it('reports the rejection reasons with their classes and exits 1', async () => {
    // A submission carrying a verifier-owned field is rejected by verify() with
    // a `submission-contains-verifier-field:` reason → classed submission-bad.
    const bad = { ...structuredClone(pilot0), policy_version: '9.9.9' };
    const { io, stdout } = makeIo();
    const code = await run(['--payload', JSON.stringify(bad), '--explain'], io);

    assert.equal(code, 1, `expected exit 1 (rejected), got ${code}\n${stdout()}`);
    assert.match(stdout(), /VERDICT: REJECTED/);
    assert.match(stdout(), /REJECTION REASONS/);
    // The class label proves parseRejectionReason classification reached output —
    // the consumer is told this is THEIR payload to fix.
    assert.match(stdout(), /SUBMISSION/);
    assert.match(stdout(), /verifier-field/);
  });

  it('classes a null submission as OPERATIONAL, not the submitter\'s fault', async () => {
    // verify(null) emits a `submission-malformed:` reason → operational class.
    const { io, stdout } = makeIo();
    const code = await run(['--payload', 'null', '--explain'], io);
    assert.equal(code, 1);
    assert.match(stdout(), /VERDICT: REJECTED/);
    assert.match(stdout(), /OPERATIONAL/);
  });
});

// ── --json mode → machine-readable, pre-classified ──────────────────

describe('verify --json', () => {
  it('emits a parseable object with per-reason class on rejection', async () => {
    const bad = { ...structuredClone(pilot0), policy_version: '9.9.9' };
    const { io, stdout } = makeIo();
    const code = await run(['--payload', JSON.stringify(bad), '--json'], io);
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.status, 'rejected');
    assert.ok(Array.isArray(parsed.rejection_reasons));
    assert.ok(parsed.rejection_reasons.length > 0);
    for (const r of parsed.rejection_reasons) {
      assert.ok(['submission-bad', 'operational', 'ingest', 'unknown'].includes(r.class));
      assert.ok(typeof r.raw === 'string');
    }
    assert.ok(parsed.rejection_reasons.some(r => r.class === 'submission-bad'));
  });

  it('emits status accepted with no reasons for a good submission', async () => {
    const { io, stdout } = makeIo();
    const code = await run(['--file', goodFile, '--json'], io);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.status, 'accepted');
    assert.deepEqual(parsed.rejection_reasons, []);
  });
});

// ── Operator-error paths → exit 2 ───────────────────────────────────

describe('verify operator-error paths exit 2', () => {
  it('exits 2 when no submission is provided', async () => {
    const { io, stderr } = makeIo();
    const code = await run(['--explain'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /no submission provided/);
  });

  it('exits 2 on an unreadable --file', async () => {
    const { io, stderr } = makeIo();
    const code = await run(['--file', join(tmpDir, 'does-not-exist.json')], io);
    assert.equal(code, 2);
    assert.match(stderr(), /could not read --file/);
  });

  it('exits 2 on invalid JSON', async () => {
    const { io, stderr } = makeIo();
    const code = await run(['--payload', '{ not json'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /invalid JSON/);
  });

  it('exits 2 on an unknown flag', async () => {
    const { io, stderr } = makeIo();
    const code = await run(['--file', goodFile, '--bogus'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /unknown argument/);
  });

  it('exits 2 when --explain and --json conflict', async () => {
    const { io, stderr } = makeIo();
    const code = await run(['--file', goodFile, '--explain', '--json'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /mutually exclusive/);
  });

  it('exits 2 on an unknown --provenance value', async () => {
    const { io, stderr } = makeIo();
    const code = await run(['--file', goodFile, '--provenance=banana'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /unknown --provenance value/);
  });
});

// ── --help → usage, exit 0 ──────────────────────────────────────────

describe('verify --help', () => {
  it('prints usage and exits 0', async () => {
    const { io, stdout } = makeIo();
    const code = await run(['--help'], io);
    assert.equal(code, 0);
    assert.match(stdout(), /Usage:/);
    assert.match(stdout(), /Exit codes:/);
  });

  it('uses Title-case section headers, matching the three sibling bins', async () => {
    // F-ac2ba3b1: verify was the lone ALL-CAPS outlier among the four backend
    // bins (dogfood-report / dogfood-init / findings all use Title-case). Pin the
    // converged headers so the family stays consistent.
    const { io, stdout } = makeIo();
    await run(['--help'], io);
    const help = stdout();
    for (const header of ['Usage:', 'Input', 'Output mode', 'Provenance', 'Not checked in preview:', 'Exit codes:']) {
      assert.match(help, new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `expected Title-case header "${header}" in --help`);
    }
    for (const capsHeader of ['USAGE:', 'OUTPUT MODE', 'PROVENANCE', 'NOT CHECKED IN PREVIEW:', 'EXIT CODES:']) {
      assert.doesNotMatch(help, new RegExp(capsHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `ALL-CAPS header "${capsHeader}" must be gone`);
    }
  });
});

// ── parseArgs unit coverage (both --flag value and --flag=value) ─────

describe('parseArgs', () => {
  it('accepts both the space and equals forms for --provenance', () => {
    assert.equal(parseArgs(['--file', 'x', '--provenance', 'github']).provenanceMode, 'github');
    assert.equal(parseArgs(['--file', 'x', '--provenance=github']).provenanceMode, 'github');
  });

  it('defaults mode=explain and provenance=stub', () => {
    const opts = parseArgs(['--file', 'x']);
    assert.equal(opts.mode, 'explain');
    assert.equal(opts.provenanceMode, 'stub');
  });

  it('rejects giving both --file and --payload', () => {
    assert.throws(() => parseArgs(['--file', 'x', '--payload', '{}']), /mutually exclusive/);
  });
});

// ── render/build helpers are pure given a record ────────────────────

describe('renderExplain / buildJsonResult helpers', () => {
  const acceptedRecord = {
    run_id: 'r1',
    overall_verdict: { proposed: 'pass', verified: 'pass', downgraded: false },
    verification: {
      status: 'accepted',
      schema_valid: true,
      policy_valid: true,
      provenance_confirmed: true,
      rejection_reasons: []
    }
  };

  it('renderExplain shows accepted with no reasons', () => {
    const text = renderExplain(acceptedRecord);
    assert.match(text, /VERDICT: ACCEPTED/);
    assert.match(text, /No rejection reasons/);
  });

  it('renderExplain uppercases the verdict word, matching sibling banners', () => {
    const accepted = renderExplain(acceptedRecord);
    assert.match(accepted, /VERDICT: ACCEPTED/);
    assert.doesNotMatch(accepted, /VERDICT: accepted/);

    const rejectedRecord = {
      run_id: 'r3',
      verification: {
        status: 'rejected',
        schema_valid: true,
        policy_valid: false,
        provenance_confirmed: true,
        rejection_reasons: ['policy: evidence requirement not met']
      }
    };
    const rejected = renderExplain(rejectedRecord);
    assert.match(rejected, /VERDICT: REJECTED/);
    assert.doesNotMatch(rejected, /VERDICT: rejected/);
  });

  it('buildJsonResult keeps status as the lowercase enum, not the rendered word', () => {
    assert.equal(buildJsonResult(acceptedRecord).status, 'accepted');
  });

  it('buildJsonResult classifies each reason and carries raw', () => {
    const rejected = {
      run_id: 'r2',
      overall_verdict: { proposed: 'pass', verified: 'fail', downgraded: true },
      verification: {
        status: 'rejected',
        schema_valid: true,
        policy_valid: false,
        provenance_confirmed: true,
        rejection_reasons: ['policy: evidence requirement not met', 'VALIDATOR_FAULT_SCHEMA: ajv blew up']
      }
    };
    const json = buildJsonResult(rejected);
    assert.equal(json.status, 'rejected');
    const classes = json.rejection_reasons.map(r => r.class);
    assert.ok(classes.includes('submission-bad'));
    assert.ok(classes.includes('operational'));
    assert.equal(json.rejection_reasons[0].raw, 'policy: evidence requirement not met');
  });
});
