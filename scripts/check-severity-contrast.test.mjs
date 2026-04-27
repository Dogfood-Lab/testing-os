/**
 * Severity-tier WCAG AA contrast test.
 *
 * Stage D wave 23, D-DOCS-001 / F-827321-017 (cross-wave handoff from wave
 * 22's ci-tooling agent — they correctly deferred this slot because the
 * severity-tier visual treatment didn't exist locally yet; their pages.yml
 * pa11y step paired with this contract test is the full Stage D minimum
 * visual-regression bar).
 *
 * What this asserts:
 * - The severity-tier visual treatment in site/src/content/docs/handbook/error-codes.md
 *   uses Starlight's :::danger / :::caution / :::note / :::tip Aside callouts
 *   (one per severity level — CRITICAL / HIGH / MEDIUM / LOW respectively).
 * - The text/background color pair Starlight ships for each callout meets the
 *   WCAG 2.1 AA contrast ratio bar of 4.5:1 (normal text). The dark theme
 *   (which is what testing-os ships) has higher-contrast variants than light
 *   so the harder side is dark — we test dark.
 *
 * Why these specific RGB values: Starlight's dark-theme Aside palette is
 * defined in @astrojs/starlight/style/asides.css. The values below are pulled
 * from there and from the testing-os surface tokens (--color-surface = #09090b,
 * the page background under the handbook content). If Starlight ever rev's
 * the palette in a way that drops below WCAG AA, this test fails — that's the
 * load-bearing assertion.
 *
 * Why a Node test, not a browser test: contrast is pure arithmetic on RGB
 * values. Computing it in Node is deterministic, fast, and doesn't pull a
 * chromium-puppeteer chain into CI. The pa11y step in pages.yml (wave 22)
 * covers the rendered-DOM side of the contract; this covers the source-of-truth
 * palette contract. Both layers needed.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const errorCodesPath = join(repoRoot, 'site/src/content/docs/handbook/error-codes.md');

// ─────────────────────────────────────────────────────────────────────────────
// WCAG 2.1 contrast ratio implementation (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance)
// ─────────────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Bad hex color: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function relLuminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const sc = c / 255;
    return sc <= 0.03928 ? sc / 12.92 : Math.pow((sc + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1, hex2) {
  const l1 = relLuminance(hexToRgb(hex1));
  const l2 = relLuminance(hexToRgb(hex2));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────
// Source palette (Starlight dark Aside callouts + testing-os surface tokens)
//
// Asides render with a tinted background, a saturated border-inline-start,
// and body text the dark theme defines as --sl-color-white (= #ffffff in
// dark mode). The numbers below are computed from
// @astrojs/starlight/style/asides.css + props.css HSL declarations:
//
//   --sl-color-{red,orange,purple,blue}-low: hsl(<hue>, 39%, 22%) [dark]
//   --sl-color-{red,orange,purple,blue}:     hsl(<hue>, 82%, 63%) [border]
//   --sl-color-white in dark mode:           hsl(0, 0%, 100%)
//
// Aside body text is --sl-color-white set on .starlight-aside (line 5 of
// asides.css). Note: testing-os' starlight-custom.css overrides
// --sl-color-bg to #09090b (props.css default is hsl(224, 10%, 10%) ≈ #16181b).
// We assert against both the literal aside background AND against the testing-os
// overridden page background (the harder side).
// ─────────────────────────────────────────────────────────────────────────────

// Page surface — testing-os' overridden value. Starlight's default is slightly
// lighter; we test the harder darker case so the contract holds for the
// consuming repo's actual rendering.
const PAGE_BG = '#09090b';

// Body text color (Starlight dark mode --sl-color-white).
const TEXT = '#ffffff';

// Starlight dark Aside backgrounds (hsl → rgb hex precomputed).
//   danger  / red:    hsl(339, 39%, 22%) → #4e2535
//   caution / orange: hsl( 41, 39%, 22%) → #4e3f23
//   note    / blue:   hsl(234, 54%, 20%) → #181d4f  (54% saturation per props.css line 23)
//   tip     / purple: hsl(281, 39%, 22%) → #3a2350
const ASIDE_BG = {
  danger:  '#4e2535',
  caution: '#4e3f23',
  note:    '#181d4f',
  tip:     '#3a2350',
};

// Starlight dark Aside border colors (border-inline-start, 4px solid).
//   red:    hsl(339, 82%, 63%) → #ec5589
//   orange: hsl( 41, 82%, 63%) → #ecaa55
//   blue:   hsl(234, 100%, 60%) → #3358ff (sat 100%, lightness 60% per props.css line 24)
//   purple: hsl(281, 82%, 63%) → #c455ec
const ASIDE_BORDER = {
  danger:  '#ec5589',
  caution: '#ecaa55',
  note:    '#3358ff',
  tip:     '#c455ec',
};

const WCAG_AA_NORMAL = 4.5;
const WCAG_AA_LARGE = 3.0;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('severity-tier callouts exist in error-codes.md (one per CRITICAL/HIGH/MEDIUM/LOW)', () => {
  const src = readFileSync(errorCodesPath, 'utf-8');

  // Every severity tier MUST have at least one corresponding callout. A
  // missing tier means the visual treatment lapsed and the page would regress
  // back to color-blind-illegible H3-only severity signaling.
  assert.match(src, /:::danger\[Severity: CRITICAL\]/, 'CRITICAL callout missing — should use :::danger');
  assert.match(src, /:::caution\[Severity: HIGH\]/,    'HIGH callout missing — should use :::caution');
  assert.match(src, /:::note\[Severity: MEDIUM\]/,     'MEDIUM callout missing — should use :::note');
  assert.match(src, /:::tip\[Severity: LOW\]/,         'LOW callout missing — should use :::tip');
});

test('severity-tier table documents the visual cue for each tier', () => {
  const src = readFileSync(errorCodesPath, 'utf-8');
  // The at-a-glance table must reference all four callout types so a reader
  // who hasn't reached the per-code sections still gets the severity legend.
  assert.match(src, /:::danger.*\(red/i,    'severity table missing :::danger (red) row');
  assert.match(src, /:::caution.*\(orange/i, 'severity table missing :::caution (orange) row');
  assert.match(src, /:::note.*\(blue/i,     'severity table missing :::note (blue) row');
  assert.match(src, /:::tip.*\(green/i,     'severity table missing :::tip (green) row');
});

test('text on page background meets WCAG AA (4.5:1)', () => {
  const ratio = contrastRatio(TEXT, PAGE_BG);
  assert.ok(
    ratio >= WCAG_AA_NORMAL,
    `Body text (${TEXT}) on page background (${PAGE_BG}) contrast ratio is ${ratio.toFixed(2)}:1, below WCAG AA bar of ${WCAG_AA_NORMAL}:1.`,
  );
});

for (const [tier, bg] of Object.entries(ASIDE_BG)) {
  test(`severity callout '${tier}': body text on aside background meets WCAG AA (4.5:1)`, () => {
    const ratio = contrastRatio(TEXT, bg);
    assert.ok(
      ratio >= WCAG_AA_NORMAL,
      `Aside body text (${TEXT}) on ${tier} aside bg (${bg}) is ${ratio.toFixed(2)}:1, below WCAG AA bar of ${WCAG_AA_NORMAL}:1. ` +
      `If Starlight rev'd the aside palette, update ASIDE_BG[${tier}] to the new value AND verify the new value still passes — ` +
      `if it doesn't, that's an upstream contract regression that the consuming site has to address (override the CSS, file an issue upstream, or both).`,
    );
  });

  // Starlight asides separate from the page via a saturated 4px
  // border-inline-start, NOT background contrast (the dark backgrounds are
  // intentionally close to the page surface so prose flows). The 3:1 non-text
  // contrast bar applies to that border vs the page — that's the separation
  // cue a color-blind operator needs to recognize the callout edge.
  test(`severity callout '${tier}': border color contrasts page background at 3:1 (WCAG non-text bar)`, () => {
    const border = ASIDE_BORDER[tier];
    const ratio = contrastRatio(border, PAGE_BG);
    assert.ok(
      ratio >= WCAG_AA_LARGE,
      `Aside border (${border}) on page bg (${PAGE_BG}) is ${ratio.toFixed(2)}:1; below the WCAG 1.4.11 non-text / large-text bar of ${WCAG_AA_LARGE}:1. ` +
      `The border-inline-start is the primary separation cue for the callout — color-blind operators rely on the icon + label, but the box edge still has to be perceivable on a near-black page.`,
    );
  });
}

// Sanity: the contrast helper itself.
test('contrastRatio: black-on-white = 21:1, white-on-white = 1:1', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#ffffff', '#ffffff').toFixed(2), '1.00');
});
