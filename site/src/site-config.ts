import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'testing-os',
  description: 'Testing operating system — protocols, schemas, and centralized dogfood evidence for AI-augmented software.',
  logoBadge: 'TO',
  brandName: 'testing-os',
  repoUrl: 'https://github.com/dogfood-lab/testing-os',
  // d7-site-004: index.astro / 404.astro pass `npmUrl={config.npmUrl}` to
  // BaseLayout, which renders the npm link in nav + mobile + footer only when
  // truthy. The key was missing here, so `config.npmUrl` was `undefined` and
  // all three conditional npm links silently no-op'd — no npm button anywhere.
  // Point at the flagship published package (`@dogfood-lab/dogfood-swarm`, the
  // one the hero `Install` preview advertises); six of seven `@dogfood-lab/*`
  // packages are live on npm since v1.2.0.
  npmUrl: 'https://www.npmjs.com/package/@dogfood-lab/dogfood-swarm',
  footerText: 'MIT Licensed — built by <a href="https://github.com/dogfood-lab" style="color:var(--color-muted);text-decoration:underline">dogfood-lab</a>',

  hero: {
    // Version-agnostic per R6 spirit (Phase 10 release-honesty sweep,
    // 2026-06-01). Pre-fix the badge + description were stamped with the
    // current release number (`v1.2.3 on npm`, `v1.2.3 lands a 4-stage…`),
    // which drifted on every bump because nothing cross-checked these
    // ungated marketing surfaces against `package.json`. The v1.3.0
    // release surfaced the drift class — SHIP_GATE / SCORECARD /
    // CLAUDE.md all carried stale `v1.2.3` text after the bump too. R6's
    // doctrine: don't re-pin a number that'll drift next bump. The npm
    // badge below is a live shields.io query → always current.
    badge: 'Testing OS — on npm',
    headline: 'testing-os',
    headlineAccent: 'proves it ships.',
    description: 'Centralized dogfood evidence system. 14 governed repos, 8 surfaces, every latest accepted record verified pass — 13 of the 14 past the freshness window (indexes/stale.json names them; measured 2026-09-06). Single canonical schema validator across every consumer (one Ajv instance per schema per process; workspace-hoist split is a hard gate). Structured top-level errors with stable codes and a `Next:` hint on every failure path. See the [CHANGELOG](https://github.com/dogfood-lab/testing-os/blob/main/CHANGELOG.md) for the current release entry.',
    primaryCta: { href: '#architecture', label: 'How it works' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      { label: 'Install', code: 'npm install -g @dogfood-lab/dogfood-swarm' },
      { label: 'Verify', code: 'npm run verify' },
      { label: 'Recover', code: 'swarm revalidate <run-id> --reason "<text>" --domain=<name>:<corrected.json> --apply' },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'features',
      title: 'What It Does',
      subtitle: 'Auditable dogfood governance for the entire org.',
      features: [
        { title: 'Evidence-Based', desc: 'Every dogfood run produces a structured record with schema validation, provenance checks, and policy compliance.' },
        { title: 'Policy-Driven', desc: 'Per-repo enforcement tiers (required, warn-only, exempt) with promotion paths and review dates.' },
        { title: 'Full Coverage', desc: '14 governed repos across 8 product surfaces: CLI, desktop, web, API, MCP server, npm package, plugin, library — every latest record verified pass, 13 of 14 flagged stale by the freshness window (measured 2026-09-06).' },
      ],
    },
    {
      kind: 'code-cards',
      id: 'architecture',
      title: 'Architecture',
      cards: [
        { title: 'Seven Contracts', code: '# Foundational three\n# Record — what a dogfood run looks like\n# Scenario — what constitutes real exercise\n# Policy — what rules the verifier enforces\n\n# Intelligence layer four\n# Finding — a single learning from a run\n# Pattern — a reusable shape across findings\n# Recommendation — a candidate action derived from patterns\n# Doctrine — accepted recommendation, binding across the org\n\n# See: handbook/contracts/ for the full canonical model' },
        { title: 'Data Flow', code: 'Source repo → repository_dispatch\n  → Central verifier (schema + provenance + policy)\n  → Accepted record → records/<org>/<repo>/\n  → Rebuilt indexes → latest-by-repo.json' },
        { title: 'Consumers', code: 'shipcheck   → Gate F enforcement\nrepo-knowledge → SQLite mirror\norg audit   → Portfolio consumer' },
      ],
    },
  ],
};
