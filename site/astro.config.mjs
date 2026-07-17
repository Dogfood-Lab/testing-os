// @ts-check
//
// Dependency note (2026-07-17, Stage D amend — supersedes the 2026-05-14 note):
//   site/package.json once pinned `@tailwindcss/vite` to ~4.1.18 because 4.2.x
//   required Vite-8-only resolver APIs while Astro 6 shipped Vite 7. That
//   note's own release condition ("when Astro bumps to a major that bundles
//   Vite 8 natively") was satisfied by the Astro 7 upgrade, and the pin was
//   released to the tilde ranges now in site/package.json — the exact versions
//   live there, not here; an earlier revision of this comment went stale
//   precisely by duplicating them. What still matters: keep `@tailwindcss/vite`
//   and `tailwindcss` moving together (they are a matched peer pair), and
//   rebuild the site before committing a bump — this pair's minors have
//   coupled to Vite majors before.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://dogfood-lab.github.io',
  base: '/testing-os',
  integrations: [
    starlight({
      title: 'testing-os',
      logo: { src: './public/logo.png', replacesTitle: false },
      favicon: '/logo.png',
      disable404Route: true,
      // Social-card meta. og:image + twitter:card so links shared in Slack,
      // GitHub, Mastodon, etc. preview with the brand mark instead of a bare
      // text fallback. Uses the deployed logo asset (absolute URL required —
      // social scrapers don't resolve relative paths). When the canonical
      // logo changes, update the og:image path in the same edit.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://dogfood-lab.github.io/testing-os/logo.png' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'testing-os — operating system for testing in the AI era' } },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://dogfood-lab.github.io/testing-os/logo.png' } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/dogfood-lab/testing-os' },
      ],
      sidebar: [
        { label: 'Handbook', items: [{ autogenerate: { directory: 'handbook' } }] },
      ],
      customCss: ['./src/styles/starlight-custom.css'],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
