import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'testing-os',
  description: 'Testing operating system — protocols, schemas, and centralized dogfood evidence for AI-augmented software.',
  logoBadge: 'TO',
  brandName: 'testing-os',
  repoUrl: 'https://github.com/dogfood-lab/testing-os',
  footerText: 'MIT Licensed — built by <a href="https://github.com/dogfood-lab" style="color:var(--color-muted);text-decoration:underline">dogfood-lab</a>',

  hero: {
    badge: 'Testing OS — v1.2.3 on npm',
    headline: 'testing-os',
    headlineAccent: 'proves it ships.',
    description: 'Centralized dogfood evidence system. 13 repos, 8 surfaces, all verified pass, all enforcement required. v1.2.3 lands a 4-stage dogfood-swarm health cleanup over v1.2.2: defense-in-depth around the receiver pipeline, actionable error messages, a new CLI reference handbook page, and a custom 404.',
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
        { title: 'Full Coverage', desc: '13 repos across 8 product surfaces: CLI, desktop, web, API, MCP server, npm package, plugin, library.' },
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
