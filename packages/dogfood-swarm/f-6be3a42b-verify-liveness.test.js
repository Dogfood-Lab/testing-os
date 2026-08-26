/**
 * F-6be3a42b — swarm verify TTY liveness without inheriting child stdio.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'commands', 'verify.js'),
  'utf8',
);

/** @pins F-6be3a42b */
describe('F-6be3a42b swarm verify TTY liveness without hiding exit code', () => {
  it('does not inherit child stdio onto the operator channel', () => {
    assert.match(src, /F-6be3a42b/);
    assert.match(src, /emitVerifyProgress/);
    assert.doesNotMatch(src, /stdio:\s*['"]inherit['"]/);
    assert.match(src, /never inherited onto[\s\S]{0,40}the operator channel/);
  });
});
