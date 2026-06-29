/**
 * contract-schema-version-gate.test.js
 *
 * F1-CONTRACTS-001 (Wave 2, HIGH) — schema_version VALUE gate.
 *
 * Pre-fix: every contract schema declared `schema_version` as a pattern-only
 * string (`^\d+\.\d+\.\d+$`) — SHAPE, not VALUE — and `verify/index.js`
 * hardcoded the persisted `'1.0.0'` with no lookup. NO validator compared a
 * submission's `schema_version` to a supported set. So a submission declaring
 * `schema_version: '2.0.0'` (or `99.0.0`) validated CLEAN against the live 1.x
 * schema whenever its shape happened to fit — a genuinely-incompatible future
 * major was silently mis-validated instead of cleanly refused.
 *
 * The gate compares the payload's MAJOR against SUPPORTED_SCHEMA_VERSIONS
 * (the single source of truth in `@dogfood-lab/schemas`) and emits a TYPED,
 * prefixed rejection into `verification.rejection_reasons`, routed through the
 * SAME path the schema/policy/steps reasons use (audit-DB ground truth):
 *
 *   - major > supported → `CONTRACT_SCHEMA_TOO_NEW: ...` (operator must upgrade)
 *   - major < floor     → `CONTRACT_SCHEMA_TOO_OLD: ...` (submitter must re-emit)
 *   - in range          → PASS (no patch/minor-delta rejection)
 *
 * Invariant (RED before the gate existed — a future-major submission was
 * accepted-clean; GREEN after):
 *   1. future-major (2.0.0) → CONTRACT_SCHEMA_TOO_NEW in rejection_reasons,
 *      status rejected, schema_valid stays false on the verifier's account
 *      of the version refusal.
 *   2. in-range (1.0.0, and a patch 1.4.2) → NO CONTRACT_SCHEMA_* reason;
 *      pilot-0 still accepts clean.
 *   3. too-old (0.9.0) → CONTRACT_SCHEMA_TOO_OLD in rejection_reasons.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify } from './index.js';
import { stubProvenance } from './validators/provenance.js';
import { SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const POLICIES = resolve(__dirname, '../../policies');

let pilot0;
let globalPolicy;
let repoPolicy;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
  globalPolicy = yaml.load(readFileSync(resolve(POLICIES, 'global-policy.yaml'), 'utf-8'));
  repoPolicy = yaml.load(
    readFileSync(resolve(POLICIES, 'repos/mcp-tool-shop-org/dogfood-labs.yaml'), 'utf-8')
  );
});

const baseOpts = () => ({
  globalPolicy,
  repoPolicy,
  provenance: stubProvenance,
  policyVersion: '1.0.0',
});

describe('F1-CONTRACTS-001 — schema_version VALUE gate (CONTRACT_SCHEMA_* prefixes)', () => {
  it('future-major (2.0.0) is REFUSED with CONTRACT_SCHEMA_TOO_NEW', async () => {
    const future = structuredClone(pilot0);
    future.schema_version = '2.0.0';

    const record = await verify(future, baseOpts());
    const reasons = record.verification.rejection_reasons;

    const tooNew = reasons.find(r => r.startsWith('CONTRACT_SCHEMA_TOO_NEW:'));
    assert.ok(
      tooNew,
      `expected CONTRACT_SCHEMA_TOO_NEW prefix; reasons=${JSON.stringify(reasons)}`
    );
    // Operator-actionable detail: must name the offending version + supported range.
    assert.ok(tooNew.includes('2.0.0'), 'reason must carry the declared version');
    assert.ok(/upgrade/i.test(tooNew), 'TOO_NEW must tell the operator to upgrade testing-os');
    assert.equal(record.verification.status, 'rejected');
  });

  it('too-old major (0.9.0) is REFUSED with CONTRACT_SCHEMA_TOO_OLD', async () => {
    const old = structuredClone(pilot0);
    old.schema_version = '0.9.0';

    const record = await verify(old, baseOpts());
    const reasons = record.verification.rejection_reasons;

    const tooOld = reasons.find(r => r.startsWith('CONTRACT_SCHEMA_TOO_OLD:'));
    assert.ok(
      tooOld,
      `expected CONTRACT_SCHEMA_TOO_OLD prefix; reasons=${JSON.stringify(reasons)}`
    );
    assert.ok(tooOld.includes('0.9.0'), 'reason must carry the declared version');
    assert.ok(/re-emit/i.test(tooOld), 'TOO_OLD must tell the submitter to re-emit');
    assert.equal(record.verification.status, 'rejected');
  });

  it('in-range current (1.0.0) does NOT trip the version gate — pilot-0 accepts clean', async () => {
    const record = await verify(structuredClone(pilot0), baseOpts());
    const reasons = record.verification.rejection_reasons;

    assert.equal(
      reasons.filter(r => r.startsWith('CONTRACT_SCHEMA_')).length,
      0,
      `in-range version must NOT emit a CONTRACT_SCHEMA_* reason; reasons=${JSON.stringify(reasons)}`
    );
    assert.equal(record.verification.status, 'accepted',
      `pilot-0 must still accept clean; reasons=${JSON.stringify(reasons)}`);
  });

  it('in-range patch/minor delta (1.4.2) PASSES the version gate (no patch-delta rejection)', async () => {
    const patched = structuredClone(pilot0);
    patched.schema_version = '1.4.2';

    const record = await verify(patched, baseOpts());
    const reasons = record.verification.rejection_reasons;

    assert.equal(
      reasons.filter(r => r.startsWith('CONTRACT_SCHEMA_')).length,
      0,
      `a same-major patch/minor delta must PASS the gate; reasons=${JSON.stringify(reasons)}`
    );
  });

  it('the gate reason lands greppably in verification.rejection_reasons (audit-DB ground truth)', async () => {
    const future = structuredClone(pilot0);
    future.schema_version = '7.3.1';

    const record = await verify(future, baseOpts());
    // verification.rejection_reasons is the persisted array-of-string field.
    assert.ok(Array.isArray(record.verification.rejection_reasons));
    assert.ok(
      record.verification.rejection_reasons.some(r => /^CONTRACT_SCHEMA_/.test(r)),
      'CONTRACT_SCHEMA_* must be greppable in the persisted rejection_reasons'
    );
  });
});

// ── PROACT-VERIFY-003 — record / recordSubmission version alignment ──
//
// LOW/resilience: index.js stamps the PERSISTED record's schema_version from
// SUPPORTED_SCHEMA_VERSIONS.record.current, but gates the INCOMING submission's
// version against the 'recordSubmission' entry (validateSchemaVersion(...,
// 'recordSubmission')). The two are read from different keys. If a future
// lockstep bump moves one major without the other, the verifier would accept a
// submission at the recordSubmission major yet persist a record stamped with a
// DIFFERENT record major — a silent contract skew across the trust boundary.
//
// Rather than refactor the two reads into one (each is correct at its own call
// site), this assertion pins the two entries to the SAME {minMajor, maxMajor}
// and current major, so an asymmetric bump goes RED here at the seam.

describe('PROACT-VERIFY-003 — record and recordSubmission schema versions stay aligned', () => {
  it('record and recordSubmission share {minMajor, maxMajor} and current major', () => {
    const rec = SUPPORTED_SCHEMA_VERSIONS.record;
    const sub = SUPPORTED_SCHEMA_VERSIONS.recordSubmission;

    assert.ok(rec, 'SUPPORTED_SCHEMA_VERSIONS.record must exist');
    assert.ok(sub, 'SUPPORTED_SCHEMA_VERSIONS.recordSubmission must exist');

    assert.equal(rec.minMajor, sub.minMajor,
      'record.minMajor must equal recordSubmission.minMajor — the gate and the stamp must agree');
    assert.equal(rec.maxMajor, sub.maxMajor,
      'record.maxMajor must equal recordSubmission.maxMajor — the gate and the stamp must agree');

    const recMajor = Number(String(rec.current).split('.')[0]);
    const subMajor = Number(String(sub.current).split('.')[0]);
    assert.equal(recMajor, subMajor,
      'record.current and recordSubmission.current must share the same major — ' +
      'index.js stamps record.current but gates the submission against recordSubmission');
  });
});
