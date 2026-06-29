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
