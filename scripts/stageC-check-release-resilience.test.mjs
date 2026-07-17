/**
 * Stage C amend-wave regression guards for .github/workflows/release.yml
 * (PB-CI-001 idempotent/resilient publish, PB-CI-002 per-package version guard).
 *
 * Why this file exists:
 *
 * PB-CI-001 — the publish step was a single `npm publish --workspaces`. A
 * re-fire after a PARTIAL publish (network blip / npm 5xx between two
 * packages) is NOT a clean no-op: npm errors `EPUBLISHCONFLICT` on the
 * already-live package and the whole step exits non-zero, masking which
 * packages still need publishing. The amended step iterates the publishable
 * workspaces, skips any version already live (`npm view <name>@<version>`),
 * and wraps each publish in a short retry-with-backoff (mirroring ingest.yml's
 * push loop). `npm publish` is IRREVERSIBLE, so workflow-standards
 * NAMED_COMPENSATORS forbids a skip — a compensators note with a named owner
 * must be present in the workflow.
 *
 * PB-CI-002 — the existing "Verify tag matches root package.json" gate only
 * checks the ROOT version. Lockstep versioning means a stray per-package
 * version drift (a botched bump) would publish a wrong version with a green
 * workflow. The amended workflow asserts every publishable packages/&#42;/
 * package.json version equals TAG_VERSION and `::error::`s otherwise — at
 * release time, not depending on a guard in ci.yml (which does not trigger on
 * tag pushes).
 *
 * Why text-token assertions and not a YAML parse: same rationale as
 * stageA-check-ci-honesty-paths.test.mjs — parsing YAML in a regression test
 * pulls a dependency in for one fixture. We assert the resilience primitives
 * are present in the workflow text. This goes RED if a future edit drops the
 * existence check, the retry loop, the per-package version guard, or the
 * compensators note.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const releasePath = resolve(repoRoot, '.github/workflows/release.yml');

test('release.yml exists', () => {
  assert.ok(existsSync(releasePath), `expected workflow at ${releasePath}`);
});

test('PB-CI-001: publish step checks each package is not already live before publishing', () => {
  const text = readFileSync(releasePath, 'utf8');
  // Per-package existence check via `npm view <name>@<version>` so a re-fire
  // after a partial publish is a clean no-op for already-live packages.
  assert.match(
    text,
    /npm view\s/,
    'release.yml publish step must run `npm view <name>@<version>` per package so a re-fire skips already-live packages (PB-CI-001 idempotency).',
  );
});

test('PB-CI-001: publish step retries each publish with backoff on transient failure', () => {
  const text = readFileSync(releasePath, 'utf8');
  // A retry loop over publish attempts (mirrors ingest.yml push loop).
  assert.match(
    text,
    /for attempt in/,
    'release.yml publish step must wrap each `npm publish` in a retry-with-backoff loop (PB-CI-001 resilience, mirroring ingest.yml).',
  );
  assert.match(
    text,
    /sleep\s/,
    'release.yml publish retry must back off (sleep) between attempts (PB-CI-001).',
  );
  // The publish itself must still run per-workspace with provenance.
  assert.match(
    text,
    /npm publish[^\n]*-w /,
    'release.yml must publish per workspace (`npm publish ... -w <name>`) so each package is published individually and skip/retry is per-package (PB-CI-001).',
  );
  assert.match(
    text,
    /--provenance/,
    'release.yml publish must keep --provenance (OIDC trusted publishing contract).',
  );
});

test('PB-CI-001: a named-compensator note for the irreversible publish is present (NAMED_COMPENSATORS — no skip allowed)', () => {
  const text = readFileSync(releasePath, 'utf8');
  // workflow-standards: every irreversible tool call needs a named undo +
  // owner. `npm publish` cannot be un-published; the note states the manual
  // recovery path and who owns it.
  assert.match(
    text,
    /npm deprecate/,
    'release.yml must carry a compensators note: `npm publish` has no automated undo; recovery is `npm deprecate` / manual finish (workflow-standards NAMED_COMPENSATORS).',
  );
  assert.match(
    text,
    /[Cc]ompensator|[Rr]ecovery/,
    'release.yml must label the publish compensator/recovery note so an operator finds it (workflow-standards NAMED_COMPENSATORS).',
  );
  assert.match(
    text,
    /[Oo]wner/,
    'the publish compensators note must name an owner (workflow-standards NAMED_COMPENSATORS forbids skip).',
  );
});

test('F-60f0c4f5 pin (F-32c517c4): release concurrency group normalizes BOTH trigger forms to the same bare-tag group', () => {
  const text = readFileSync(releasePath, 'utf8');
  const jobsIdx = text.indexOf('\njobs:');
  const concIdx = text.indexOf('concurrency:');
  assert.ok(concIdx >= 0 && jobsIdx > concIdx, 'release.yml must declare a workflow-level concurrency block before jobs:');
  const conc = text.slice(concIdx, jobsIdx);
  // The group must derive from `github.event.inputs.tag || github.ref_name`.
  // `github.ref` is `refs/tags/v1.8.0` on a tag push while the dispatch input
  // is `v1.8.0` — different groups, so a manual re-fire mid-publish races the
  // npm-view/npm-publish and gh-release check-then-act pairs (the exact defect
  // F-60f0c4f5 closed). A revert to `github.ref` must go RED here.
  const groupMatch = /group:\s*release-\$\{\{\s*(.+?)\s*\}\}/.exec(conc);
  assert.ok(
    groupMatch,
    'release.yml concurrency group must be `release-${{ github.event.inputs.tag || github.ref_name }}` (F-60f0c4f5 same-tag serialization)',
  );
  assert.equal(
    groupMatch[1],
    'github.event.inputs.tag || github.ref_name',
    'the concurrency group expression must normalize to the BARE tag on both triggers (github.ref would put the same tag in two different groups — F-60f0c4f5)',
  );
  // Prove the normalization: evaluate the expression under both trigger
  // contexts and assert the group string is identical.
  const evalExpr = (ctx) => groupMatch[1]
    .split('||')
    .map((s) => s.trim().split('.').reduce((o, p) => (o == null ? o : o[p]), ctx))
    .find((v) => v) ?? '';
  const tagPush = evalExpr({ github: { event: { inputs: {} }, ref_name: 'v9.9.9', ref: 'refs/tags/v9.9.9' } });
  const dispatch = evalExpr({ github: { event: { inputs: { tag: 'v9.9.9' } }, ref_name: 'main', ref: 'refs/heads/main' } });
  assert.equal(tagPush, 'v9.9.9', 'a tag push must resolve the group to the bare tag');
  assert.equal(tagPush, dispatch, 'tag-push and workflow_dispatch runs for the SAME tag must land in the SAME concurrency group');
  assert.match(
    conc,
    /cancel-in-progress:\s*false/,
    'release concurrency must NOT cancel in progress — cancelling a mid-publish run strands a partial npm publish (F-60f0c4f5)',
  );
});

test('PB-CI-002: a per-package version guard asserts each publishable package version equals TAG_VERSION', () => {
  const text = readFileSync(releasePath, 'utf8');
  // The guard must read EACH publishable packages/*/package.json (not only the
  // root) and ::error:: on any mismatch with TAG_VERSION.
  assert.match(
    text,
    /packages\/\*\/package\.json|packages\/[^\n]*package\.json/,
    'release.yml must add a guard reading each packages/*/package.json version (PB-CI-002), not only the root package.json.',
  );
  // The guard fires a GitHub error annotation on mismatch.
  assert.match(
    text,
    /::error::[^\n]*version|version[^\n]*::error::/i,
    'release.yml per-package version guard must emit a ::error:: naming the drifted package version (PB-CI-002).',
  );
});

