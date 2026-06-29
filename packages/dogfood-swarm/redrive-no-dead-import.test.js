/**
 * redrive-no-dead-import.test.js — F-CORE-002.
 *
 * `commands/redrive.js` once imported `{ execFileSync, spawnSync }` from
 * 'node:child_process' as copy-paste residue from rewind.js — redrive never
 * shells out (it is a pure DB-level resume verb). Dead imports are noise in a
 * repo whose source is also training data; this pins that the symbols are not
 * imported, so the residue cannot creep back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'commands', 'redrive.js'), 'utf-8');

describe('F-CORE-002 — redrive.js carries no dead child_process import', () => {
  it('does not import from node:child_process', () => {
    assert.doesNotMatch(
      source,
      /from\s+['"]node:child_process['"]/,
      'redrive never shells out — the child_process import is dead residue from rewind.js',
    );
  });

  it('references neither execFileSync nor spawnSync', () => {
    assert.doesNotMatch(source, /\bexecFileSync\b/);
    assert.doesNotMatch(source, /\bspawnSync\b/);
  });
});
