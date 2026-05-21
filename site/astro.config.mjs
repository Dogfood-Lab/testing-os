// @ts-check
//
// Dependency note (2026-05-14, v1.2.2 cleanup):
//   `@tailwindcss/vite` is pinned to ~4.1.18 in site/package.json because
//   4.2.x bundles `vite@^8.0.0` as an internal dependency and calls
//   Vite-8-only resolver APIs (`tsconfigPaths`) that don't exist in the
//   Vite 7 that Astro 6 ships. 4.1.18 declares peer compat with
//   `vite ^5.2.0 || ^6 || ^7` and brings no internal vite dep, so the
//   site ends up with a single hoisted vite@7.3.3 instance. When Astro
//   bumps to a major that bundles Vite 8 natively, the pin can be
//   released. Same applies to `tailwindcss` (matched at ~4.1.18 for
//   alignment with the @tailwindcss/vite peer).
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