test('F-c0348ff6: the npm-OIDC sandbox install pins an EXACT npm version with --ignore-scripts (never npm@latest)', () => {
  // This publish job is the only one in the repo holding `id-token: write`
  // (npm OIDC trusted publishing) alongside `contents: write`. An unpinned
  // `npm@latest` install resolves whatever npm + transitive tree is newest
  // at install time — no lockfile, no integrity pin — so any package in that
  // tree could run lifecycle scripts inside a job that can mint an OIDC
  // token and push to the repo. The exact-version pin closes the "newest at
  // install time" half; --ignore-scripts closes the "arbitrary code from the
  // install itself" half. Mirrors the pa11y exact-version pin in pages.yml,
  // which the repo already applies to a cosmetic a11y check — the publish
  // job gets the same discipline for a job that can push + publish.
  const text = readFileSync(releasePath, 'utf8');
  // Scope to actual (non-comment) lines: the step's own header comment
  // legitimately narrates the AVOIDED approach in prose ("the sandbox
  // install below shadows the system npm with npm@latest", "In-place `npm
  // install -g npm@latest` ... races") to explain why the sandbox exists at
  // all — a whole-text ban on the substring "npm@latest" false-positives on
  // that prose. Only a real, executable line matters here.
  const offendingLines = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return false;
    return /npm@latest/.test(trimmed);
  });
  assert.deepEqual(
    offendingLines,
    [],
    `the sandbox install must never resolve npm@latest in a REAL (non-comment) line — no lockfile, no integrity pin, inside the one job with id-token: write (F-c0348ff6). Offending line(s):\n${offendingLines.join('\n')}`,
  );
  assert.match(
    text,
    /npm install[^\n]*--ignore-scripts npm@\d+\.\d+\.\d+/,
    'the sandbox install must pin an EXACT npm version (npm@X.Y.Z) with --ignore-scripts on the SAME line (F-c0348ff6)',
  );
});

