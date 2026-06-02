/**
 * meta-amendA-schema-packaging.test.js — fp-001 packaging guard.
 *
 * The agent-output schema is consumed at runtime by lib/validate-agent-output.js
 * (collect/revalidate) and lib/templates.js (dispatch). Before this fix those
 * modules resolved ONLY the repo-root scripts/agent-output.schema.json, which is
 * NOT in package.json `files` and is therefore absent from the published npm
 * tarball — so a `npm install -g @dogfood-lab/dogfood-swarm` user's `swarm
 * dispatch`/`collect`/`revalidate` crashed with ENOENT.
 *
 * The fix ships a package-local copy at schema/agent-output.schema.json and
 * resolves it first. This test is the guard that keeps the shipped copy honest:
 *   1. the package-local copy is byte-identical to the canonical scripts/ copy
 *      (no silent drift between the dev-canonical and the shipped artifact);
 *   2. package.json `files` actually ships the schema/ dir;
 *   3. the shipped copy lives INSIDE the package (so it is packable at all); and
 *   4. the live validator resolves + compiles the schema and enforces it.
 *
 * If someone edits scripts/agent-output.schema.json without refreshing the
 * package copy, case 1 fails loud — re-copy with:
 *   cp scripts/agent-output.schema.json packages/dogfood-swarm/schema/agent-output.schema.json
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateAgentOutput,
  AgentOutputValidationError,
} from './lib/validate-agent-output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_LOCAL = join(__dirname, 'schema', 'agent-output.schema.json');
const CANONICAL = join(__dirname, '..', '..', 'scripts', 'agent-output.schema.json');
const PACKAGE_JSON = join(__dirname, 'package.json');

test('fp-001: package-local schema is byte-identical to the canonical scripts/ copy', () => {
  const shipped = readFileSync(PKG_LOCAL);
  const canonical = readFileSync(CANONICAL);
  assert.equal(
    shipped.equals(canonical),
    true,
    'schema/agent-output.schema.json drifted from scripts/agent-output.schema.json — re-copy the canonical into the package',
  );
});

test('fp-001: package.json `files` ships the schema/ dir', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes('schema/'),
    '`files` must include "schema/" so the schema is in the published tarball',
  );
});

test('fp-001: the shipped schema lives inside the package (packable)', () => {
  const rel = relative(__dirname, PKG_LOCAL);
  assert.ok(
    !rel.startsWith('..') && !rel.startsWith('/'),
    'the shipped schema must resolve INSIDE the package — npm cannot pack files outside the package root',
  );
});

test('fp-001: the live validator resolves + compiles the schema (no ENOENT)', () => {
  // A valid audit envelope must pass — this only succeeds if SCHEMA_PATH
  // resolved to a real file and Ajv compiled it.
  const valid = {
    domain: 'cli-commands',
    summary: 'ok',
    stage: 'A',
    findings: [{ id: 'F-1', severity: 'LOW', category: 'docs', description: 'd' }],
  };
  assert.doesNotThrow(() => validateAgentOutput(valid, { domain: 'cli-commands', phase: 'health-audit-a' }));

  // And an invalid envelope must still be rejected with the typed error —
  // proving the compiled schema is actually enforcing, not a no-op stub.
  assert.throws(
    () => validateAgentOutput({ domain: 'x' }, { domain: 'x' }),
    (e) => e instanceof AgentOutputValidationError && e.code === 'AGENT_OUTPUT_SCHEMA_INVALID',
  );
});
