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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN = join(__dirname, 'run.js');
const PAYLOAD = JSON.stringify({ run_id: 't', repo: 'o/r' });

function runCli(args) {
  const res = spawnSync(process.execPath, [RUN, ...args], {
    input: '',
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
  });
  return `${res.stdout || ''}${res.stderr || ''}`;
}

const ANCHOR_COMPUTE_RAN = /anchor-compute:/;
const MISSING_PROVENANCE = /--provenance flag is required/;

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
