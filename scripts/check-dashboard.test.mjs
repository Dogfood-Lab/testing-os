/**
 * check-dashboard.test.mjs — structural regression pins for the fleet
 * dashboard at site/public/dashboard/index.html.
 *
 * The dashboard is authored in Claude Design (single self-contained HTML,
 * patched version-by-version) and verified + mounted here by the
 * coordinator. These pins make the verified properties CI-enforced so a
 * future swap or hand-edit that regresses one goes RED in `test:scripts`
 * instead of shipping silently:
 *
 *   1. self-containment — the only external hosts are the read-model
 *      (raw.githubusercontent.com), the shields badge renderer, and the
 *      project's own doc/repo links; no external <script src>/<link href>.
 *   2. the CONFIG contract — production re-points data URLs through ONE
 *      CONFIG object; if its keys move, the tie-in breaks.
 *   3. honest states — the per-endpoint failure copy, the empty-fleet
 *      hero, and the zero states are the product's brand.
 *   4. a11y floor — lang attr, dialog semantics, aria density,
 *      reduced-motion support.
 *   5. size budget + no eval + namespaced localStorage.
 *
 * pa11y runs WCAG2AA against the DEPLOYED /dashboard/ page in pages.yml;
 * these pins are the pre-deploy static half of that gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASH = join(repoRoot, 'site', 'public', 'dashboard', 'index.html');
const src = readFileSync(DASH, 'utf-8');

const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com', // the read-model (CONFIG-derived)
  'img.shields.io',            // badge preview, modal-open only
  'github.com',                // repo + record links
  'dogfood-lab.github.io',     // handbook / dashboard self-links
]);

test('dashboard: self-contained — no external script/style loads', () => {
  assert.doesNotMatch(src, /<script[^>]+src=/i, 'external <script src> found');
  assert.doesNotMatch(src, /<link[^>]+href="http/i, 'external <link href> found');
  assert.doesNotMatch(src, /@import\s+url\(\s*["']?http/i, 'external CSS @import found');
});

test('dashboard: only allowed external hosts are referenced', () => {
  const hosts = new Set(
    [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1].toLowerCase())
  );
  const offenders = [...hosts].filter(h => !ALLOWED_HOSTS.has(h));
  assert.deepEqual(offenders, [],
    `unexpected external host(s): ${offenders.join(', ')} — the dashboard is self-contained by contract`);
});

test('dashboard: CONFIG contract keys present', () => {
  const cfg = src.match(/const CONFIG = \{[\s\S]*?\n\};/);
  assert.ok(cfg, 'CONFIG object not found in first script region');
  for (const key of ['base', 'latest', 'trends', 'stale', 'failing', 'aggregate',
                     'refreshMs', 'links', 'badgeJsonBase', 'shieldsEndpoint', 'selfRepo']) {
    assert.ok(cfg[0].includes(key), `CONFIG missing key: ${key}`);
  }
});

test('dashboard: honest states present (the brand)', () => {
  assert.match(src, /couldn'?t fetch/i, 'per-endpoint failure copy missing');
  assert.match(src, /no evidence recorded yet/i, 'empty-fleet hero missing');
  assert.match(src, /nothing failing/i, 'failing-card zero state missing');
  assert.doesNotMatch(src, /\beval\s*\(/, 'eval() is forbidden');
});

test('dashboard: a11y floor', () => {
  assert.match(src, /<html[^>]+lang="/, 'html lang attribute missing');
  assert.match(src, /<dialog/, 'native <dialog> missing');
  assert.ok((src.match(/aria-/g) || []).length >= 15, 'aria attribute density regressed below 15');
  assert.match(src, /prefers-reduced-motion/, 'reduced-motion support missing');
  assert.match(src, /<meta name="viewport"/, 'viewport meta missing');
});

test('dashboard: size budget and version marker', () => {
  const bytes = Buffer.byteLength(src, 'utf-8');
  assert.ok(bytes <= 90 * 1024, `dashboard is ${bytes} bytes — budget is 90 KB; trim before shipping`);
  assert.match(src, /dogfood-dashboard-v\d+\.\d+/, 'version marker missing from the file');
});

test('dashboard: localStorage stays namespaced', () => {
  const raw = [...src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*["']([^"']+)["']/g)]
    .map(m => m[1]);
  const literal = [...src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*LS\s*\+/g)];
  const offenders = raw.filter(k => !k.startsWith('dogfood-dashboard.'));
  assert.deepEqual(offenders, [],
    `un-namespaced localStorage key(s): ${offenders.join(', ')}`);
  assert.ok(raw.length + literal.length > 0, 'expected at least one localStorage use');
});

test('dashboard: inline JS parses (syntax gate)', () => {
  const scripts = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 1, 'no inline scripts found');
  for (const [i, body] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(body), `inline script #${i + 1} failed to parse`);
  }
});
