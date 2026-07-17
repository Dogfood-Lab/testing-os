/**
 * revalidation-cadence-drain-parity.test.mjs — F-780490da (wave 41 amend):
 * cross-domain equivalence between scripts/lib/revalidation-cadence.mjs's
 * isDueForRevalidation (the shared "single definition of overdue," per
 * F-875708f9's own docstring: "the single definition of 'is this dated
 * exemption overdue,' shared across every gate") and
 * packages/dogfood-swarm/lib/roadmap/drain.js's
 * compileGrandfatheredManifestDrain, which independently reimplements the
 * SAME revalidate_by-vs-now comparison inline instead of importing the
 * shared helper (drain.js:102-104, `dueAt.getTime() <= now.getTime()`).
 *
 * PROVEN LIVE at F-780490da's authoring time (dynamic import of both real,
 * unmutated functions, zero repo writes): pinning revalidate_by to TODAY and
 * `now` to noon UTC on that same day, isDueForRevalidation returns false
 * (exclusive of the deadline day — not yet due until the FOLLOWING day)
 * while compileGrandfatheredManifestDrain returns the entry as overdue
 * (inclusive — due from the START of the deadline day). The two mechanisms
 * disagree by a full calendar day at the exact boundary. This file pins
 * that boundary as a live, executable equivalence claim rather than prose.
 *
 * WHY THIS LIVES IN scripts/, NOT packages/dogfood-swarm/: ci-tooling's
 * owned globs are `.github/**`, `scripts/**`, `tsconfig*.json` —
 * drain.js sits under packages/dogfood-swarm/lib/roadmap/**, outside this
 * domain, and this wave's brief scopes the actual comparison-line fix
 * (replacing the inline inclusive comparison with a call to
 * isDueForRevalidation) to the core domain, not ci-tooling. This file
 * imports drain.js READ-ONLY via the workspace path
 * (`@dogfood-lab/dogfood-swarm/lib/roadmap/drain.js`, resolved through the
 * package's existing `"./lib/*"` wildcard export — confirmed live, no
 * packages/dogfood-swarm/package.json edit required) to PROVE the two
 * mechanisms agree, the same way scripts/check-doc-drift.test.mjs and
 * scripts/check-validator-cache-singleton.test.mjs already cross-package
 * import `@dogfood-lab/dogfood-swarm/lib/log-stage.js` and
 * `@dogfood-lab/findings/lib/atomic-write.js` from scripts/. A gate that
 * imports another domain's real code to verify it — rather than trusting
 * that domain's own self-reported suite — is this repo's own
 * EXTERNAL_VERIFIER standard (.claude/rules/workflow-standards.md #6)
 * applied to a same-repo cross-package boundary instead of a cross-model
 * one.
 *
 * SEAM / SEQUENCING (disclosed, not a bug): at the time this file was
 * written, the exact-boundary-day test below is EXPECTED TO FAIL, because
 * drain.js still uses its own inline inclusive comparison. It is expected
 * to start passing once core's F-780490da fix lands in
 * compileGrandfatheredManifestDrain. Note also that
 * packages/dogfood-swarm/lib/roadmap-drain.test.js (core's own file, not
 * this one) currently has a test titled "an entry whose revalidate_by is
 * TODAY (exactly at the boundary) is overdue — inclusive per this file's
 * own date convention" that pins the OPPOSITE boundary answer — core's fix
 * necessarily requires updating that assertion too, in core's own domain;
 * this file does not touch it, and its own suite will self-detect if that
 * update is missed. See swarms/swarm-1784091637-5127/wave-41/ci-tooling/
 * output.json for the full seam note and the "pick" this file encodes:
 * the shared cadence definition should end up living package-side (e.g.
 * packages/dogfood-swarm/lib/revalidation-cadence.js, matching the
 * lib/log-stage.js precedent) with scripts/ consuming it via the workspace
 * path — not the reverse (packages importing repo-root scripts/, which
 * crosses a boundary the workspace was never designed for, per
 * drain.js's own header comment and check-doc-drift.mjs's identical
 * complaint about the relative '../../../../scripts/lib/...' alternative).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isDueForRevalidation } from './lib/revalidation-cadence.mjs';
import { compileGrandfatheredManifestDrain } from '@dogfood-lab/dogfood-swarm/lib/roadmap/drain.js';

function withAllowlistRepoRoot(revalidateBy, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'revalidation-parity-'));
  try {
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'scripts', 'regression-pin-allowlist.json'),
      JSON.stringify({
        allow: { 'F-parity-test': { reason: 'r', file: 'f', owner: 'o', revalidate_by: revalidateBy } },
      }),
    );
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** @pins F-780490da */
test('parity: revalidate_by exactly TODAY — shared helper and drain.js must agree (exclusive: not yet due)', () => {
  const today = '2026-07-17';
  const now = new Date(`${today}T12:00:00Z`); // noon UTC — matches F-780490da's own live-proof methodology

  const sharedAnswer = isDueForRevalidation({ revalidate_by: today }, today);
  assert.equal(
    sharedAnswer, false,
    'sanity: the shared helper itself is exclusive of the deadline day (pinned since F-875708f9, ' +
    'scripts/revalidation-cadence.test.mjs) — if this fails, the shared definition itself regressed, ' +
    'not just drain.js\'s agreement with it.',
  );

  withAllowlistRepoRoot(today, (repoRoot) => {
    const drainResult = compileGrandfatheredManifestDrain(repoRoot, now);
    assert.equal(
      drainResult.overdue.length,
      0,
      "drain.js must NOT treat a revalidate_by of exactly today as overdue — it must agree with the " +
      'shared isDueForRevalidation helper (exclusive of the deadline day), per F-780490da. If this fails, ' +
      "compileGrandfatheredManifestDrain still uses its own inline inclusive comparison " +
      '(dueAt.getTime() <= now.getTime(), drain.js:102-104) instead of the shared definition — ' +
      "see this file's header for the fix location (core domain, not ci-tooling).",
    );
  });
});

/** @pins F-780490da */
test('parity: revalidate_by one day in the PAST — both mechanisms already agree it is overdue (control case)', () => {
  const today = '2026-07-17';
  const now = new Date(`${today}T12:00:00Z`);
  const revalidateBy = '2026-07-16';

  assert.equal(isDueForRevalidation({ revalidate_by: revalidateBy }, today), true);

  withAllowlistRepoRoot(revalidateBy, (repoRoot) => {
    const drainResult = compileGrandfatheredManifestDrain(repoRoot, now);
    assert.equal(
      drainResult.overdue.length, 1,
      'away from the boundary both mechanisms already agree — this control case should pass both ' +
      'before and after F-780490da\'s fix; a failure here means something other than the boundary broke.',
    );
  });
});

/** @pins F-780490da */
test('parity: revalidate_by one day in the FUTURE — both mechanisms already agree it is not yet due (control case)', () => {
  const today = '2026-07-17';
  const now = new Date(`${today}T12:00:00Z`);
  const revalidateBy = '2026-07-18';

  assert.equal(isDueForRevalidation({ revalidate_by: revalidateBy }, today), false);

  withAllowlistRepoRoot(revalidateBy, (repoRoot) => {
    const drainResult = compileGrandfatheredManifestDrain(repoRoot, now);
    assert.equal(
      drainResult.overdue.length, 0,
      'away from the boundary both mechanisms already agree — this control case should pass both ' +
      'before and after F-780490da\'s fix; a failure here means something other than the boundary broke.',
    );
  });
});
