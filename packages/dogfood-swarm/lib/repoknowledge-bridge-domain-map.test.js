/**
 * repoknowledge-bridge-domain-map.test.js — the persist bridge's swarm-category
 * → repo-knowledge audit-domain map must only ever emit domains that exist in
 * repo-knowledge's fixed audit-domain enum.
 *
 * INCIDENT (ai-rpg-engine v2.8, 2026-07-22). The Phase-5 repo-knowledge SCAN
 * landed the DB entry, but `rk audit import` of the `swarm persist` bundle
 * failed outright:
 *
 *     audit import failed: Invalid findings[N] (...) domain: "documentation".
 *     Must be one of: inventory, code_quality, security_sast, ... , integrations
 *
 * The map keyed a `docs`-category finding (the cycle's JSDoc-range findings) to
 * the value `documentation`, which is NOT one of repo-knowledge's 19 audit
 * domains — so a SINGLE docs finding failed the ENTIRE atomic import and the
 * audit evidence never reached the knowledge DB. Prior cycles happened to carry
 * no docs-category finding, so the mismatch stayed latent.
 *
 * THE PRODUCER HALF OF THE FIX: `docs` maps to `inventory` — rk's
 * documentation-artifact domain (its controls are README currency, manifest/
 * entrypoint identification, ownership docs; INV-001 is literally "README
 * present and materially current"). That keeps docs findings queryable as a
 * distinct domain rather than collapsing them into the `code_quality` fallback
 * bucket. The consumer half (repo-knowledge normalising an unknown domain
 * instead of dropping the whole bundle) is a separate, defence-in-depth change.
 *
 * These two repos share no code dependency, so this test keeps its OWN copy of
 * rk's domain enum (the real contract, mirrored from repo-knowledge
 * src/audit/controls.ts / AUDIT-CONTRACT.md) and pins that EVERY value the map
 * can emit is a member of it — fixing the class, not just the `documentation`
 * instance, so a future category addition can't reintroduce a rk-invalid domain.
 *
 * SCOPE NOTE. Lives under lib/ because swarm-cp-core owns
 * packages/dogfood-swarm/lib/** — same placement as the sibling
 * repoknowledge-bridge-status-line.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuditPayload,
  CATEGORY_TO_AUDIT_DOMAIN,
  RK_AUDIT_DOMAINS as MODULE_RK_AUDIT_DOMAINS,
} from './persist/repoknowledge-bridge.js';

const COMMIT_SHA = 'd'.repeat(40);

/**
 * The fixed repo-knowledge audit-domain enum, mirrored here as the contract the
 * persist bridge must honour. Source of truth: repo-knowledge
 * src/audit/controls.ts `DOMAINS` (also migration-002-audit.sql's CHECK and
 * AUDIT-CONTRACT.md's "Domains (fixed enum)"). Kept independent of the module
 * under test so a drift in the module's own list is caught, not masked.
 */
const RK_AUDIT_DOMAINS = [
  'inventory', 'code_quality', 'security_sast', 'dependencies_sca',
  'licenses', 'secrets', 'config_iac', 'containers', 'runtime',
  'performance', 'observability', 'testing', 'cicd', 'deployment',
  'backup_dr', 'monitoring', 'compliance_privacy', 'supply_chain',
  'integrations',
];

/** A minimal, schema-shaped canonical export literal (mirrors buildRunExport). */
function makeExport(items) {
  return {
    run: {
      id: 'run-domain-map', repo: 'dogfood-lab/testing-os', branch: 'main',
      commit_sha: COMMIT_SHA, status: 'complete',
      created: '2026-07-22T00:00:00Z', completed: '2026-07-22T01:00:00Z',
    },
    waves: [],
    verification: [],
    findings: { summary: { total: items.length }, items },
    promotions: [],
  };
}

describe('persist bridge: docs-category finding maps to a valid rk audit domain (ai-rpg-engine v2.8 incident)', () => {
  it('a docs-category finding emits `inventory`, never the rk-invalid `documentation`', () => {
    const exp = makeExport([
      {
        id: 'F-D1', category: 'docs', severity: 'LOW', status: 'new',
        description: 'JSDoc @param range mismatch on computeItemValue',
        file: 'src/econ.ts', line: 12,
      },
    ]);

    const { findings } = buildAuditPayload(exp);

    assert.equal(findings.length, 1);
    // The exact value that failed `rk audit import` in the incident.
    assert.notEqual(
      findings[0].domain, 'documentation',
      'the persist bridge must not emit `documentation` — it is not in rk\'s ' +
      'audit-domain enum, so `rk audit import` rejects the whole bundle',
    );
    assert.equal(findings[0].domain, 'inventory');
    assert.ok(
      RK_AUDIT_DOMAINS.includes(findings[0].domain),
      `emitted domain "${findings[0].domain}" is not a valid rk audit domain`,
    );
  });

  it('every emitted domain across all swarm categories is a valid rk audit domain', () => {
    // Drive one finding per swarm finding-category the health/feature passes
    // produce, plus an unmapped category to exercise the fallback, and assert
    // the mapped domain is always rk-valid — the class-level guard.
    const categories = [
      'bug', 'security', 'quality', 'types', 'tests', 'docs',
      'defensive', 'observability', 'degradation', 'ux', 'accessibility',
      'some_future_uncategorised_kind',
    ];
    const exp = makeExport(categories.map((category, i) => ({
      id: `F-${i}`, category, severity: 'MEDIUM', status: 'new',
      description: `finding for category ${category}`,
    })));

    const { findings } = buildAuditPayload(exp);

    assert.equal(findings.length, categories.length);
    for (const f of findings) {
      assert.ok(
        RK_AUDIT_DOMAINS.includes(f.domain),
        `category produced rk-invalid domain "${f.domain}"`,
      );
    }
  });
});

describe('persist bridge: category→domain map is a rk-valid contract (class guard)', () => {
  it('every value in CATEGORY_TO_AUDIT_DOMAIN is a valid rk audit domain', () => {
    for (const [category, domain] of Object.entries(CATEGORY_TO_AUDIT_DOMAIN)) {
      assert.ok(
        RK_AUDIT_DOMAINS.includes(domain),
        `category "${category}" maps to rk-invalid domain "${domain}" — every ` +
        `map value must be a member of repo-knowledge's fixed domain enum, or ` +
        `\`rk audit import\` will reject the whole bundle`,
      );
    }
  });

  it('the code_quality fallback is itself a valid rk audit domain', () => {
    // The `|| 'code_quality'` at the call site must never emit an invalid domain.
    assert.ok(RK_AUDIT_DOMAINS.includes('code_quality'));
  });

  it('the module\'s exported RK_AUDIT_DOMAINS matches this test\'s independent mirror of rk\'s enum', () => {
    // Belt-and-suspenders: if someone edits the module's self-declared valid
    // set to sneak in a bogus domain (then "validates" the map against it), this
    // catches the drift against the real rk contract copied at the top of file.
    assert.deepEqual(
      [...MODULE_RK_AUDIT_DOMAINS].sort(),
      [...RK_AUDIT_DOMAINS].sort(),
      'the bridge\'s RK_AUDIT_DOMAINS must equal the real repo-knowledge domain ' +
      'enum (src/audit/controls.ts). If rk extended its enum, update BOTH.',
    );
  });

  it('docs specifically maps to inventory (the incident fix)', () => {
    assert.equal(CATEGORY_TO_AUDIT_DOMAIN.docs, 'inventory');
  });
});
