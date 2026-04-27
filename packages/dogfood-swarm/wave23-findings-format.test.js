/**
 * wave23-findings-format.test.js — Wave-23 backend findings-renderer receipts.
 *
 * F-827321-002 (D-BACK-002): `swarm findings <run>` printed raw markdown
 * (`**bold**`, `| pipe | tables |`, `## Header`) directly to stdout via a
 * single `console.log(output)` with no TTY check and no `--format` switch.
 * An operator running it interactively saw markdown soup; CI scrapers and
 * `>` redirects parsed it fine. The fix extends wave-17's `shouldEmitHuman()`
 * pattern to the digest renderer:
 *
 *   - default `text` when `process.stdout.isTTY` (interactive terminal)
 *   - default `markdown` when piped/redirected (back-compat for CI + `>`)
 *   - explicit `--format=text|markdown|json` overrides the auto-detect
 *   - `DOGFOOD_FINDINGS_FORMAT=raw|human|json` env overrides everything
 *     (symmetric to `DOGFOOD_LOG_HUMAN`)
 *
 * Tests are organized as a receipt for each contract the wave-23 fix lands:
 *
 *   1. shouldEmitFormat decision matrix    (TTY / env / explicit override)
 *   2. Each --format value renders right    (text / markdown / json)
 *   3. DOGFOOD_FINDINGS_FORMAT env override (raw → markdown, human → text, json → json)
 *   4. Markdown regression guard            (rendered shape unchanged from pre-wave-23)
 *   5. F-091578-034 disambiguation survives in every format
 *   6. Sweep invariant                      (no other CLI subcommand emits raw markdown)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shouldEmitFormat,
  renderDigest,
  renderMarkdown,
  renderText,
  renderJson,
} from './lib/findings-render.js';
import {
  buildDigestModel,
  renderWithStatus,
} from './lib/findings-digest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper — suppress the console.warn that buildDigestModel emits when a
// finding has unknown severity. Tests that don't probe that path want a
// silent stderr.
function suppressWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}

function tty() { return { isTTY: true }; }
function pipe() { return { isTTY: false }; }

// Canonical fixtures — used across the renderer-shape tests so a regression
// in one renderer can't be hidden by a fixture-only edit.
const FIXTURE_OUTPUTS_FINDINGS = [
  {
    domain: 'backend',
    parsed: {
      findings: [
        { id: 'F-001', severity: 'CRITICAL', file: 'src/a.js', line: 12,
          description: 'a critical thing exploded' },
        { id: 'F-002', severity: 'HIGH', file: 'src/b.js',
          description: 'a high-severity thing wobbled' },
        { id: 'F-003', severity: 'LOW', file: 'src/c.js',
          description: 'a low-priority thing whispered' },
      ],
    },
  },
  {
    domain: 'frontend',
    parsed: {
      findings: [
        { id: 'F-004', severity: 'MEDIUM', file: 'ui/x.tsx', line: 7,
          description: 'medium concern in a component' },
      ],
      summary: 'one issue',
    },
  },
  {
    domain: 'docs',
    parsed: { findings: [], summary: 'docs are fine' },
  },
];

// ═══════════════════════════════════════════
// 1. shouldEmitFormat decision matrix
// ═══════════════════════════════════════════

describe('shouldEmitFormat — TTY / env / explicit override matrix', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.DOGFOOD_FINDINGS_FORMAT; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DOGFOOD_FINDINGS_FORMAT;
    else process.env.DOGFOOD_FINDINGS_FORMAT = originalEnv;
  });

  it('defaults to "text" when stream.isTTY === true (interactive terminal)', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    assert.equal(shouldEmitFormat(undefined, tty()), 'text');
  });

  it('defaults to "markdown" when stream.isTTY is falsy (pipe / redirect / CI)', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    assert.equal(shouldEmitFormat(undefined, pipe()), 'markdown');
  });

  it('explicit "text" wins over pipe context', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    assert.equal(shouldEmitFormat('text', pipe()), 'text');
  });

  it('explicit "markdown" wins over TTY context', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    assert.equal(shouldEmitFormat('markdown', tty()), 'markdown');
  });

  it('explicit "json" wins over TTY context', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    assert.equal(shouldEmitFormat('json', tty()), 'json');
  });

  it('DOGFOOD_FINDINGS_FORMAT=raw forces markdown even on TTY (symmetric to DOGFOOD_LOG_HUMAN=0)', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'raw';
    assert.equal(shouldEmitFormat(undefined, tty()), 'markdown');
    assert.equal(shouldEmitFormat('text', tty()), 'markdown',
      'env override must beat the explicit --format flag');
  });

  it('DOGFOOD_FINDINGS_FORMAT=human forces text even when piped (symmetric to DOGFOOD_LOG_HUMAN=1)', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'human';
    assert.equal(shouldEmitFormat(undefined, pipe()), 'text');
    assert.equal(shouldEmitFormat('markdown', pipe()), 'text',
      'env override must beat the explicit --format flag');
  });

  it('DOGFOOD_FINDINGS_FORMAT=json overrides everything', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'json';
    assert.equal(shouldEmitFormat(undefined, tty()), 'json');
    assert.equal(shouldEmitFormat('text', pipe()), 'json');
    assert.equal(shouldEmitFormat('markdown', tty()), 'json');
  });

  it('unknown env value falls back through to TTY auto-detect (no surprises)', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'garbage';
    assert.equal(shouldEmitFormat(undefined, tty()), 'text');
    assert.equal(shouldEmitFormat(undefined, pipe()), 'markdown');
  });

  it('unknown explicit format value falls back through to TTY auto-detect', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    assert.equal(shouldEmitFormat('xml', tty()), 'text');
    assert.equal(shouldEmitFormat('csv', pipe()), 'markdown');
  });
});

// ═══════════════════════════════════════════
// 2. Each --format value renders correctly
// ═══════════════════════════════════════════

describe('renderDigest — text / markdown / json each render the same model coherently', () => {
  it('text format: drops **wrappers**, drops | pipe tables |, uses underlined headers', () => {
    const model = buildDigestModel('r-fmt', 1, FIXTURE_OUTPUTS_FINDINGS);
    const text = renderText(model);

    // No markdown bold wrappers in the body.
    assert.doesNotMatch(text, /\*\*[A-Z][a-z]/,
      'text renderer must not contain **bold** markdown wrappers');
    // No pipe-tables.
    assert.doesNotMatch(text, /^\| .* \|/m,
      'text renderer must not contain markdown pipe tables');
    // No `## Header` lines (they are replaced by underlined sections).
    assert.doesNotMatch(text, /^## /m,
      'text renderer must not contain raw markdown ## headers');
    // Verdict-first banner at the top, before per-finding rows.
    assert.match(text, /VERDICT: 4 FINDINGS/,
      'text renderer must surface a verdict-first banner per wave-17 discipline');
    // Underlined section break for "Findings" details.
    assert.match(text, /Findings\n-+/, 'text renderer must underline subsection headers');
    // Underlined title for the document head.
    assert.match(text, /Findings Digest — r-fmt wave 1\n=+/);
    // Severity counts present.
    assert.match(text, /CRIT 1 \| HIGH 1 \| MED 1 \| LOW 1/);
    // Per-finding rows are aligned (each finding ID appears).
    assert.match(text, /F-001/);
    assert.match(text, /F-002/);
    assert.match(text, /F-003/);
    assert.match(text, /F-004/);
  });

  it('text format: aligned columns use String.padEnd matching widest cell per column', () => {
    const model = buildDigestModel('r-align', 1, [
      {
        domain: 'backend',
        parsed: {
          findings: [
            { id: 'F-1', severity: 'CRITICAL', file: 'a.js',
              description: 'short desc' },
            { id: 'F-LONG-22', severity: 'LOW', file: 'verylongpath/file.js', line: 999,
              description: 'longer description text' },
          ],
        },
      },
    ]);
    const text = renderText(model);
    const lines = text.split('\n');

    // Find the rows for F-1 and F-LONG-22 — they share a header row above.
    const rowF1 = lines.find(l => l.includes('F-1 ') || l.includes('F-1 '));
    const rowFLong = lines.find(l => l.includes('F-LONG-22'));
    assert.ok(rowF1, 'F-1 row must be rendered');
    assert.ok(rowFLong, 'F-LONG-22 row must be rendered');

    // Both rows must align — same starting column for the description text.
    // The description sits after the file:line column. We assert: both rows
    // contain at least one run of two spaces immediately preceding the
    // description, which is the padEnd-output signature.
    assert.match(rowF1, /\s{2,}short desc/);
    assert.match(rowFLong, /\s{2,}longer description text/);
  });

  it('markdown format: keeps **bold** + | pipe tables | + ## headers exactly as pre-wave-23', () => {
    const model = buildDigestModel('r-md', 1, FIXTURE_OUTPUTS_FINDINGS);
    const md = renderMarkdown(model);

    assert.match(md, /\*\*4 findings:\*\*/, 'markdown renderer must keep **bold** wrappers');
    assert.match(md, /^\| Sev \| ID \| Domain \| File:Line \| Description \|$/m,
      'markdown renderer must keep the pipe-table header');
    assert.match(md, /^## Clean domains \(0 findings\)$/m,
      'markdown renderer must keep ## section headers');
    assert.match(md, /\*\*Total:\*\* 4/);
  });

  it('json format: structured envelope with stable status / exitCode / counts / findings', () => {
    const model = buildDigestModel('r-json', 1, FIXTURE_OUTPUTS_FINDINGS);
    const json = renderJson(model);
    const parsed = JSON.parse(json);

    assert.equal(parsed.runId, 'r-json');
    assert.equal(parsed.waveNumber, 1);
    assert.equal(parsed.status, 'findings');
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.totals.findings, 4);
    assert.equal(parsed.totals.domainsTotal, 3);
    assert.equal(parsed.totals.domainsReporting, 3);
    assert.equal(parsed.totals.domainsFailed, 0);
    assert.equal(parsed.counts.CRITICAL, 1);
    assert.equal(parsed.counts.HIGH, 1);
    assert.equal(parsed.counts.MEDIUM, 1);
    assert.equal(parsed.counts.LOW, 1);
    assert.equal(parsed.findings.length, 4);
    assert.equal(parsed.findings[0].id, 'F-001',
      'findings must be sorted by severity (critical first)');
    assert.equal(parsed.cleanDomains.length, 1);
    assert.equal(parsed.cleanDomains[0].domain, 'docs');
    assert.equal(parsed.parseErrors.length, 0);
    assert.match(parsed.headline, /^4 findings/);
  });

  it('renderDigest dispatches based on format arg (smoke check the public seam)', () => {
    const model = buildDigestModel('r-disp', 1, FIXTURE_OUTPUTS_FINDINGS);
    const t = renderDigest(model, 'text', pipe());      // explicit beats pipe default
    const m = renderDigest(model, 'markdown', tty());   // explicit beats TTY default
    const j = renderDigest(model, 'json', tty());

    assert.match(t, /VERDICT:/);
    assert.match(m, /\*\*Total:\*\*/);
    assert.doesNotThrow(() => JSON.parse(j));
  });
});

