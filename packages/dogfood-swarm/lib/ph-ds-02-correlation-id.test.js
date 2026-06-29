/**
 * ph-ds-02-correlation-id.test.js
 *
 * PROACTIVE-HEALTH PH-DS-02 (LOW) — extract the per-command `mintCorrelationId`
 * into a single shared leaf helper (lib/correlation-id.js), mirroring the
 * atomic-write.js / log-stage.js leaf-helper extraction pattern.
 *
 * Pre-fix: five coordination commands (dispatch, collect, resume, rewind,
 * redrive) each carried a LOCAL copy of mintCorrelationId. Three
 * (dispatch/collect/resume) used `randomBytes(2).toString('hex')`; TWO
 * (rewind/redrive) used `Math.random().toString(36).slice(2, 6)`. The two
 * Math.random copies produced a different-width, non-crypto random tail —
 * a silent format drift in the very forensic anchor the operator greps to
 * tie a failure across stderr lines. A single grep regex
 * (`coord-<base36-ts>-<4 hex>`) should match EVERY coordination command's
 * correlation id, not just three of five.
 *
 * Invariants pinned here, test-first:
 *   1. The shared helper exists and produces the canonical
 *      `coord-<base36-ts>-<4-hex>` format with a 4-hex random tail.
 *   2. All five commands import mintCorrelationId from the shared leaf — no
 *      command re-declares a local copy, and no command still uses
 *      Math.random for the id (the rewind/redrive drift is gone).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mintCorrelationId } from './correlation-id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMMANDS_DIR = join(__dirname, '..', 'commands');

describe('PH-DS-02 — shared correlation-id leaf helper', () => {
  it('produces the canonical coord-<base36-ts>-<4-hex> format', () => {
    const id = mintCorrelationId();
    assert.match(
      id,
      /^coord-[0-9a-z]+-[0-9a-f]{4}$/,
      `correlation id must be coord-<base36-ts>-<4-hex>, got ${JSON.stringify(id)}`,
    );
  });

  it('the random tail is exactly 4 hex chars (randomBytes(2) width), not the old Math.random slice', () => {
    // The Math.random().toString(36).slice(2, 6) drift could yield a tail
    // containing chars outside [0-9a-f] (base36 includes g-z). Pin that the
    // shared helper is hex-only and width-4 across many samples.
    for (let i = 0; i < 200; i++) {
      const tail = mintCorrelationId().split('-').pop();
      assert.equal(tail.length, 4, `tail width must be 4, got ${tail}`);
      assert.match(tail, /^[0-9a-f]{4}$/, `tail must be hex-only, got ${tail}`);
    }
  });

  it('all five coordination commands import the shared helper and declare no local copy', () => {
    const commands = ['dispatch.js', 'collect.js', 'resume.js', 'rewind.js', 'redrive.js'];
    for (const file of commands) {
      const src = readFileSync(join(COMMANDS_DIR, file), 'utf-8');
      assert.match(
        src,
        /import\s*\{[^}]*\bmintCorrelationId\b[^}]*\}\s*from\s*['"][^'"]*correlation-id\.js['"]/,
        `${file} must import mintCorrelationId from the shared correlation-id.js leaf`,
      );
      assert.doesNotMatch(
        src,
        /function\s+mintCorrelationId\s*\(/,
        `${file} must NOT re-declare a local mintCorrelationId`,
      );
      assert.doesNotMatch(
        src,
        /Math\.random\(\)\.toString\(36\)/,
        `${file} must NOT use the old Math.random correlation-id tail`,
      );
    }
  });
});
