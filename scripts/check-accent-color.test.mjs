/**
 * Accent-color reconciliation snapshot test.
 *
 * Stage D wave 23, D-DOCS-003 / F-827321-019.
 *
 * What this asserts: the Starlight handbook accent token in
 * site/src/styles/starlight-custom.css matches the @mcptoolshop/site-theme
 * landing-page accent token (--color-accent: #34d399 in
 * node_modules/@mcptoolshop/site-theme/styles/theme.css). Both values are
 * pinned to the green hue used by site/public/logo.png (the testing-os logo's
 * terminal-prompt mark and the underline accent are emerald). Pre-fix, the
 * handbook used #3b82f6 (blue) and the comment block claimed it "matched the
 * cube logo" — the file disproved the comment, and a reader navigating from
 * landing (green) to handbook (blue) saw two different brand palettes for one
 * product.
 *
 * Why a snapshot test, not a visual diff: the contract is "these two CSS
 * tokens hold the same value, and both match the verified logo color." That
 * is a string-equality check on three known-good values. A visual diff would
 * be slower, flakier, and would not catch a comment that lies about the
 * value below it.
 *
 * If Mike re-brands the logo, all three of these need to move together:
 *   1. site/public/logo.png (the artifact)
 *   2. The constant LOGO_ACCENT below + the value in starlight-custom.css
 *   3. The value in @mcptoolshop/site-theme's theme.css (upstream — would
 *      need to override locally via the @theme block in global.css until the
 *      upstream change ships)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const starlightCss = join(repoRoot, 'site/src/styles/starlight-custom.css');
const themeCss = join(repoRoot, 'site/node_modules/@mcptoolshop/site-theme/styles/theme.css');

/**
 * The verified logo accent. Determined 2026-04-26 by reading site/public/logo.png
 * directly: the cube terminal-prompt `>` glyph and the "< TEST EVERYTHING />"
 * underline render in emerald-400 (#34d399). The comment in starlight-custom.css
 * claimed blue but the file rendered blue while the logo was green — finding
 * F-827321-019 was the reconciliation.
 */
const LOGO_ACCENT = '#34d399';

test('Starlight handbook accent (--sl-color-accent) matches the verified logo color', () => {
  assert.ok(existsSync(starlightCss), `starlight-custom.css not found at ${starlightCss}`);
  const css = readFileSync(starlightCss, 'utf-8');

  // Match the canonical token line. We deliberately don't accept --sl-color-accent-low
  // or --sl-color-accent-high — only the principal accent token needs to lockstep
  // with the logo. The high/low variants are tints and may legitimately differ.
  const m = /--sl-color-accent\s*:\s*(#[\da-f]{6})\b/i.exec(css);
  assert.ok(m, '--sl-color-accent declaration missing from starlight-custom.css');
  assert.equal(
    m[1].toLowerCase(),
    LOGO_ACCENT.toLowerCase(),
    `--sl-color-accent is ${m[1]} but the verified logo accent is ${LOGO_ACCENT}. ` +
    `Either the logo was re-branded and this constant needs updating, or the CSS drifted away from the logo. ` +
    `Verify against site/public/logo.png before updating either side.`,
  );
});

test('Site-theme landing accent (--color-accent) matches the verified logo color', () => {
  // The upstream theme.css is a node_modules file. If the dep isn't installed
  // (fresh checkout, no `npm ci` in site/), we skip with a clear message rather
  // than failing — the test only runs when the install step has happened.
  if (!existsSync(themeCss)) {
    console.log(`[accent-snapshot] skipping landing-side check — ${themeCss} not present (run \`npm ci\` in site/ first).`);
    return;
  }
  // Strip CSS block comments before scanning so the example value inside the
  // theme.css preamble (`@theme { --color-accent: #60a5fa; }` shown as
  // documentation of the override pattern) doesn't shadow the actual
  // declaration further down.
  const css = readFileSync(themeCss, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

  const m = /--color-accent\s*:\s*(#[\da-f]{6})\b/i.exec(css);
  assert.ok(m, '--color-accent declaration missing from @mcptoolshop/site-theme theme.css');
  assert.equal(
    m[1].toLowerCase(),
    LOGO_ACCENT.toLowerCase(),
    `Landing accent (--color-accent in site-theme) is ${m[1]} but the verified logo accent is ${LOGO_ACCENT}. ` +
    `If site-theme upstream rev'd to a non-logo color, override it locally with a @theme block in site/src/styles/global.css ` +
    `(the override pattern is documented in the theme.css header comments) so the handbook and landing keep one accent.`,
  );
});

test('starlight-custom.css comment does not still claim "blue"', () => {
  const css = readFileSync(starlightCss, 'utf-8');
  // The pre-fix comment said "blue accent (matches testing-os cube logo)". Both
  // halves were wrong (logo was green, accent was blue) — reconciled to green.
  assert.doesNotMatch(
    css,
    /blue\s+accent/i,
    'starlight-custom.css still references "blue accent" in a comment — that comment was the pre-fix lie that disagreed with the logo. Reconcile the comment with the actual token.',
  );
});