// ═══════════════════════════════════════════
// 3. DOGFOOD_FINDINGS_FORMAT env var override
// ═══════════════════════════════════════════

describe('DOGFOOD_FINDINGS_FORMAT — env-var overrides match the wave-17 DOGFOOD_LOG_HUMAN pattern', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.DOGFOOD_FINDINGS_FORMAT; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DOGFOOD_FINDINGS_FORMAT;
    else process.env.DOGFOOD_FINDINGS_FORMAT = originalEnv;
  });

  it('DOGFOOD_FINDINGS_FORMAT=raw forces markdown via renderDigest', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'raw';
    const model = buildDigestModel('r-env-raw', 1, FIXTURE_OUTPUTS_FINDINGS);
    const out = renderDigest(model, 'text', tty());
    assert.match(out, /\*\*Total:\*\*/, 'env=raw must override --format=text');
  });

  it('DOGFOOD_FINDINGS_FORMAT=human forces text via renderDigest', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'human';
    const model = buildDigestModel('r-env-human', 1, FIXTURE_OUTPUTS_FINDINGS);
    const out = renderDigest(model, 'markdown', pipe());
    assert.match(out, /VERDICT:/, 'env=human must override --format=markdown');
    assert.doesNotMatch(out, /^\| Sev /m, 'text output must not contain markdown table');
  });

  it('DOGFOOD_FINDINGS_FORMAT=json forces JSON via renderDigest', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'json';
    const model = buildDigestModel('r-env-json', 1, FIXTURE_OUTPUTS_FINDINGS);
    const out = renderDigest(model, 'text', tty());
    assert.doesNotThrow(() => JSON.parse(out), 'env=json must produce valid JSON');
  });
});

