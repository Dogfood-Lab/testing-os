/**
 * Regression test for the lockfile-drift CI gate humanization (Stage C
 * Wave A2 D4B-001 + D4B-002).
 *
 * Why this file is separate from scripts/check-lockfile-drift.test.mjs:
 *   check-lockfile-drift.test.mjs asserts the LOCKFILE itself stays
 *   internally consistent (workspace versions, engines.node), which `npm
 *   install` heals operationally. This file asserts the CI WORKFLOW
 *   shape that runs the gate — specifically the two humanization
 *   contracts the Wave-A2 Stage-B advisor flagged on the Wave-A1 gate:
 *
 *   D4B-001 — distinguish transient network failure from real lockfile
 *   drift. The previous one-shot `npm install && git diff` made an
 *   operator chase a phantom diff every time the upstream registry was
 *   slow. The fixed shape splits install and diff, captures stderr,
 *   detects network-class errors (ETIMEDOUT / ECONNRESET / etc.), and
 *   emits a ::warning:: skip instead of a hard failure on transient
 *   network. Other install failures still emit ::error::.
 *
 *   D4B-002 — pin the gate to ONE Node version (Node 22, the lower leg).
 *   The lockfile is normative regardless of which Node version produced
 *   it; running the gate on both matrix legs opens a phantom-drift
 *   class because npm 10.9 (Node 22) and npm 11.x (Node 24) write
 *   subtly different lockfile shapes.
 *
 * The CI workflow is YAML; YAML parsing in a regression test would pull
 * in a dep just for one fixture. Instead, this test reads the workflow
 * as text and asserts the load-bearing token-level invariants. False-
 * positives are minimized because the assertions key on idiom strings
 * an operator would actually grep for ("matrix.node-version == 22",
 * "ETIMEDOUT", "::warning::lockfile-drift").
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ciPath = resolve(repoRoot, '.github/workflows/ci.yml');

test('ci.yml exists', () => {
  assert.ok(existsSync(ciPath), `expected workflow at ${ciPath}`);
});

test('D4B-002: lockfile-drift gate is pinned to Node 22 only (not run on every matrix leg)', () => {
  const text = readFileSync(ciPath, 'utf8');
  // The fix expresses the pin via `if: ${{ matrix.node-version == 22 }}`.
  // Accept either the spaced or unspaced canonical form; the load-bearing
  // assertion is the matrix.node-version comparison gate on the install /
  // diff steps. Pin both steps independently so a future re-split also
  // ships the gate.
  const installIf = /Lockfile-drift gate — install[\s\S]{0,400}?if:\s*\$\{\{\s*matrix\.node-version\s*==\s*22\s*\}\}/;
  const diffIf = /Lockfile-drift gate — diff[\s\S]{0,400}?if:\s*\$\{\{\s*matrix\.node-version\s*==\s*22[\s\S]{0,200}?\}\}/;
  assert.match(
    text,
    installIf,
    'Lockfile-drift gate install step must carry `if: ${{ matrix.node-version == 22 }}` — otherwise the gate runs on every matrix leg and risks phantom drift from npm-version differences (Node 22 ships npm 10.9; Node 24 ships npm 11.x).',
  );
  assert.match(
    text,
    diffIf,
    'Lockfile-drift gate diff step must also be Node-22-only — otherwise diff runs on the 24 leg without a fresh install of the lockfile from this run.',
  );
});

test('D4B-001: lockfile-drift gate distinguishes transient network failure from real drift', () => {
  const text = readFileSync(ciPath, 'utf8');

  // Load-bearing tokens for the network-failure-detection branch. The
  // grep canonicalizes the network-error classifier: any change that
  // drops one of these patterns risks misclassifying a real failure
  // class. We assert on a representative subset so the test surfaces the
  // intent without being brittle about extras.
  const networkPatterns = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
  ];
  for (const pat of networkPatterns) {
    assert.ok(
      text.includes(pat),
      `Lockfile-drift gate must detect transient network error class '${pat}' so it can emit ::warning:: + skip instead of ::error:: + fail. Without this, an operator can't tell a registry hiccup from a real lockfile mismatch.`,
    );
  }

  // The skip path must emit ::warning:: with a lockfile-drift label and
  // explicitly state the gate was skipped. ::warning:: (not ::error::)
  // keeps the run green; the label makes the skipped state greppable.
  assert.match(
    text,
    /::warning::\s*lockfile-drift gate skipped/,
    'Network-failure branch must emit a `::warning::lockfile-drift gate skipped` annotation. The leg passes (green run), the operator is told the gate was bypassed.',
  );

  // The non-network failure branch must emit ::error:: + non-zero exit,
  // so a misconfigured install (workspace cycle, bad engine, missing
  // workspace dir) still fails CI loudly.
  assert.match(
    text,
    /::error::\s*lockfile-drift gate failed/,
    'Non-network install-failure branch must emit `::error::lockfile-drift gate failed` + non-zero exit. We only skip on the bounded set of transient-network errors; everything else is still an operator-actionable failure.',
  );
});

test('D4B-001: lockfile-drift gate split into separate install + diff steps', () => {
  const text = readFileSync(ciPath, 'utf8');
  // Two named steps proves the split landed. Anchoring on the precise
  // step names keeps the assertion robust if other steps are reordered.
  assert.match(
    text,
    /name:\s*Lockfile-drift gate — install/,
    'Expected a dedicated "Lockfile-drift gate — install" step. The split is what enables D4B-001 (classify install-failure vs run the diff).',
  );
  assert.match(
    text,
    /name:\s*Lockfile-drift gate — diff/,
    'Expected a dedicated "Lockfile-drift gate — diff" step. Diff must only run after a clean install — separation is what stops a registry timeout from looking like a lockfile mismatch.',
  );
});

test('D4B-001: diff step is gated on the install step succeeding (no diff if install was skipped)', () => {
  const text = readFileSync(ciPath, 'utf8');
  // The diff step's `if:` must also exclude the install-skipped case.
  // Otherwise: install skips on a network error → diff still runs → diff
  // compares against the on-disk-as-checked-out lockfile, which is
  // always identical to itself, so the gate falsely reports "clean".
  // Anchoring on the steps.<id>.outputs.skipped check.
  assert.match(
    text,
    /Lockfile-drift gate — diff[\s\S]{0,400}?steps\.lockfile_install\.outputs\.skipped\s*!=\s*['"]true['"]/,
    'Diff step must check `steps.lockfile_install.outputs.skipped != \'true\'`. Without this, the diff runs after a network-skipped install and falsely reports clean.',
  );
});

test('D4B-001 + D4B-002: full structure passes shellcheck-equivalent token sanity', () => {
  const text = readFileSync(ciPath, 'utf8');
  // Defensive: the install step must capture stderr to a file so the
  // classifier can grep it. The canonical form is `2> install.log`.
  assert.match(
    text,
    /npm install --package-lock-only.*?2>\s*install\.log/,
    'Install command must redirect stderr to install.log so the network-error classifier can grep it. Without redirection the classifier always sees the empty string and goes straight to the ::error:: branch.',
  );

  // The grep classifier must be case-insensitive (registries / Node
  // emit these in mixed case across versions). Accept any flag layout
  // where `-i` appears as a standalone or combined flag — both
  // `grep -E -i "..."` and `grep -Ei "..."` are valid bashisms.
  assert.match(
    text,
    /grep(\s+-[A-Za-z]*i\b|\s+-i\b|\s+-[A-Za-z]+\s+-i\b|\s+-i\s+-[A-Za-z]+)/,
    'Network-error classifier should run grep with -i (case-insensitive). npm output across versions mixes ETIMEDOUT/etimedout casings; the gate should match either.',
  );
});
