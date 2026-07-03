/**
 * F-8a05fa9d — the findings `edit` verb documents `--set field=value` but never
 * enumerated WHICH fields are editable, so an operator had to guess and fail
 * once before the write-side schema gate surfaced a valid field name.
 *
 * The fix renders the editable-field set from EDITABLE_FIELDS (defined in the
 * write-gate module review-engine.js) on both help surfaces:
 *   - the top-level help block (`findings help`)
 *   - the missing-id usage for `edit` (exit 2)
 * Sourcing both from the same constant keeps help and the gate's intent from
 * drifting. These are read-only / refuse paths — neither writes the real tree,
 * so a subprocess against the real CLI is safe (mirrors featF-intel-001-cli).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { EDITABLE_FIELDS } from './review-engine.js';

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

describe('F-8a05fa9d: edit help enumerates the editable fields', () => {
  it('exports a non-empty editable-field allowlist covering the prose + enum fields', () => {
    assert.ok(EDITABLE_FIELDS.length > 0);
    for (const field of ['title', 'summary', 'issue_kind', 'transfer_scope']) {
      assert.ok(EDITABLE_FIELDS.includes(field), `EDITABLE_FIELDS should include ${field}`);
    }
  });

  it('top-level help lists every editable field for the edit verb', () => {
    const r = run(['help']);
    assert.equal(r.code, 0);
    for (const field of EDITABLE_FIELDS) {
      assert.ok(r.stdout.includes(field), `top-level help should name editable field "${field}"`);
    }
  });

  it('the missing-id edit usage lists the editable fields and exits 2', () => {
    const r = run(['edit']);
    assert.equal(r.code, 2);
    for (const field of EDITABLE_FIELDS) {
      assert.ok(r.stderr.includes(field), `edit usage should name editable field "${field}"`);
    }
  });
});