// ═══════════════════════════════════════════
// 4. Markdown regression guard
// ═══════════════════════════════════════════

describe('markdown renderer — regression guard for back-compat with pre-wave-23 callers', () => {
  it('renderWithStatus returns the SAME markdown output it did pre-wave-23', () => {
    // The wave-9 + wave-18 + self-inspection tests all consume the markdown
    // shape from `render()` / `renderWithStatus()` / `buildDigest()` (without
    // a format arg, this stays markdown via the explicit `renderMarkdown`
    // delegation in renderWithStatus). A regression here means CI scrapers
    // and `swarm findings <run> > digest.md` redirects break.
    const { output, status, exitCode } = renderWithStatus('r-regress', 1, FIXTURE_OUTPUTS_FINDINGS);

    assert.equal(status, 'findings');
    assert.equal(exitCode, 1);
    assert.match(output, /^# Findings Digest — r-regress wave 1$/m);
    assert.match(output, /^\*\*Total:\*\* 4 \| CRIT 1 \| HIGH 1 \| MED 1 \| LOW 1$/m);
    assert.match(output, /^\| Sev \| ID \| Domain \| File:Line \| Description \|$/m);
    assert.match(output, /^\| CRIT \| F-001 \| backend \| src\/a\.js:12 \| /m);
    assert.match(output, /^## Clean domains \(0 findings\)$/m);
    assert.match(output, /^- \*\*docs\*\* — docs are fine$/m);
  });

  it('back-compat: render() still returns a string, unchanged from wave-9/wave-18', () => {
    return import('./lib/findings-digest.js').then(({ render }) => {
      const md = render('r-back-compat', 1, [
        { domain: 'x', parsed: { findings: [], summary: 'ok' } },
      ]);
      assert.equal(typeof md, 'string',
        'render() must still return a string for pre-wave-18 callers');
      assert.match(md, /Findings Digest/);
      assert.match(md, /All clear/);
    });
  });
});

// ═══════════════════════════════════════════
// 5. F-091578-034 disambiguation survives in every format
// ═══════════════════════════════════════════

describe('F-091578-034 — 3-way disambiguation preserved in text + markdown + json', () => {
  function modelFor(scenario) {
    if (scenario === 'clean') {
      return buildDigestModel('r-clean', 1, [
        { domain: 'a', parsed: { findings: [], summary: 'ok' } },
        { domain: 'b', parsed: { findings: [], summary: 'ok' } },
      ]);
    }
    if (scenario === 'pipeline_broken_all_failed') {
      return buildDigestModel('r-broken', 1, [
        { domain: 'a', parseError: 'truncated' },
        { domain: 'b', parseError: 'truncated' },
      ]);
    }
    if (scenario === 'pipeline_broken_empty') {
      return buildDigestModel('r-empty', 1, []);
    }
    return buildDigestModel('r-findings', 1, FIXTURE_OUTPUTS_FINDINGS);
  }

  it('clean wave: markdown + text + json all carry "All clear" / "ALL CLEAR"', () => {
    const m = modelFor('clean');
    assert.equal(m.exitCode, 0);
    assert.match(renderMarkdown(m), /All clear/);
    assert.match(renderText(m), /VERDICT: ALL CLEAR/);
    assert.match(JSON.parse(renderJson(m)).headline, /^All clear/);
  });

  it('pipeline_broken: every format carries the "THIS IS NOT A CLEAN WAVE." anti-confusion line', () => {
    const m1 = modelFor('pipeline_broken_all_failed');
    assert.equal(m1.exitCode, 2);
    assert.match(renderMarkdown(m1), /THIS IS NOT A CLEAN WAVE/,
      'markdown must carry the anti-confusion line');
    assert.match(renderText(m1), /THIS IS NOT A CLEAN WAVE/,
      'text must carry the anti-confusion line — operators staring at TTY are the primary audience for this signal');
    assert.equal(JSON.parse(renderJson(m1)).status, 'pipeline_broken',
      'json status must carry the structured signal so CI can gate on it');
  });

  it('pipeline_broken (empty wave): every format calls out "no domain outputs"', () => {
    const m = modelFor('pipeline_broken_empty');
    assert.equal(m.exitCode, 2);
    assert.match(renderMarkdown(m), /no domain outputs were loaded/);
    assert.match(renderText(m), /no domain outputs loaded/);
    assert.match(JSON.parse(renderJson(m)).headline, /no domain outputs loaded/);
  });

  it('findings present: every format carries the count + severity breakdown', () => {
    const m = modelFor('findings');
    assert.equal(m.exitCode, 1);
    assert.match(renderMarkdown(m), /4 findings:.*1 CRIT, 1 HIGH/);
    assert.match(renderText(m), /VERDICT: 4 FINDINGS/);
    assert.match(renderText(m), /CRIT 1 \| HIGH 1/);
    const j = JSON.parse(renderJson(m));
    assert.equal(j.totals.findings, 4);
    assert.equal(j.counts.CRITICAL, 1);
  });
});

// ═══════════════════════════════════════════
// 6. Sweep invariant — no other CLI subcommand emits raw markdown to stdout
// ═══════════════════════════════════════════

describe('Class #9 sweep invariant — only `swarm findings` may emit markdown to stdout', () => {
  it('cli.js routes every other subcommand through plain-text format helpers (formatStatus/formatVerify/formatPersist/formatResume/formatProbe) — not markdown', () => {
    // The audit: read cli.js as text and check that the only markdown-bearing
    // call is the cmdFindings path (which now goes through buildDigest's
    // TTY-aware renderer). Any future regression that adds another
    // `console.log(buildDigest(...).output)` or pipes markdown through stdout
    // for a different subcommand must update this sweep — the test's purpose
    // is to MAKE such regressions visible at PR time.
    const cliPath = resolve(__dirname, 'cli.js');
    const cli = readFileSync(cliPath, 'utf-8');

    // Every console.log of a value coming back from a `format*` helper is
    // a plain-text helper, not markdown. We assert these are the ONLY
    // top-level subcommand renderers reaching stdout (besides cmdFindings,
    // which now routes through the TTY-aware buildDigest path).
    const formatCallSites = [
      'console.log(formatStatus(s))',
      'console.log(formatResume(r))',
      'console.log(formatProbe(probes))',
      'console.log(formatVerify(result))',
      'console.log(formatPersist(result))',
    ];
    for (const site of formatCallSites) {
      assert.ok(cli.includes(site),
        `cli.js must keep the plain-text format helper call: ${site}`);
    }

    // The cmdFindings function — the ONE command whose output IS a digest —
    // must go through the wave-23 TTY-aware buildDigest path. Assert
    // the new shape is wired (format + stream args).
    assert.match(cli, /buildDigest\(\s*\{[^}]*format[^}]*stream:\s*process\.stdout/s,
      'cmdFindings must route through buildDigest with format + stream args (wave-23 TTY-aware path)');

    // Anti-regression: a future caller that does `console.log(renderMarkdown(...))`
    // or `console.log(buildDigest(...).output)` for a NEW subcommand without
    // routing through the format flag would bypass the TTY-aware path.
    // We don't currently have such a call — assert it stays that way.
    assert.equal(
      (cli.match(/console\.log\(renderMarkdown/g) || []).length,
      0,
      'cli.js must never call renderMarkdown directly — always go through renderDigest/buildDigest'
    );
  });

  it('lib/findings-digest.js is the only choke-point — markdown rendering is delegated, not duplicated', () => {
    // Internal-shape assertion: findings-digest.js MUST delegate markdown
    // rendering to findings-render.js's renderMarkdown. If a future edit
    // re-inlines a markdown template in findings-digest.js, the sweep
    // invariant breaks — the bug class becomes recurrable again because two
    // places now render markdown and one might forget the TTY check.
    const digestPath = resolve(__dirname, 'lib', 'findings-digest.js');
    const digest = readFileSync(digestPath, 'utf-8');

    assert.match(digest, /import\s*\{[^}]*renderMarkdown[^}]*\}\s*from\s*['"]\.\/findings-render\.js['"]/,
      'findings-digest.js must import renderMarkdown from findings-render.js (single choke-point)');
    assert.match(digest, /renderMarkdown\(model\)/,
      'findings-digest.js must call renderMarkdown(model) (delegation, not re-inlined template)');

    // The pipe-table header must NOT be re-inlined as a literal string in
    // findings-digest.js — it lives only in findings-render.js.
    assert.doesNotMatch(digest, /\| Sev \| ID \| Domain/,
      'findings-digest.js must not re-inline the markdown table header (delegation only)');
  });
});
