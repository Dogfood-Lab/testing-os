/**
 * f-a85b7e84-latest-claimed-timestamp-type-check.test.js
 *
 * F-a85b7e84 (wave 16, LOW). latestClaimedTimestamp() (verify-chain.js,
 * added by the F-1907b2bc fix — see
 * f-29134790-verify-chain-adoption-boundary.test.js's 'F-1907b2bc' describe
 * block) reads a no-integrity record's OWN claimed
 * timing.finished_at/verification.verified_at and fed it straight to
 * `new Date(value)` after only a falsy check (`if (!value) continue`). JS's
 * Date constructor coerces ANY truthy non-string value through ToPrimitive
 * before parsing:
 *
 *   - `new Date(true)` -> a boolean coerces to the NUMBER 1, treated as an
 *     epoch-millisecond offset -> 1970-01-01T00:00:00.001Z.
 *   - `new Date([2026, 3, 1])` -> Array.prototype.toString() joins with
 *     commas ('2026,3,1'), which the fallback string parser accepts as a
 *     real (if odd) date -> 2026-03-01, well before CHAIN_ADOPTION_DATE.
 *
 * Both are ancient enough to land a no-integrity record in the excused
 * `pre_adoption` bucket with LESS effort than the F-1907b2bc fix's disclosed
 * residual (typing a plausible fake ISO date string) — a bare `true` or a
 * small number is not a forged date at all, just a value `new Date()`
 * happens to coerce into one.
 *
 * The fix: `latestClaimedTimestamp` now requires `typeof value === 'string'`
 * before calling `new Date(value)`, so a non-string timing/verification
 * field is treated identically to an absent one — it falls through to the
 * existing "no readable timestamp" orphan branch (collectOrphanRecords'
 * `claimedAt === null` reason string) instead of being silently coerced into
 * a spurious ancient date.
 *
 * Every fixture here is written DIRECTLY to its sharded path (bypassing
 * persist.js's writeRecord/computeRecordPath) because computeRecordPath
 * requires a genuinely parseable timing.finished_at to shard the file in the
 * first place — exactly the property these fixtures must NOT have, and
 * exactly the "dropped straight onto disk" shape the F-1907b2bc/F-a85b7e84
 * boundary exists to police (see verify-chain.js's top-of-file threat
 * model). Same pattern as the sibling file's "no readable timing/
 * verification timestamp at all" test.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyChain, CHAIN_ADOPTION_DATE } from './verify-chain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__f_a85b7e84_test__');

function setup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * Write a record straight to its sharded path with NO integrity block and NO
 * ledger append — a record dropped directly onto disk, not through
 * writeRecord(). `extra` is merged onto a minimal base shape.
 */
function writeRawRecord(runId, extra = {}) {
  const path = resolve(TEST_ROOT, 'records', 'dogfood-lab', 'testing-os', '2026', '01', '01', `run-${runId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const record = { run_id: runId, repo: 'dogfood-lab/testing-os', ...extra };
  assert.equal(record.integrity, undefined, 'fixture must not carry an integrity block');
  writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
  return path;
}

describe('F-a85b7e84 — latestClaimedTimestamp rejects non-string values before Date coercion', () => {
  const nonStringCoercions = [
    ['boolean-true', true, 'boolean `true` (Date coerces to the number 1)'],
    ['number', 123, 'a bare number (treated as an epoch-millisecond offset)'],
    ['plain-object', {}, 'a plain object (correctly already fell through to NaN pre-fix — kept as a contrast pin)'],
    ['array', [2026, 3, 1], 'an array (Date fallback-parses its comma-joined toString() into a pre-cutoff date)'],
  ];

  for (const [slug, value, label] of nonStringCoercions) {
    it(`CORE PIN: timing.finished_at as ${label} is a genuine orphan, not pre_adoption`, () => {
      setup();
      writeRawRecord(`nonstring-${slug}`, { timing: { finished_at: value } });

      const result = verifyChain(TEST_ROOT, { collectOrphans: true });

      assert.equal(result.ok, false, 'a non-string timing field must not be silently excused into ok:true');
      assert.equal(result.pre_adoption.length, 0, `must NOT land in pre_adoption, got ${JSON.stringify(result.pre_adoption)}`);
      assert.equal(result.orphans.length, 1, `expected exactly one genuine orphan, got ${JSON.stringify(result.orphans)}`);
      assert.equal(result.orphans[0].run_id, `nonstring-${slug}`);
      assert.ok(!/predates the integrity chain/.test(result.orphans[0].reason),
        `must not claim to predate the chain, got: ${result.orphans[0].reason}`);
    });
  }

  it('CORE PIN: timing.finished_at is null (falsy — matches the pre-fix skip path) is a genuine orphan', () => {
    setup();
    writeRawRecord('null-finished-at', { timing: { finished_at: null } });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false);
    assert.equal(result.pre_adoption.length, 0);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].run_id, 'null-finished-at');
  });

  it('CORE PIN: timing.finished_at entirely absent (no timing block, no verification block) is a genuine orphan', () => {
    setup();
    writeRawRecord('missing-timing-block', {});

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false);
    assert.equal(result.pre_adoption.length, 0);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].run_id, 'missing-timing-block');
  });

  it('the type check guards BOTH candidate fields: a non-string verification.verified_at alone is also a genuine orphan', () => {
    setup();
    writeRawRecord('nonstring-verified-at', { verification: { verified_at: true } });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false);
    assert.equal(result.pre_adoption.length, 0);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].run_id, 'nonstring-verified-at');
  });

  it('REGRESSION: a real ISO string before CHAIN_ADOPTION_DATE still buckets pre_adoption', () => {
    setup();
    const before = new Date(CHAIN_ADOPTION_DATE.getTime() - 24 * 60 * 60 * 1000).toISOString();
    writeRawRecord('real-iso-before-cutoff', { timing: { finished_at: before } });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, true, 'a genuinely pre-adoption record must still be excused from ok');
    assert.equal(result.pre_adoption.length, 1, `expected the real ISO string to still bucket pre_adoption, got ${JSON.stringify(result.pre_adoption)}`);
    assert.equal(result.pre_adoption[0].run_id, 'real-iso-before-cutoff');
    assert.equal(result.orphans.length, 0);
  });

  it('REGRESSION: a real ISO string on/after CHAIN_ADOPTION_DATE is still a genuine orphan', () => {
    setup();
    const after = new Date(CHAIN_ADOPTION_DATE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    writeRawRecord('real-iso-after-cutoff', { timing: { finished_at: after } });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false);
    assert.equal(result.pre_adoption.length, 0);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].run_id, 'real-iso-after-cutoff');
  });
});
