/**
 * Handbook supporting-imagery + responsive-content tests.
 *
 * Stage D wave 23, covers four findings in one suite:
 *   D-DOCS-002 (F-827321-018) — mobile nav disclosure exists in BaseLayout
 *   D-DOCS-007 (F-827321-023) — surviving ASCII fits in 320px viewport
 *   D-DOCS-008 (F-827321-024) — supporting imagery exists with alt text
 *   D-DOCS-001 (F-827321-017, sibling slot) — severity callouts already
 *      verified in check-severity-contrast.test.mjs
 *
 * Why one suite per concern grouped here: each is a small static-source
 * check, and grouping keeps the script directory legible. They share no
 * state and run independently.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const handbookDir = join(repoRoot, 'site/src/content/docs/handbook');
const baseLayoutPath = join(repoRoot, 'site/src/components/BaseLayout.astro');
const archDiagramPath = join(repoRoot, 'site/public/diagrams/architecture.svg');
const verifyShotPath = join(repoRoot, 'site/public/screenshots/verify-output.svg');

// The maximum line width (in characters) we consider safe inside a mobile
// 320px viewport with the handbook's monospace font. 60 chars is the Starlight
// docs convention; we run at 64 to allow a tiny margin for the rare line that's
// just over and still readable on portrait phones.
const MAX_ASCII_WIDTH = 64;

// ─────────────────────────────────────────────────────────────────────────────
// D-DOCS-002 / F-827321-018 — Mobile nav disclosure
// ─────────────────────────────────────────────────────────────────────────────

test('BaseLayout includes a <details> mobile nav disclosure that is md:hidden', () => {
  const src = readFileSync(baseLayoutPath, 'utf-8');
  // The <details>/<summary> pattern is the no-JS conventional answer per the
  // director's brief; the md:hidden bound makes desktop layout unchanged.
  assert.match(
    src,
    /<details\s+class="[^"]*md:hidden[^"]*">/,
    'BaseLayout missing <details class="...md:hidden..."> mobile nav disclosure — F-827321-018 regressed (phones get no nav).',
  );
  assert.match(
    src,
    /<summary[^>]*aria-label="Open menu"/,
    'mobile nav <summary> missing aria-label="Open menu" — screen readers need an accessible name on the disclosure trigger.',
  );
});

test('BaseLayout mobile nav reuses the same nav[] items the desktop nav uses', () => {
  const src = readFileSync(baseLayoutPath, 'utf-8');
  // The mobile nav must map over `nav` exactly like desktop. Two `nav.map(`
  // calls in the file confirms — one inside <nav class="...md:flex">, one
  // inside the <details>. If only one survives, the mobile nav got out of
  // sync with the desktop nav (or was deleted).
  const matches = src.match(/nav\.map\(/g) ?? [];
  assert.ok(
    matches.length >= 2,
    `Expected at least 2 \`nav.map(\` calls (desktop + mobile); found ${matches.length}. The mobile <details> nav may have lost its nav.map().`,
  );
});

test('BaseLayout mobile nav <nav> has aria-label so it is distinguishable from the desktop <nav>', () => {
  const src = readFileSync(baseLayoutPath, 'utf-8');
  assert.match(
    src,
    /aria-label="Mobile navigation"/,
    'mobile <nav> missing aria-label="Mobile navigation" — screen readers see two unlabeled <nav> landmarks otherwise.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D-DOCS-008 / F-827321-024 — Supporting imagery exists with alt text
// ─────────────────────────────────────────────────────────────────────────────

test('Architecture diagram SVG exists and is non-trivial in size', () => {
  assert.ok(existsSync(archDiagramPath), `architecture.svg missing at ${archDiagramPath}`);
  const stat = statSync(archDiagramPath);
  assert.ok(stat.size > 1500, `architecture.svg is suspiciously small (${stat.size} bytes) — likely empty or stub.`);
});

test('Architecture diagram SVG has accessible <title> and <desc> for screen readers', () => {
  const svg = readFileSync(archDiagramPath, 'utf-8');
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/, 'architecture.svg missing <title> element.');
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/, 'architecture.svg missing <desc> element — screen readers need the full data-flow narration.');
  assert.match(svg, /role="img"/, 'architecture.svg missing role="img" — needed for some assistive tech to recognize the SVG as a single image.');
  assert.match(svg, /aria-labelledby="[^"]*title[^"]*desc[^"]*"/, 'architecture.svg root must reference both title and desc via aria-labelledby.');
});

test('Verify-output CLI screenshot SVG exists and has accessible title + desc', () => {
  assert.ok(existsSync(verifyShotPath), `verify-output.svg missing at ${verifyShotPath}`);
  const svg = readFileSync(verifyShotPath, 'utf-8');
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/, 'verify-output.svg missing <title>.');
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/, 'verify-output.svg missing <desc> — screen readers need the narration of what a healthy output looks like.');
});

test('architecture.md references the architecture diagram with a non-trivial alt attribute', () => {
  const md = readFileSync(join(handbookDir, 'architecture.md'), 'utf-8');
  assert.match(md, /\/diagrams\/architecture\.svg/, 'architecture.md does not reference /diagrams/architecture.svg.');
  // Pull out the alt= for the architecture image and verify it's substantive.
  const m = /<img[^>]*src="[^"]*architecture\.svg"[^>]*alt="([^"]+)"/.exec(md);
  assert.ok(m, '<img> for architecture.svg missing alt attribute.');
  assert.ok(
    m[1].length >= 80,
    `Architecture diagram alt text is only ${m[1].length} chars — needs to narrate the actual data flow for screen readers, not just say "architecture diagram".`,
  );
});

test('beginners.md references the verify-output CLI screenshot with non-trivial alt', () => {
  const md = readFileSync(join(handbookDir, 'beginners.md'), 'utf-8');
  assert.match(md, /\/screenshots\/verify-output\.svg/, 'beginners.md does not reference /screenshots/verify-output.svg.');
  const m = /<img[^>]*src="[^"]*verify-output\.svg"[^>]*alt="([^"]+)"/.exec(md);
  assert.ok(m, '<img> for verify-output.svg missing alt attribute.');
  assert.ok(
    m[1].length >= 80,
    `verify-output alt text is only ${m[1].length} chars — needs to describe what a healthy run shows so blind operators can confirm success without seeing the image.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D-DOCS-007 / F-827321-023 — Surviving ASCII fits in 320px viewport
// ─────────────────────────────────────────────────────────────────────────────

test(`Every ASCII / text fence in handbook *.md fits within ${MAX_ASCII_WIDTH} chars (320px viewport)`, async () => {
  const { readdirSync } = await import('node:fs');
  const overruns = [];

  for (const entry of readdirSync(handbookDir)) {
    if (!entry.endsWith('.md')) continue;
    const file = join(handbookDir, entry);
    const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
    let inFence = false;
    let fenceLang = '';
    lines.forEach((line, idx) => {
      const m = /^```(.*)$/.exec(line);
      if (m) {
        if (!inFence) {
          inFence = true;
          fenceLang = m[1].trim();
        } else {
          inFence = false;
          fenceLang = '';
        }
        return;
      }
      // Only police text/ASCII fences. Code (bash/yaml/json/ts) frequently
      // exceeds 64 chars for legitimate reasons (long URLs, JSON strings) and
      // operators read code with horizontal scroll; the visual-hierarchy
      // concern is specifically about the text/ASCII diagrams that double as
      // documentation surface.
      if (!inFence) return;
      if (fenceLang !== 'text') return;
      if (line.length > MAX_ASCII_WIDTH) {
        overruns.push(`${entry}:${idx + 1} (${line.length} chars): ${line.slice(0, 80)}...`);
      }
    });
  }

  assert.equal(
    overruns.length,
    0,
    `${overruns.length} ASCII/text fence line(s) exceed ${MAX_ASCII_WIDTH} chars and would horizontal-scroll on a 320px phone:\n  ` +
    overruns.join('\n  ') +
    `\n\nReflow the offending lines (split arrows onto their own line, abbreviate paths, drop the longest column) — the contract is "renders without horizontal scroll on a portrait phone."`,
  );
});
