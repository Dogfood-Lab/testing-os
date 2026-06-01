/**
 * Pre-release dep-hygiene regression — H3 dead-dep cleanup.
 *
 * Post-H3, every consumer reaches Ajv only via @dogfood-lab/schemas.
 * Direct `ajv` and `ajv-formats` deps in `packages/{ingest,findings,verify}/
 * package.json` are dead — confirmed by grep returning ZERO production
 * imports in those packages.
 *
 * Leaving them declared:
 *   - misrepresents the dep graph (npm ls shows them as direct deps)
 *   - inflates the security-audit surface (npm audit / dependabot / SBOM
 *     flag them as direct attack-surface for packages that don't use them)
 *   - lets a future maintainer re-add a `new Ajv()` thinking it's part of
 *     the package contract — re-opening the C1 two-Ajv gap that H3 closed.
 *
 * This test pins the hygiene state: ajv + ajv-formats MUST be absent from
 * the dependencies map of these three packages. Re-adding either is a
 * regression that trips this gate before it reaches the workspace.
 *
 * Important caveat: the canonical `@dogfood-lab/schemas` package still
 * legitimately declares both deps — they are the actual library it uses.
 * This test scopes the assertion to the THREE consumers that migrated.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const POST_H3_CONSUMERS_WITHOUT_DIRECT_AJV = [
  'packages/ingest/package.json',
  'packages/findings/package.json',
  'packages/verify/package.json',
];

const FORBIDDEN_DEPS = ['ajv', 'ajv-formats'];

test('post-H3: ingest/findings/verify package.json declare no direct ajv/ajv-formats dep', () => {
  const violations = [];

  for (const relPath of POST_H3_CONSUMERS_WITHOUT_DIRECT_AJV) {
    const pkgPath = resolve(repoRoot, relPath);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = pkg.dependencies ?? {};
    for (const dep of FORBIDDEN_DEPS) {
      if (Object.prototype.hasOwnProperty.call(deps, dep)) {
        violations.push(`${relPath}: declares "${dep}" as a direct dep (post-H3 it is dead — reaches via @dogfood-lab/schemas)`);
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `H3 dead-dep regression — ${violations.length} direct ajv/ajv-formats dep(s) re-introduced into a migrated consumer:\n  ` +
    violations.join('\n  ') +
    `\n\nEvery consumer reaches Ajv via @dogfood-lab/schemas's compileSchema/validatePayload — direct deps misrepresent the graph and let a future re-add of \`new Ajv()\` re-open the C1 two-Ajv gap that H3 sealed. ` +
    `If a new schema legitimately needs custom Ajv configuration, graduate it into @dogfood-lab/schemas first.`,
  );
});

test('@dogfood-lab/schemas package.json STILL declares ajv + ajv-formats (canonical home)', () => {
  // Counter-test: a future maintainer reading the forbidden-dep test above
  // might think ajv/ajv-formats should be gone from EVERYWHERE. They are
  // legitimately the schemas package's direct deps — that's the canonical
  // home. Pin that asymmetry so the hygiene test above can't be
  // over-applied.
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages/schemas/package.json'), 'utf-8'));
  const deps = pkg.dependencies ?? {};
  assert.equal(typeof deps.ajv, 'string',
    '@dogfood-lab/schemas must declare ajv as a direct dep — it is the canonical Ajv compile site for the workspace');
  assert.equal(typeof deps['ajv-formats'], 'string',
    '@dogfood-lab/schemas must declare ajv-formats as a direct dep — it is loaded in createAjv()');
});
