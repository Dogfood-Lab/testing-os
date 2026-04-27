#!/usr/bin/env node

/**
 * findings-digest.js — read-only helper
 *
 * Flattens all per-domain wave outputs into one markdown findings table.
 * Purely additive — reads the per-domain `<domain>.json` files that agents
 * write to the wave directory. Does not touch the DB, does not modify any
 * swarm state.
 *
 * File-glob contract: a wave dir contains both prompt files (`<domain>.md`)
 * and agent output files (`<domain>.json`). Some legacy waves (and a small
 * set of generated artifacts in collect/persist) also drop manifest-style
 * JSON like `manifest.json`, `summary.json`, `submission.json`, or
 * `audit-payload.json`. The digest filters those reserved names out so it
 * only iterates true per-domain agent outputs.
 *
 * Usage:
 *   node findings-digest.js <run-id> [wave-number]
 *
 * Defaults to the highest-numbered wave directory under the run.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { renderDigest, renderMarkdown } from './findings-render.js';

const SWARMS_DIR = resolve(import.meta.dirname, '../../../swarms');

export function findLatestWave(runDir) {
  const entries = readdirSync(runDir);
  const waves = entries
    .filter((e) => /^wave-\d+$/.test(e) && statSync(join(runDir, e)).isDirectory())
    .map((e) => parseInt(e.replace('wave-', ''), 10))
    .sort((a, b) => b - a);
  if (waves.length === 0) throw new Error(`No wave directories in ${runDir}`);
  return waves[0];
}

// Reserved JSON filenames that may appear alongside per-domain outputs in a
// wave dir but are NOT agent output. Anything ending in `.output.json` is also
// stripped to its bare domain so legacy `<domain>.output.json` waves still
// work; the canonical convention emitted by dispatch+collect is `<domain>.json`.
const RESERVED_WAVE_JSON = new Set([
  'manifest.json',
  'summary.json',
  'submission.json',
  'audit-payload.json',
]);

export function loadDomainOutputs(waveDir) {
  const entries = readdirSync(waveDir).filter((e) => {
    if (!e.endsWith('.json')) return false;
    if (RESERVED_WAVE_JSON.has(e)) return false;
    return true;
  });
  const outputs = [];
  for (const entry of entries) {
    // Tolerate the older `<domain>.output.json` shape if a stale wave dir is
    // ever reprocessed — strip whichever suffix is present.
    const domain = entry.replace(/\.output\.json$/, '').replace(/\.json$/, '');
    const raw = readFileSync(join(waveDir, entry), 'utf8');
    try {
      const parsed = JSON.parse(raw);
      outputs.push({ domain, parsed });
    } catch (err) {
      outputs.push({ domain, parseError: err.message });
    }
  }
  return outputs;
}

const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * Render the digest as markdown.
 *
 * Back-compat surface: returns a string. Callers that need the operator-state
 * disambiguation (clean / findings / pipeline_broken) and the matching CLI
 * exit code should call `renderWithStatus()` instead. This thin wrapper
 * preserves every pre-wave-18 caller.
 */
export function render(runId, waveNumber, outputs) {
  return renderWithStatus(runId, waveNumber, outputs).output;
}

/**
 * F-091578-034 — empty-state digest 3-way disambiguation.
 *
 * Three operator scenarios used to render identically (bare `Total: 0`):
 *   (a) clean wave              → exit 0, "All clear" header
 *   (b) findings present        → exit 1, "N findings: …" header
 *   (c) audit pipeline broken   → exit 2, "Audit pipeline failure" header +
 *                                 "THIS IS NOT A CLEAN WAVE." anti-confusion line
 *
 * Pipeline-broken triggers (any of):
 *   - At least one domain output failed to parse (parseError populated)
 *   - Zero domain outputs were loaded at all (wave dir empty / dispatch failed
 *     to write any per-domain output)
 *
 * The exit code MUST propagate through the CLI seam so CI integrations can
 * use `swarm findings <run>` as a gate. Operator may be running this in an
 * unattended context where the only signal CI ever sees is the exit code.
 *
 * F-827321-002 (wave-23): rendering is delegated to `lib/findings-render.js`,
 * which carries the TTY-aware text/markdown/json multi-format renderer. This
 * function preserves its pre-wave-23 markdown output by default so existing
 * callers (CI scrapers, `swarm findings <run> > digest.md` redirects, the
 * back-compat `render()` wrapper, all wave9/18 tests) keep working unchanged.
 *
 * Returns: { output: string, status: 'clean'|'findings'|'pipeline_broken', exitCode: 0|1|2, model }
 */
export function renderWithStatus(runId, waveNumber, outputs) {
  const model = buildDigestModel(runId, waveNumber, outputs);
  return {
    output: renderMarkdown(model),
    status: model.status,
    exitCode: model.exitCode,
    model,
  };
}

/**
 * Build the renderer-agnostic digest model.
 *
 * Single source of truth for what's in the digest — the markdown/text/json
 * renderers in lib/findings-render.js all consume this same shape. Splitting
 * model-build from rendering is the wave-23 wrapper-strip pattern: a future
 * renderer cannot drift from the markdown shape because they all read from
 * the same fields.
 */
