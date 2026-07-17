/**
 * f-ingest-003-flag-value-not-flag.test.js
 *
 * F-INGEST-003 — a space-form value flag (`--flag value`) consumed the NEXT
 * token even when that token was itself another flag, so `--flag --next`
 * parsed `--flag`'s value as the literal string "--next" and silently dropped
 * `--next`.
 *
 * Fix: when there is no inline `=value`, treat the next token as a value only
 * if it exists AND does not start with `--`; otherwise the value flag has no
 * value and the following flag is parsed on its own.
 *
 * Invariant:
 *   - `--anchor-network --anchor-compute` runs anchor-compute (the second flag
 *     is honoured) instead of swallowing it as the network value and falling
 *     through to a normal ingest.
 *   - the well-formed equals/space forms still parse (no regression).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN = join(__dirname, 'run.js');
const PAYLOAD = JSON.stringify({ run_id: 't', repo: 'o/r' });

// ingest-live-tree: run.js falls back to the REAL testing-os root when
// INGEST_REPO_ROOT is unset, so the `--anchor-compute` case below would anchor the
// LIVE chain and write indexes/integrity/anchors/anchor-0000.json into the working
// tree — dirtying every `npm run verify` / `npm test`. Sandbox every subprocess in a
// throwaway temp root. The root is left empty on purpose: --anchor-compute then
// short-circuits to "nothing to anchor" (zero writes), and the value-flag-parse
// assertions fail BEFORE repoRoot contents matter, so no fixtures are needed. Mirrors
// the INGEST_REPO_ROOT sandbox discipline in stageA-seed2-repo-root-override.test.js.
const SANDBOX_ROOT = mkdtempSync(join(tmpdir(), 'ingest-f003-'));
after(() => rmSync(SANDBOX_ROOT, { recursive: true, force: true }));

function runCli(args) {
  const res = spawnSync(process.execPath, [RUN, ...args], {
    input: '',
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', INGEST_REPO_ROOT: SANDBOX_ROOT },
  });
  return `${res.stdout || ''}${res.stderr || ''}`;
}

const ANCHOR_COMPUTE_RAN = /anchor-compute:/;
const MISSING_PROVENANCE = /--provenance flag is required/;

/**
 * @pins F-INGEST-003
 *
 * Declares what this test already proved. The tag is new, the coverage is not:
 * wave 29's F-e0bcbc47 amend added the first SOURCE mention of F-INGEST-003
 * (run.js's flagIs() chain cites it as the contract it must not break), and an
 * F-id in source with no declared tag is an orphan by the Class #14 gate's
 * rule — so the mention surfaced a pin this file had owed since it was written.
 * Not a laundered grant: the assertion below drives the real CLI and was RED
 * pre-fix (the value flag absorbed `--anchor-compute`, so the verb never
 * fired), which is exactly the behavior the tag claims.
 */
test('a value flag does not swallow the following flag as its value', () => {
  // `--anchor-network` is a space-form value flag. Pre-fix it absorbed
  // `--anchor-compute` as its network value, so the anchor-compute verb never
  // fired and the CLI fell through to a normal ingest.
  const out = runCli([`--provenance`, `stub`, `--payload=${PAYLOAD}`, `--anchor-network`, `--anchor-compute`]);
  assert.match(out, ANCHOR_COMPUTE_RAN,
    `--anchor-compute must run as its own flag, not be absorbed by --anchor-network:\n${out}`);
});

test('regression: a value flag still accepts a real space-form value', () => {
  const out = runCli([`--provenance`, `stub`, `--payload=${PAYLOAD}`]);
  assert.doesNotMatch(out, MISSING_PROVENANCE, `space-form value must still parse:\n${out}`);
});

test('regression: the equals form still parses', () => {
  const out = runCli([`--provenance=stub`, `--payload=${PAYLOAD}`]);
  assert.doesNotMatch(out, MISSING_PROVENANCE, `equals-form value must still parse:\n${out}`);
});

// ── ingest-live-tree regression ─────────────────────────────────────────────
// The INGEST_REPO_ROOT sandbox above is the fix; this asserts it actually holds.
// Pre-fix runCli left the env var unset, so the `--anchor-compute` case anchored the
// live chain and created indexes/integrity/anchors/anchor-0000.json under the real
// repo root, dirtying the tree the swarm's own clean-tree gate depends on.
const REAL_ANCHORS_DIR = resolve(__dirname, '../..', 'indexes', 'integrity', 'anchors');

test('ingest-live-tree: --anchor-compute through runCli must not touch the real working tree', () => {
  const anchorsDirPreexisted = existsSync(REAL_ANCHORS_DIR);

  const out = runCli([`--provenance`, `stub`, `--payload=${PAYLOAD}`, `--anchor-network`, `--anchor-compute`]);

  // Self-cleaning guard: should an unsandboxed runCli ever regress and leak the
  // anchors dir that did not exist before, delete it here so even a RED run of this
  // test leaves `git status` clean (the leak is exactly what we assert against).
  const leaked = !anchorsDirPreexisted && existsSync(REAL_ANCHORS_DIR);
  if (leaked) rmSync(REAL_ANCHORS_DIR, { recursive: true, force: true });

  // The verb fired — otherwise "no leak" would pass vacuously.
  assert.match(out, ANCHOR_COMPUTE_RAN, `--anchor-compute must run:\n${out}`);
  // It anchored the EMPTY sandbox ("nothing to anchor"), never the live chain —
  // "wrote anchor seq N" would prove the real (chain-bearing) root was used.
  assert.doesNotMatch(out, /wrote anchor seq/,
    `--anchor-compute must run against the sandbox, not the live chain:\n${out}`);
  // The core invariant: nothing landed under the real repo root.
  assert.ok(!leaked,
    'runCli must sandbox via INGEST_REPO_ROOT — --anchor-compute leaked ' +
    'indexes/integrity/anchors/ into the REAL working tree');
});
