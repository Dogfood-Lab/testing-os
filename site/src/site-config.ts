import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'testing-os',
  description: 'Testing operating system — protocols, schemas, and centralized dogfood evidence for AI-augmented software.',
  logoBadge: 'TO',
  brandName: 'testing-os',
  repoUrl: 'https://github.com/dogfood-lab/testing-os',
  footerText: 'MIT Licensed — built by <a href="https://github.com/dogfood-lab" style="color:var(--color-muted);text-decoration:underline">dogfood-lab</a>',

  hero: {
    badge: 'Testing OS',
    headline: 'testing-os',
    headlineAccent: 'proves it ships.',
    description: 'Centralized dogfood evidence system. 13 repos, 8 surfaces, all verified pass, all enforcement required.',
    primaryCta: { href: '#architecture', label: 'How it works' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      { label: 'Verify', code: 'npm run verify' },
      { label: 'Portfolio', code: 'node packages/portfolio/generate.js' },
      { label: 'Sync', code: 'rk sync-dogfood --local F:/AI/dogfood-lab/testing-os' },
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
        { title: 'Three Contracts', code: '# Record — what a dogfood run looks like\n# Scenario — what constitutes real exercise\n# Policy — what rules the verifier enforces' },
        { title: 'Data Flow', code: 'Source repo → repository_dispatch\n  → Central verifier (schema + provenance + policy)\n  → Accepted record → records/<org>/<repo>/\n  → Rebuilt indexes → latest-by-repo.json' },
        { title: 'Consumers', code: 'shipcheck   → Gate F enforcement\nrepo-knowledge → SQLite mirror\norg audit   → Portfolio consumer' },
      ],
    },
  ],
};
