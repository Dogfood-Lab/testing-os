/**
 * equals-form-args.test.js — the ingest CLI must accept BOTH `--flag value`
 * and `--flag=value`.
 *
 * Regression for a dogfood-swarm self-audit follow-up: dogfood-swarm's
 * commands/persist.js invokes this CLI via execSync as
 * `node run.js --provenance=stub --file=...` (equals form). The original
 * parser matched only the space form, so `--provenance=stub` fell through to
 * positionalArgs, `provenanceMode` stayed null, and the CLI died with
 * "--provenance flag is required" — silently breaking `swarm persist --ingest`.
 *
 * These tests assert the flag is PARSED (no missing-flag error) for both forms,
 * with a control that proves the assertion is meaningful. CI is cleared in the
 * child env so the stub-in-CI policy (a separate concern) doesn't mask the
 * arg-parse behaviour under test.
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

const MISSING_FLAG = /--provenance flag is required/;
const BAD_JSON = /invalid JSON payload/;

test('equals form: --provenance=stub --payload={json} parses both flags', () => {
  const out = runCli([`--provenance=stub`, `--payload=${PAYLOAD}`]);
  assert.doesNotMatch(out, MISSING_FLAG, `provenance flag not parsed:\n${out}`);
  assert.doesNotMatch(out, BAD_JSON, `payload flag not parsed:\n${out}`);
});

test('space form: --provenance stub --payload {json} still parses (no regression)', () => {
  const out = runCli([`--provenance`, `stub`, `--payload`, PAYLOAD]);
  assert.doesNotMatch(out, MISSING_FLAG, `provenance flag not parsed:\n${out}`);
  assert.doesNotMatch(out, BAD_JSON, `payload flag not parsed:\n${out}`);
});

test('control: omitting --provenance DOES report the missing flag', () => {
  const out = runCli([`--payload=${PAYLOAD}`]);
  assert.match(out, MISSING_FLAG, `expected the missing-flag error:\n${out}`);
});
