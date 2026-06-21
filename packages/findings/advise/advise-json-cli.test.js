/**
 * FT-e — `advise --json` consumability contract.
 *
 * Downstream tools (shipcheck, repo-knowledge) consume advice programmatically,
 * so the --json flag must keep stdout PURE JSON: parseable, no human-formatted
 * preamble, no trailing log lines. We assert against the REAL tree (advise is
 * read-only — same safe subprocess pattern as review/featF-intel-001-cli.test.js)
 * and prove the emitted JSON round-trips to the exact structure
 * generateAdviceBundle returns for the same scope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { generateAdviceBundle } from './advice-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'cli.js');
// The CLI hardcodes ROOT = resolve(__dirname, '../..') — the real repo tree —
// which is exactly what generateAdviceBundle reads when called directly here.
const REAL_ROOT = resolve(__dirname, '..', '..', '..');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  }
}

describe('FT-e: advise --json', () => {
  it('emits valid JSON parseable from stdout alone', () => {
    const r = run(['advise', '--surface', 'cli', '--json']);
    assert.equal(r.code, 0);
    // Pure JSON: no human preamble means stdout parses without trimming junk.
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.query, 'bundle.query present');
    assert.ok(parsed.advice, 'bundle.advice present');
    assert.ok(parsed.support, 'bundle.support present');
  });

  it('stdout contains nothing but the JSON (no extra log lines)', () => {
    const r = run(['advise', '--surface', 'cli', '--json']);
    // The whole stdout, trimmed, must round-trip — if any "Advice for:" header
    // or "Support:" footer leaked onto stdout, JSON.parse(stdout) would throw.
    assert.doesNotThrow(() => JSON.parse(r.stdout));
    // And it must be a single JSON document: re-stringifying the parse and
    // comparing to the trimmed stdout proves there is no trailing text.
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.stdout.trim(), JSON.stringify(parsed, null, 2));
  });

  it('round-trips to the same structure generateAdviceBundle returns', () => {
    const r = run(['advise', '--surface', 'mcp-server', '--json']);
    const fromCli = JSON.parse(r.stdout);
    const direct = generateAdviceBundle(REAL_ROOT, { surface: 'mcp-server' });
    assert.deepEqual(fromCli, direct);
  });

  it('without --json prints human text (regression: default unchanged)', () => {
    const r = run(['advise', '--surface', 'cli']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Advice for:/);
    // The human formatter output is NOT valid JSON — guards against the flag
    // silently inverting.
    assert.throws(() => JSON.parse(r.stdout));
  });
});
