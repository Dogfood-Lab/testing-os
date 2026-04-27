/**
 * Site a11y + favicon regression test for the local BaseLayout override.
 *
 * Locks in the local BaseLayout override that:
 *   1. Adds a WCAG 2.1 SC 2.4.1 skip-link as the first focusable element on the
 *      marketing landing page (F-129818-006).
 *   2. Replaces the broken `<link rel="icon" type="image/svg+xml" href={base}favicon.svg />`
 *      reference with the shipped logo.png (F-129818-007).
 *
 * Why a source-level test (not a rendered-DOM test): the upstream
 * @mcptoolshop/site-theme BaseLayout will likely regain a fixed favicon and
 * skip-link in a future release. Once that lands and the local override is
 * removed, this test should be updated to point at the upstream component
 * (or deleted entirely if the consuming page no longer overrides). Until then,
 * the override file existing + having the right contents is what we need to
 * guarantee, and a source check is the cheapest way to do it without spinning
 * up the full Astro dev server in CI.
 *
 * Run with `node --test site/src/components/BaseLayout.test.mjs` from repo root.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const overridePath = join(__dirname, 'BaseLayout.astro');
const indexAstroPath = join(__dirname, '..', 'pages', 'index.astro');

test('site/src/components/BaseLayout.astro override exists', () => {
  assert.ok(
    existsSync(overridePath),
    'Local BaseLayout override missing — F-129818-006 + F-129818-007 fixes have regressed.',
  );
});

test('marketing landing page imports the local BaseLayout override (not upstream)', () => {
  const indexSrc = readFileSync(indexAstroPath, 'utf-8');
  assert.match(
    indexSrc,
    /from ['"]\.\.\/components\/BaseLayout\.astro['"]/,
    'index.astro must import BaseLayout from ../components/ — importing the upstream @mcptoolshop/site-theme version reintroduces the favicon 404 + missing skip-link.',
  );
  assert.doesNotMatch(
    indexSrc,
    /import\s+BaseLayout\s+from\s+['"]@mcptoolshop\/site-theme\/components\/BaseLayout\.astro['"]/,
    'index.astro must NOT import BaseLayout directly from @mcptoolshop/site-theme — the local override exists for a reason.',
  );
});

test('local BaseLayout renders skip-link as the first body child (WCAG 2.1 SC 2.4.1)', () => {
  const src = readFileSync(overridePath, 'utf-8');

  // Skip-link must target #main-content, must use the `skip-link` class, and
  // must appear inside <body> BEFORE any <header>, <nav>, or other focusable
  // landmark — otherwise it doesn't satisfy "Bypass Blocks".
  assert.match(
    src,
    /<a\s+href="#main-content"\s+class="skip-link">Skip to main content<\/a>/,
    'Skip-link with href="#main-content" class="skip-link" not found.',
  );

  // The corresponding <main> landmark must exist and have the matching id.
  assert.match(
    src,
    /<main\s+id="main-content"/,
    '<main id="main-content"> not found — skip-link target would be broken.',
  );

  // The skip-link must appear before <header> in source order.
  const skipLinkIdx = src.indexOf('skip-link');
  const headerIdx = src.indexOf('<header');
  assert.ok(skipLinkIdx >= 0 && headerIdx >= 0, 'skip-link or <header> not found.');
  assert.ok(
    skipLinkIdx < headerIdx,
    'skip-link must precede <header> in source order — otherwise the user tabs through nav before reaching it.',
  );

  // Skip-link must be visually-hidden by default and visible on focus.
  // We don't lock the exact CSS values, but the focus-visibility hook must exist.
  assert.match(
    src,
    /\.skip-link:focus/,
    'skip-link must have a :focus style — otherwise it stays invisible to keyboard users.',
  );
});

test('local BaseLayout favicon link points at logo.png (not the broken favicon.svg)', () => {
  const rawSrc = readFileSync(overridePath, 'utf-8');

  // Strip the Astro frontmatter (leading `---` block) and any single-line `//`
  // comments so the assertion only inspects the rendered template body. The
  // header comment legitimately mentions the old broken `<link rel="icon"
  // ... favicon.svg />` pattern as documentation, and we don't want a regex
  // hit on prose to mask a real regression in the rendered tag.
  const frontmatterEnd = rawSrc.indexOf('---', 3);
  assert.ok(frontmatterEnd > 0, 'Override missing Astro frontmatter delimiter.');
  const template = rawSrc.slice(frontmatterEnd + 3).replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    template,
    /<link\s+rel="icon"[^>]*favicon\.svg/,
    'Override must not emit a <link rel="icon" ...> pointing at favicon.svg — that asset does not ship in site/public/ and will 404.',
  );
  assert.match(
    template,
    /<link\s+rel="icon"\s+type="image\/png"\s+href=\{`\$\{base\}logo\.png`\}\s*\/?>/,
    'Override must declare <link rel="icon" type="image/png" href={`${base}logo.png`} />',
  );
});
