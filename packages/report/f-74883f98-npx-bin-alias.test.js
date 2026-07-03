/**
 * F-74883f98 (code-side half) + task_171ad1f7 (the published-package correction).
 *
 * `npx @dogfood-lab/report` only resolves when the package declares a bin whose
 * name matches the UNSCOPED package name — npm's multi-bin rule. The source
 * declares `dogfood-report`, `dogfood-init`, and a generic `report` alias, so a
 * bare `npx @dogfood-lab/report` resolves ONLY if that alias is actually
 * PUBLISHED. It is not: `@dogfood-lab/report@1.8.0` on npm exposes only
 * `dogfood-report` + `dogfood-init`, so a bare invocation fails with exit 127
 * ("could not determine executable to run") for every consumer copying the
 * template.
 *
 * Resolution (task_171ad1f7, Option 2 — docs/template fix, no republish): the
 * shipped consumer template and the onboarding docs invoke the canonical bin
 * explicitly via `npx --yes --package @dogfood-lab/report dogfood-report`. That
 * form works against the published package regardless of the alias AND never
 * claims the generic `report` name in `.bin/` (a documented collision footgun —
 * see README.md). The `report` alias stays declared in package.json as a latent
 * convenience a future republish would activate; nothing depends on it.
 *
 * This suite therefore pins BOTH the alias's continued presence (a structural
 * fact — assertions 1–2) AND the template's use of the explicit, collision-proof
 * form (assertion 3). The docs half (handbook/README examples) is
 * coordinator-owned.
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

  it('the shipped consumer template invokes the explicit --package dogfood-report form', () => {
    const template = readFileSync(resolve(__dirname, 'templates', 'dogfood.yml'), 'utf-8');
    assert.match(template, /npx --yes --package @dogfood-lab\/report dogfood-report/,
      'templates/dogfood.yml must invoke the canonical bin explicitly — the published ' +
        'package exposes no `report` bin, so the explicit form is what works for consumers');
    assert.doesNotMatch(template, /npx --yes @dogfood-lab\/report/,
      'templates/dogfood.yml must NOT use the bare `npx --yes @dogfood-lab/report` form — ' +
        'it fails with exit 127 against the published package (no `report` bin)');
  });
});