/** @pins F-d7fb76ae */
test('F-d7fb76ae: the OIDC-sandbox npm install retries with backoff on transient failure, mirroring the publish loop below it', () => {
  const text = readFileSync(releasePath, 'utf8');
  // This was the ONE network call in this file (and its sibling workflows —
  // ci.yml's lockfile-drift gate, pages.yml's deploy-verify/pa11y loops) with
  // zero resilience discipline: a hard prerequisite for the entire publish,
  // first step in the job, no retry. Scope the assertions to this step's own
  // block so a retry loop added to some OTHER step doesn't false-pass this.
  const stepIdx = text.indexOf('Install npm >=11.5 in sandbox for OIDC trusted publishing');
  assert.ok(stepIdx > 0, 'expected to find the OIDC-sandbox npm install step');
  const nextStepIdx = text.indexOf('\n      - name:', stepIdx + 1);
  const stepBlock = text.slice(stepIdx, nextStepIdx > 0 ? nextStepIdx : text.length);

  assert.match(
    stepBlock,
    /for attempt in 1 2 3/,
    'the OIDC-sandbox npm install must retry across 3 attempts (F-d7fb76ae), mirroring the publish loop a few steps below (PB-CI-001).',
  );
  assert.match(
    stepBlock,
    /sleep\s/,
    'the OIDC-sandbox install retry must back off (sleep) between attempts (F-d7fb76ae).',
  );
  assert.match(
    stepBlock,
    /::warning::/,
    'a failed attempt must annotate with ::warning:: so an operator can see WHICH attempt failed, not just a final pass/fail (F-d7fb76ae).',
  );
  assert.match(
    stepBlock,
    /::error::/,
    'exhausting all 3 attempts must annotate with ::error:: naming that nothing has published yet (F-d7fb76ae).',
  );
  // The retry wrap must not have loosened the F-c0348ff6 exact-version /
  // --ignore-scripts discipline — same assertion as the test above, scoped
  // to inside the retry loop specifically.
  assert.match(
    stepBlock,
    /npm install[^\n]*--ignore-scripts npm@\d+\.\d+\.\d+/,
    'the retried install must still pin an EXACT npm version with --ignore-scripts (F-c0348ff6 must survive the F-d7fb76ae retry wrap).',
  );
});
