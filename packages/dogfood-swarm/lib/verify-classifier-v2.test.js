/**
 * verify-classifier-v2.test.js — W3-BACK-001
 *
 * v2 classifier base. Each test exercises exactly one decision branch in
 * classifyFindingV2() so a regression names which path broke.
 *
 * Coverage:
 *   1. Anchor-only path — legacy v1 behavior preserved (verified, regressed,
 *      claimed-but-still-present, unverifiable file-missing/no-anchor).
 *   2. Cross_ref path — Class #14b core. Primary anchor present, consumer
 *      fix landed at cross_ref → verified_via='cross_ref'.
 *   3. Allowlist path — coordinator_resolved=true with evidence string.
 *   4. Agent attestation path — finding carries structured attestation.
 *   5. Unverifiable cross_ref — file or anchor missing on cross_ref side.
 *   6. Vantage-point disclosure — every classification carries a non-null
 *      verified_via in the canonical enum.
 *   7. Envelope shape — buildV2Delta produces the Pattern #8 shared shape
 *      including verified_via_distribution, exit-code 3-way, and verb tag.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyFindingV2,
  buildV2Delta,
  VERIFIED_VIA,
} from './verify-classifier-v2.js';

const REPO = join(tmpdir(), 'verify-classifier-v2-test-repo');

function fakeReader(table, repoRoot) {
  const resolved = new Map();
  for (const [k, v] of Object.entries(table)) {
    resolved.set(resolve(repoRoot, k), v);
  }
  return (absPath) => (resolved.has(absPath) ? resolved.get(absPath) : null);
}

function mkFinding(overrides = {}) {
  return {
    finding_id: 'F-001',
    fingerprint: 'fp-F-001',
    severity: 'HIGH',
    category: 'bug',
    file_path: 'src/a.js',
    line_number: 42,
    symbol: 'doThing',
    description: 'doThing leaks memory',
    recommendation: 'free the buffer',
    last_seen_wave: 3,
    fixed_wave_id: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Anchor-only path — v1 parity
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFindingV2 — anchor-only (v1 parity)', () => {
  it('verified when anchor is gone from the bucket', () => {
    const f = mkFinding({ symbol: 'doThing', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
    assert.match(r.evidence, /no longer present/);
  });

  it('claimed-but-still-present at exact recorded line', () => {
    const f = mkFinding({ symbol: 'doThing', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[41] = 'function doThing() {}';
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'claimed-but-still-present');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('regressed when anchor reappears within bucket but outside ±2 tolerance', () => {
    const f = mkFinding({ symbol: 'doThing', line_number: 41 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[47] = 'function doThing() {}';
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'regressed');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('unverifiable when file_path is missing from the row', () => {
    const f = mkFinding({ file_path: null });
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({}, REPO) });
    assert.equal(r.classification, 'unverifiable');
    assert.equal(r.verified_via, VERIFIED_VIA.UNVERIFIABLE);
    assert.match(r.evidence, /no file_path/);
  });

  it('unverifiable when file is gone from disk', () => {
    const f = mkFinding({ symbol: 'doThing' });
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({}, REPO) });
    assert.equal(r.classification, 'unverifiable');
    assert.equal(r.verified_via, VERIFIED_VIA.UNVERIFIABLE);
    assert.match(r.evidence, /not present|deleted|moved|unreadable/);
  });

  it('unverifiable when no symbol and no description anchor', () => {
    const f = mkFinding({ symbol: '', description: 'a b c' });
    const file = Array.from({ length: 10 }, () => 'noise');
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'unverifiable');
    assert.equal(r.verified_via, VERIFIED_VIA.UNVERIFIABLE);
  });

  it('description fallback anchor matches a 4+ char identifier', () => {
    const f = mkFinding({
      symbol: '',
      description: 'memoryLeak in buffer logic',
      line_number: 5,
    });
    const file = ['', 'noise', 'noise', 'noise', 'function memoryLeak() {}', 'noise'];
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'claimed-but-still-present');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Cross_ref path — Class #14b core
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFindingV2 — cross_ref (Class #14b)', () => {
  it('overrides claimed-but-still-present when the consumer fix landed', () => {
    // Primary file: doThing is still at line 42 (anchor would say "claimed").
    // Consumer file: validateRecord guards against doThing — fix landed.
    const primary = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    primary[41] = 'function doThing() {}';
    const consumer = Array.from({ length: 200 }, (_, i) => `// consumer line ${i + 1}`);
    consumer[129] = 'function validateRecord() { /* guards doThing */ }'; // line 130

    const f = mkFinding({
      symbol: 'doThing',
      line_number: 42,
      cross_ref: {
        file: 'packages/ingest/persist.js',
        symbol: 'validateRecord',
        line: 131,
      },
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({
        'src/a.js': primary,
        'packages/ingest/persist.js': consumer,
      }, REPO),
    });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.CROSS_REF);
    assert.match(r.evidence, /validateRecord/);
    assert.deepEqual(r.cross_ref, f.cross_ref);
  });

  it('does NOT override regressed verdict (regression is real signal)', () => {
    // Primary anchor reappears within bucket but at different line —
    // regressed. Even if cross_ref shows the consumer fix, the anchor's
    // movement is a real signal we want to preserve.
    const primary = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    primary[47] = 'function doThing() {}';
    const consumer = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`);
    consumer[129] = 'function validateRecord() {}';

    const f = mkFinding({
      symbol: 'doThing',
      line_number: 41,
      cross_ref: { file: 'packages/ingest/persist.js', symbol: 'validateRecord', line: 131 },
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({
        'src/a.js': primary,
        'packages/ingest/persist.js': consumer,
      }, REPO),
    });
    assert.equal(r.classification, 'regressed');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('cross_ref rescues an anchor-unverifiable when consumer fix is present', () => {
    // Primary file is gone, but cross_ref consumer-side anchor is present.
    const consumer = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`);
    consumer[129] = 'function validateRecord() {}';
    const f = mkFinding({
      file_path: 'src/missing.js',
      symbol: 'doThing',
      line_number: 42,
      cross_ref: { file: 'packages/ingest/persist.js', symbol: 'validateRecord', line: 131 },
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({
        'packages/ingest/persist.js': consumer,
      }, REPO),
    });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.CROSS_REF);
  });

  it('falls through to anchor when cross_ref consumer file is missing', () => {
    const primary = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    primary[41] = 'function doThing() {}';
    const f = mkFinding({
      symbol: 'doThing',
      line_number: 42,
      cross_ref: { file: 'packages/ingest/missing.js', symbol: 'validateRecord', line: 131 },
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({ 'src/a.js': primary }, REPO),
    });
    // Primary anchor still says claimed-but-still-present; cross_ref couldn't
    // verify a consumer fix, so we keep the anchor verdict.
    assert.equal(r.classification, 'claimed-but-still-present');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
    // Original cross_ref preserved on the entry for downstream operator review.
    assert.deepEqual(r.cross_ref, f.cross_ref);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Allowlist path — coordinator-resolved
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFindingV2 — allowlist (coordinator_resolved)', () => {
  it('verified_via=allowlist with evidence when coordinator_resolved=true', () => {
    const f = mkFinding({
      coordinator_resolved: true,
      verified_via_evidence: 'design doc rewrite landed in PR #1234',
    });
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({}, REPO) });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.ALLOWLIST);
    assert.match(r.evidence, /coordinator-resolved/);
    assert.match(r.evidence, /design doc rewrite/);
  });

  it('allowlist applies even if anchor would have said claimed-but-still-present', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[41] = 'function doThing() {}';
    const f = mkFinding({
      symbol: 'doThing',
      line_number: 42,
      coordinator_resolved: true,
      verified_via_evidence: 'doThing now legitimate after refactor',
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.ALLOWLIST);
  });

  it('allowlist with no evidence still classifies but flags the gap', () => {
    const f = mkFinding({ coordinator_resolved: true });
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({}, REPO) });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.ALLOWLIST);
    assert.match(r.evidence, /no evidence string supplied/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Agent attestation path
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFindingV2 — agent_attestation', () => {
  it('verified_via=agent_attestation when finding carries structured attestation', () => {
    const f = mkFinding({
      agent_attestation: { summary: 'feature ripped out; doc-only finding', proof_id: 'PR-2026' },
    });
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({}, REPO) });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.AGENT_ATTESTATION);
    assert.match(r.evidence, /agent attestation/);
    assert.match(r.evidence, /feature ripped out/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Vantage-point disclosure invariant
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFindingV2 — vantage-point disclosure', () => {
  it('every classification carries a non-null verified_via in the canonical enum', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const fixtures = [
      mkFinding({ finding_id: 'F-V', symbol: 'gone', line_number: 42 }),
      mkFinding({ finding_id: 'F-U', file_path: 'src/missing.js' }),
      mkFinding({ finding_id: 'F-A', coordinator_resolved: true, verified_via_evidence: 'x' }),
      mkFinding({ finding_id: 'F-AT', agent_attestation: { summary: 'x' } }),
    ];
    const reader = fakeReader({ 'src/a.js': file }, REPO);
    const validValues = new Set(Object.values(VERIFIED_VIA));
    for (const f of fixtures) {
      const r = classifyFindingV2(f, REPO, { readLines: reader });
      assert.ok(r.verified_via, `verified_via missing for ${f.finding_id}`);
      assert.ok(
        validValues.has(r.verified_via),
        `verified_via='${r.verified_via}' for ${f.finding_id} not in canonical enum`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. buildV2Delta — Pattern #8 envelope
// ═══════════════════════════════════════════════════════════════════════

describe('buildV2Delta — Pattern #8 envelope', () => {
  it('produces shared envelope shape with schema, verb, verified_via_distribution', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const findings = [
      mkFinding({ finding_id: 'F-1', symbol: 'gone', line_number: 42 }),
    ];
    const delta = buildV2Delta({
      verb: 'verify-fixed',
      schema: 'verify-fixed-delta/v2',
      runId: 'r1',
      waveNumber: 5,
      findings,
      repoRoot: REPO,
      threshold: 0,
      readLines: fakeReader({ 'src/a.js': file }, REPO),
      now: () => '2026-04-27T00:00:00.000Z',
    });
    assert.equal(delta.schema, 'verify-fixed-delta/v2');
    assert.equal(delta.verb, 'verify-fixed');
    assert.equal(delta.runId, 'r1');
    assert.equal(delta.waveNumber, 5);
    assert.equal(delta.checkedAt, '2026-04-27T00:00:00.000Z');
    assert.equal(delta.summary.total, 1);
    assert.equal(delta.summary.verified, 1);
    assert.ok(delta.summary.verified_via_distribution, 'verified_via_distribution must exist');
    assert.equal(delta.summary.verified_via_distribution.anchor, 1);
    assert.equal(delta.summary.verified_via_distribution.cross_ref, 0);
    assert.equal(delta.exitCode, 0);
    assert.equal(delta.findings.length, 1);
    assert.equal(delta.findings[0].verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('counts verified_via_distribution across all paths', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const consumer = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`);
    consumer[129] = 'function validateRecord() {}';
    const claimedFile = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    claimedFile[41] = 'function doThing() {}';

    const findings = [
      mkFinding({ finding_id: 'F-A', symbol: 'gone', line_number: 42 }),  // anchor verified
      mkFinding({
        finding_id: 'F-X',
        file_path: 'src/claimed.js',
        symbol: 'doThing',
        line_number: 42,
        cross_ref: { file: 'packages/ingest/persist.js', symbol: 'validateRecord', line: 131 },
      }), // cross_ref verified
      mkFinding({
        finding_id: 'F-L',
        coordinator_resolved: true,
        verified_via_evidence: 'cleared by review',
      }), // allowlist
      mkFinding({
        finding_id: 'F-T',
        agent_attestation: { summary: 'doc-only' },
      }), // agent_attestation
      mkFinding({
        finding_id: 'F-U',
        file_path: 'src/gone.js',
      }), // unverifiable
    ];
    const delta = buildV2Delta({
      verb: 'verify-fixed',
      schema: 'verify-fixed-delta/v2',
      runId: 'r1',
      waveNumber: 5,
      findings,
      repoRoot: REPO,
      threshold: 0,
      readLines: fakeReader({
        'src/a.js': file,
        'src/claimed.js': claimedFile,
        'packages/ingest/persist.js': consumer,
      }, REPO),
    });
    const dist = delta.summary.verified_via_distribution;
    assert.equal(dist.anchor, 1, 'one anchor verdict');
    assert.equal(dist.cross_ref, 1, 'one cross_ref verdict');
    assert.equal(dist.allowlist, 1, 'one allowlist verdict');
    assert.equal(dist.agent_attestation, 1, 'one agent_attestation verdict');
    assert.equal(dist.unverifiable, 1, 'one unverifiable verdict');
  });

  it('exit-code 3-way: 0 when empty', () => {
    const delta = buildV2Delta({
      verb: 'verify-fixed', schema: 'x/v2',
      runId: 'r1', waveNumber: 1, findings: [], repoRoot: REPO,
      readLines: fakeReader({}, REPO),
    });
    assert.equal(delta.exitCode, 0);
  });

  it('exit-code 3-way: 1 when threshold exceeded', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[41] = 'function doThing() {}';
    const delta = buildV2Delta({
      verb: 'verify-fixed', schema: 'x/v2',
      runId: 'r1', waveNumber: 1,
      findings: [mkFinding({ symbol: 'doThing', line_number: 42 })],
      repoRoot: REPO, threshold: 0,
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(delta.exitCode, 1);
    assert.equal(delta.thresholdExceeded, true);
  });

  it('exit-code 3-way: 2 when ALL findings unverifiable (pipeline broken)', () => {
    const delta = buildV2Delta({
      verb: 'verify-fixed', schema: 'x/v2',
      runId: 'r1', waveNumber: 1,
      findings: [
        mkFinding({ finding_id: 'F-1', file_path: 'src/missing-1.js' }),
        mkFinding({ finding_id: 'F-2', file_path: 'src/missing-2.js' }),
      ],
      repoRoot: REPO, threshold: 0,
      readLines: fakeReader({}, REPO),
    });
    assert.equal(delta.exitCode, 2);
  });

  it('entryDecorator hook attaches verb_specifics to each entry', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const findings = [mkFinding({ finding_id: 'F-1', symbol: 'gone' })];
    const delta = buildV2Delta({
      verb: 'verify-recurring',
      schema: 'verify-recurring-delta/v1',
      runId: 'r1',
      waveNumber: 1,
      findings,
      repoRoot: REPO,
      threshold: 0,
      readLines: fakeReader({ 'src/a.js': file }, REPO),
      entryDecorator: (raw) => ({ recurrence_count: raw.recurrence_count || 1 }),
    });
    assert.equal(delta.verb, 'verify-recurring');
    assert.ok(delta.findings[0].verb_specifics);
    assert.equal(delta.findings[0].verb_specifics.recurrence_count, 1);
  });

  it('cross_ref preserved on entry when finding had one but anchor verdict was used', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const findings = [
      mkFinding({
        symbol: 'gone',  // anchor verified
        line_number: 42,
        cross_ref: { file: 'packages/ingest/persist.js', symbol: 'x', line: 1 },
      }),
    ];
    const delta = buildV2Delta({
      verb: 'verify-fixed', schema: 'x/v2',
      runId: 'r1', waveNumber: 1,
      findings, repoRoot: REPO,
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(delta.findings[0].verified_via, VERIFIED_VIA.ANCHOR);
    // cross_ref preserved on the entry for operator review even though the
    // anchor decided the verdict.
    assert.deepEqual(
      delta.findings[0].cross_ref,
      { file: 'packages/ingest/persist.js', symbol: 'x', line: 1 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFindingV2 — edge cases', () => {
  it('cross_ref present but file missing → still falls back, original cross_ref kept', () => {
    const f = mkFinding({
      file_path: 'src/missing.js',
      symbol: 'doThing',
      cross_ref: { file: 'packages/ingest/missing-too.js', symbol: 'x', line: 1 },
    });
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({}, REPO) });
    assert.equal(r.classification, 'unverifiable');
    assert.equal(r.verified_via, VERIFIED_VIA.UNVERIFIABLE);
    assert.deepEqual(r.cross_ref, f.cross_ref);
    // Evidence concatenates anchor + cross_ref reasons for operator clarity.
    assert.match(r.evidence, /not present/);
  });

  it('cross_ref with no symbol or description → classifyByCrossRef returns unverifiable', () => {
    const primary = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    primary[41] = 'function doThing() {}';
    const consumer = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`);
    const f = mkFinding({
      symbol: 'doThing',
      line_number: 42,
      cross_ref: { file: 'packages/ingest/persist.js' }, // no symbol/description
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({
        'src/a.js': primary,
        'packages/ingest/persist.js': consumer,
      }, REPO),
    });
    // Cross_ref unusable, anchor verdict stands.
    assert.equal(r.classification, 'claimed-but-still-present');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('coordinator_resolved set to non-true value is NOT treated as allowlist', () => {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    const f = mkFinding({
      symbol: 'gone',
      coordinator_resolved: 'yes',  // truthy but not === true
    });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    // Strict equality required for safety; goes through anchor path.
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });
});
