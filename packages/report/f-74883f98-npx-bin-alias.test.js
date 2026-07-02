/**
 * F-74883f98 (code-side half): `npx @dogfood-lab/report` only resolves when the
 * package declares a bin whose name matches the UNSCOPED package name — npm's
 * multi-bin rule. With only `dogfood-report` and `dogfood-init` declared, the
 * shipped consumer template (templates/dogfood.yml) invoked
 * `npx --yes @dogfood-lab/report …` and failed with "could not determine
 * executable to run". The `report` alias makes that invocation resolve; the
 * docs half (handbook/README examples) is coordinator-owned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('F-74883f98: npx-resolvable bin alias', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

  it('declares a bin matching the unscoped package name (npm multi-bin rule)', () => {
    assert.equal(pkg.name, '@dogfood-lab/report');
    assert.equal(pkg.bin?.report, 'cli.js',
      'bin.report must point at cli.js so `npx @dogfood-lab/report` resolves');
  });

  it('keeps the existing named bins (no consumer breakage)', () => {
    assert.equal(pkg.bin?.['dogfood-report'], 'cli.js');
    assert.equal(pkg.bin?.['dogfood-init'], 'init.js');
  });

  it('the shipped consumer template uses the npx form the alias makes valid', () => {
    const template = readFileSync(resolve(__dirname, 'templates', 'dogfood.yml'), 'utf-8');
    assert.match(template, /npx --yes @dogfood-lab\/report/,
      'templates/dogfood.yml must invoke the package via the aliased npx form');
  });
});
