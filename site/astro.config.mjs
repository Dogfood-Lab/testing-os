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
