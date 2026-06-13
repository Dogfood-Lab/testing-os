/**
 * featF-INTEL-001 — CLI wiring smoke for the synthesis-artifact review verbs.
 *
 * The engine itself (reviewArtifact) is proven against TEST_ROOT temp dirs in
 * featF-intel-001-review-artifacts.test.js. The findings CLI hardcodes its root
 * (`ROOT = resolve(__dirname, '../..')`), so write-path subprocess tests are
 * intentionally NOT run here — they would touch the real tree, which the build
 * constraints forbid. This file exercises only the READ-ONLY / REFUSE paths the
 * new dispatch added: an unknown id refuses with exit 1, and `queue` lists
 * candidates with exit 0. Neither writes the real tree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'cli.js');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  }
}

describe('featF-INTEL-001: CLI dispatch (read-only / refuse paths)', () => {
  it('patterns accept <unknown-id> refuses with exit 1 and a structured message', () => {
    const r = run(['patterns', 'accept', 'dpat-featf-cli-nope', '--actor', 'tester']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found/i);
  });

  it('recommendations reject <unknown-id> without a reason refuses (reason required) before lookup-or-after', () => {
    const r = run(['recommendations', 'reject', 'drec-featf-cli-nope', '--actor', 'tester']);
    assert.equal(r.code, 1);
    // Either "not found" (no such id) or "requires a reason" — both are honest
    // structured refusals; the id does not exist in the real tree so it is a
    // clean no-write refusal.
    assert.match(r.stderr, /not found|reason/i);
  });

  it('doctrine queue exits 0 (read-only)', () => {
    const r = run(['doctrine', 'queue']);
    assert.equal(r.code, 0);
  });

  it('patterns queue exits 0 (read-only)', () => {
    const r = run(['patterns', 'queue']);
    assert.equal(r.code, 0);
  });
});