export function buildDigestModel(runId, waveNumber, outputs) {
  const allFindings = [];
  const noFindingSummaries = [];
  const parseErrors = [];

  for (const { domain, parsed, parseError } of outputs) {
    if (parseError) {
      parseErrors.push({ domain, parseError });
      continue;
    }
    const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
    if (findings.length === 0) {
      noFindingSummaries.push({ domain, summary: parsed?.summary || '(no summary)' });
      continue;
    }
    for (const f of findings) {
      allFindings.push({ domain, ...f });
    }
  }

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let unknownCount = 0;
  const unknownSamples = [];
  for (const f of allFindings) {
    if (counts[f.severity] !== undefined) {
      counts[f.severity] += 1;
    } else {
      unknownCount += 1;
      if (unknownSamples.length < 5) {
        unknownSamples.push({ id: f.id || '—', domain: f.domain, severity: f.severity ?? '(missing)' });
      }
    }
  }

  // Operator signal — disagreement between Total and per-severity sum is otherwise silent.
  // The original digest dropped malformed-severity findings on the floor with no log.
  if (unknownCount > 0) {
    console.warn(
      `findings-digest: ${unknownCount} finding(s) with unknown/missing severity ` +
      `(samples: ${unknownSamples.map(s => `${s.id}@${s.domain}=${s.severity}`).join(', ')})`
    );
  }

  // Three-way state determination — order matters: pipeline-broken is the
  // loudest case and must override an apparent "clean" reading whenever ANY
  // domain output failed to parse, or when no outputs were loaded at all.
  // The "wrong shape" we explicitly defend against: every domain failed to
  // emit a parseable JSON, allFindings is empty, but a naïve check would
  // call this case (a) ALL CLEAR.
  const totalDomains = outputs.length;
  const failedDomains = parseErrors.length;
  const reportedDomains = totalDomains - failedDomains;
  let status, exitCode;
  if (totalDomains === 0 || failedDomains > 0) {
    status = 'pipeline_broken';
    exitCode = 2;
  } else if (allFindings.length === 0) {
    status = 'clean';
    exitCode = 0;
  } else {
    status = 'findings';
    exitCode = 1;
  }

  allFindings.sort((a, b) => {
    const sa = SEV_ORDER[a.severity] ?? 9;
    const sb = SEV_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    return (a.id || '').localeCompare(b.id || '');
  });

  return {
    runId,
    waveNumber,
    status,
    exitCode,
    counts,
    unknownCount,
    findings: allFindings,
    noFindingSummaries,
    parseErrors,
    totalDomains,
    failedDomains,
    reportedDomains,
  };
}

/**
 * Build a digest for the given run + wave (defaults to latest wave).
 *
 * Returns { runId, waveNumber, output, status, exitCode, model } — `output` is
 * the rendered string in the resolved format (defaults to TTY-aware: text on
 * an interactive terminal, markdown when piped/redirected); `status` is one
 * of 'clean' | 'findings' | 'pipeline_broken'; `exitCode` is the matching CLI
 * exit code (0 / 1 / 2). The `model` is the renderer-agnostic digest shape
 * for callers that want to render it differently.
 *
 * `format` opts: 'text' | 'markdown' | 'json' | undefined (auto-detect).
 * `stream` opts: a writable stream — its `.isTTY` property drives the
 * auto-detect path. Defaults to `process.stdout` (CLI default). Tests inject
 * a fake stream to verify the decision matrix without spawning subprocesses.
 *
 * Throws on missing run/wave.
 */
export function buildDigest({ runId, waveNumber, swarmsDir = SWARMS_DIR, format, stream }) {
  const runDir = join(swarmsDir, runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }
  const resolvedWave = waveNumber ?? findLatestWave(runDir);
  const waveDir = join(runDir, `wave-${resolvedWave}`);
  if (!existsSync(waveDir)) {
    throw new Error(`Wave directory not found: ${waveDir}`);
  }
  const outputs = loadDomainOutputs(waveDir);
  const model = buildDigestModel(runId, resolvedWave, outputs);
  const output = renderDigest(model, format, stream);
  return {
    runId,
    waveNumber: resolvedWave,
    output,
    status: model.status,
    exitCode: model.exitCode,
    model,
  };
}

// Only run as a CLI when invoked directly (not when imported by cli.js).
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
               process.argv[1]?.endsWith('findings-digest.js');

if (isMain) {
  const [runId, waveArg] = process.argv.slice(2);
  if (!runId) {
    console.error('Usage: node findings-digest.js <run-id> [wave-number]');
    process.exit(1);
  }
  try {
    const { output, exitCode } = buildDigest({
      runId,
      waveNumber: waveArg ? parseInt(waveArg, 10) : undefined,
    });
    console.log(output);
    // F-091578-034 — propagate the 3-way state as an exit code so CI gates
    // can act on it. 0 clean / 1 findings / 2 pipeline-broken.
    process.exit(exitCode);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
