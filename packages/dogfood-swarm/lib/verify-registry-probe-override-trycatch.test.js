/**
 * verify-registry-probe-override-trycatch.test.js — F-6a1138b4: the registry's
 * two callers of the identical `adapter.probe(repoPath)` contract had
 * asymmetric fault tolerance. `probeAll` (the auto-detect path, used whenever
 * an operator does not pass --adapter) wraps every adapter's probe() in
 * try/catch and degrades a throw to a clean `{score: 0, reason}`.
 * `selectAdapter`'s explicit-override branch (used whenever an operator DOES
 * pass --adapter=<name>) called `adapter.probe(repoPath)` directly with no
 * try/catch at all — a throw propagated raw and uncaught.
 *
 * Not reachable via any of the three shipped adapters today (each already
 * guards its own throwing operation internally — see rust.js/python.js's
 * DS-PROAC-02 hardening) — this pins the STRUCTURAL fix for the next adapter
 * that doesn't: the override branch now degrades identically to probeAll,
 * naming the adapter so the failure is actionable instead of a raw,
 * unattributed throw.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { selectAdapter, probeAll, ADAPTERS } from './verify/registry.js';

const THROWING_NAME = 'f-6a1138b4-scratch-throwing-adapter';

afterEach(() => {
  ADAPTERS.delete(THROWING_NAME);
});

describe('registry.js — selectAdapter override branch matches probeAll\'s fault tolerance (F-6a1138b4)', () => {
  it('probeAll degrades a throwing probe() to {score: 0, reason} — the existing, correct behavior (regression control)', () => {
    ADAPTERS.set(THROWING_NAME, { probe: () => { throw new Error('manifest read exploded'); } });
    const ranked = probeAll('/any/path');
    const mine = ranked.find(r => r.name === THROWING_NAME);
    assert.equal(mine.score, 0);
    assert.match(mine.reason, /Probe error: manifest read exploded/);
  });

  /** @pins F-6a1138b4 */
  it('selectAdapter(repoPath, override) wraps a throwing probe() into a clear, attributed error instead of propagating it raw', () => {
    ADAPTERS.set(THROWING_NAME, { probe: () => { throw new Error('manifest read exploded'); } });
    assert.throws(
      () => selectAdapter('/any/path', THROWING_NAME),
      (err) => {
        assert.match(err.message, new RegExp(`Adapter '${THROWING_NAME}' probe failed: manifest read exploded`));
        return true;
      },
    );
  });

  it('GATE (mutation control): a NON-throwing override probe still returns normally (the fix must not swallow a real result)', () => {
    ADAPTERS.set(THROWING_NAME, { probe: () => ({ score: 42, reason: 'looks fine', evidence: { x: 1 } }) });
    const selection = selectAdapter('/any/path', THROWING_NAME);
    assert.equal(selection.name, THROWING_NAME);
    assert.equal(selection.probe.score, 42);
    assert.equal(selection.probe.reason, 'looks fine');
  });

  it('an unknown override name still throws its own distinct, pre-existing error (unaffected by this fix)', () => {
    assert.throws(
      () => selectAdapter('/any/path', 'no-such-adapter-at-all'),
      /Unknown adapter: "no-such-adapter-at-all"/,
    );
  });
});
