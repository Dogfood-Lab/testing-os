#!/usr/bin/env node
/**
 * check-doc-drift.mjs — config-driven documentation drift checker.
 *
 * Codifies Class #11 (multi-occurrence fix completeness) — when a contract
 * value (an error code, a status enum, a stage name, a path) lives in code
 * but is referenced in docs, the docs go stale silently. This script asserts
 * the cross-reference holds, in one place, on every CI build.
 *
 * Per Mike's wave 19 brief: "the script becomes the test." It IS the contract
 * test that asserts every error code in lib/errors.js has a corresponding
 * entry in the error-codes handbook page (and four sibling drift classes
 * besides). Adding a new check is a config edit (scripts/doc-drift-patterns.json),
 * not a code edit, unless the new check is a new KIND of comparison — in
 * which case add a handler here and a config entry there.
 *
 * Architecture:
 *   - Config (scripts/doc-drift-patterns.json) declares CHECKS.
 *   - Each check has a `kind` that selects one of the handlers below:
 *       source-vs-target-coverage   — every value extracted from sources must
 *                                     be mentioned in at least one target.
 *       forbidden-pattern-in-targets — no target may contain any pattern.
 *       self-consistency             — single target satisfies must[] / mustNot[]
 *                                      rules.
 *   - Handlers are pure functions of (check, repoRoot) → DriftReport[].
 *   - The CLI aggregates reports and exits 0 on clean / 1 on drift / 2 on
 *     misconfiguration (e.g. unknown check kind, missing source file).
 *
 * Usage:
 *   node scripts/check-doc-drift.mjs                  # run all checks
 *   node scripts/check-doc-drift.mjs --check <id>     # run single check by id
 *   node scripts/check-doc-drift.mjs --json           # machine-readable output
 *
 * Programmatic API:
 *   import { runDriftChecks } from './check-doc-drift.mjs';
 *   const result = await runDriftChecks({ repoRoot, configPath, checkId });
 *   // result = { clean: boolean, reports: DriftReport[], checksRun: number }
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {Object} DriftReport
 * @property {string} checkId          - id from the config entry
 * @property {string} severity         - 'drift' | 'config-error'
 * @property {string} message          - human-readable
 * @property {string} [file]           - file:line where drift was observed
 * @property {string} [hint]           - actionable next step
 * @property {string[]} [missing]      - for source-vs-target: missing tokens
 * @property {string[]} [forbidden]    - for forbidden-pattern: matched patterns
 */

/**
 * Run all checks (or one by id). Pure-ish — never mutates the filesystem.
 *
 * @param {Object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.configPath]
 * @param {string} [opts.checkId]
 * @returns {Promise<{ clean: boolean, reports: DriftReport[], checksRun: number, checksTotal: number }>}
 */
export async function runDriftChecks({ repoRoot, configPath, checkId }) {
  const cfgPath = configPath ?? resolve(repoRoot, 'scripts/doc-drift-patterns.json');
  if (!existsSync(cfgPath)) {
    return {
      clean: false,
      reports: [{
        checkId: '<config>',
        severity: 'config-error',
        message: `[check-doc-drift] config file not found: ${cfgPath}`,
        hint: 'Run from the repo root, or pass --config explicitly.',
      }],
      checksRun: 0,
      checksTotal: 0,
    };
  }

  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const allChecks = config.checks ?? [];
  const checks = checkId ? allChecks.filter((c) => c.id === checkId) : allChecks;

  if (checkId && checks.length === 0) {
    return {
      clean: false,
      reports: [{
        checkId,
        severity: 'config-error',
        message: `[check-doc-drift] no check with id '${checkId}' in ${relative(repoRoot, cfgPath)}`,
        hint: `Known check ids: ${allChecks.map((c) => c.id).join(', ')}`,
      }],
      checksRun: 0,
      checksTotal: allChecks.length,
    };
  }

  const reports = [];
  for (const check of checks) {
    const handler = HANDLERS[check.kind];
    if (!handler) {
      reports.push({
        checkId: check.id,
        severity: 'config-error',
        message: `[check-doc-drift] unknown check kind '${check.kind}' for check '${check.id}'`,
        hint: `Known kinds: ${Object.keys(HANDLERS).join(', ')}. To add a new kind, register a handler in scripts/check-doc-drift.mjs.`,
      });
      continue;
    }
    try {
      const checkReports = await handler(check, repoRoot);
      reports.push(...checkReports);
    } catch (err) {
      reports.push({
        checkId: check.id,
        severity: 'config-error',
        message: `[check-doc-drift] handler for '${check.id}' threw: ${err.message}`,
        hint: 'Likely a misconfigured source/target path. Verify all paths in scripts/doc-drift-patterns.json.',
      });
    }
  }

  return {
    clean: reports.length === 0,
    reports,
    checksRun: checks.length,
    checksTotal: allChecks.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers — one per check kind. Adding a new handler = adding a new drift
// CLASS. Adding a new check INSTANCE of an existing kind is config-only.
// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS = {
  'source-vs-target-coverage': sourceVsTargetCoverage,
  'forbidden-pattern-in-targets': forbiddenPatternInTargets,
  'self-consistency': selfConsistency,
  'untagged-fence': untaggedFence,
};

/**
 * Extract a set of token values from the configured sources, then assert
 * every token is mentioned in at least one target. Allowlist exempts tokens
 * that are intentionally code-only (internal plumbing not surfaced to
 * operators).
 */
async function sourceVsTargetCoverage(check, repoRoot) {
  const tokens = new Set();
  for (const source of check.sources ?? []) {
    const sourcePath = resolve(repoRoot, source);
    if (!existsSync(sourcePath)) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] source file not found: ${source}`,
        hint: 'Verify the path in scripts/doc-drift-patterns.json — it may have moved or been renamed.',
      }];
    }

    for (const extractor of check.sourceExtractors ?? []) {
      // Programmatic-evaluator extractor: import the module and read an
      // exported enum object. Only used for STATUS-shaped values where the
      // source of truth is a JS object literal that's awkward to regex.
      if (extractor.kind === 'status-enum-evaluator') {
        const modUrl = pathToFileURL(resolve(repoRoot, extractor.module)).href;
        const mod = await import(modUrl);
        const obj = mod[extractor.exportName];
        if (!obj || typeof obj !== 'object') {
          return [{
            checkId: check.id,
            severity: 'config-error',
            message: `[${check.id}] export ${extractor.exportName} from ${extractor.module} is missing or not an object`,
          }];
        }
        const skip = new Set(extractor.skipKeys ?? []);
        for (const [key, value] of Object.entries(obj)) {
          if (skip.has(key)) continue;
          if (Array.isArray(value)) {
            for (const v of value) tokens.add(v);
          }
        }
        continue;
      }

      // Regex extractor with optional fixed expansion (for template-literal
      // codes like `STATE_MACHINE_${kind}` that regex alone can't enumerate).
      if (extractor.expand) {
        // Source must be greppable for the regex; treat presence-of-pattern as
        // confirmation that the expand list is in play, then add fixed values.
        const src = readFileSync(sourcePath, 'utf8');
        const re = new RegExp(extractor.regex);
        if (re.test(src)) {
          for (const v of extractor.expand) tokens.add(v);
        }
        continue;
      }

      const src = readFileSync(sourcePath, 'utf8');
      const re = new RegExp(extractor.regex, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        const captured = m[extractor.captureGroup ?? 1];
        if (captured) tokens.add(captured);
      }
    }
  }

  const allowlist = new Set(check.allowlist ?? []);
  const requiredTokens = [...tokens].filter((t) => !allowlist.has(t));

  // Concatenate target file contents — coverage is satisfied if the token
  // appears anywhere across the target set.
  const targetCorpus = readTargetCorpus(check.targets ?? [], repoRoot);
  if (targetCorpus.error) {
    return [{ checkId: check.id, severity: 'config-error', message: targetCorpus.error }];
  }

  const missing = [];
  for (const token of requiredTokens) {
    const found = check.matchMode === 'wholeWord'
      ? new RegExp(`\\b${escapeRegex(token)}\\b`).test(targetCorpus.text)
      : targetCorpus.text.includes(token);
    if (!found) missing.push(token);
  }

  if (missing.length === 0) return [];

  return [{
    checkId: check.id,
    severity: 'drift',
    message: `[${check.id}] ${check.title}: ${missing.length} token(s) missing from target docs`,
    missing,
    file: check.targets?.[0],
    hint: check.hint,
  }];
}

/**
 * Assert no target file contains any of the forbidden patterns. Path patterns
 * for legacy paths, version-specific narrative terms, etc.
 */
async function forbiddenPatternInTargets(check, repoRoot) {
  const reports = [];
  const targetFiles = expandGlobs(check.targets ?? [], repoRoot);

  for (const file of targetFiles) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const pattern of check.patterns ?? []) {
      const re = new RegExp(pattern.regex, 'g');
      const hits = [];
      lines.forEach((line, idx) => {
        if (re.test(line)) {
          hits.push({ line: idx + 1, snippet: line.trim().slice(0, 120) });
        }
        re.lastIndex = 0;
      });
      if (hits.length > 0) {
        const rel = relative(repoRoot, file).replace(/\\/g, '/');
        for (const hit of hits) {
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}] ${pattern.label}: ${rel}:${hit.line}`,
            file: `${rel}:${hit.line}`,
            forbidden: [pattern.regex],
            hint: check.hint,
          });
        }
      }
    }
  }

  return reports;
}

/**
 * Assert a single target file passes a set of must[] / mustNot[] rules.
 * Used for cross-referential consistency within one file (e.g. PROTOCOL.md
 * mentioning Stage D in the title and in the body and in the checklist).
 */
async function selfConsistency(check, repoRoot) {
  const targetPath = resolve(repoRoot, check.target);
  if (!existsSync(targetPath)) {
    return [{
      checkId: check.id,
      severity: 'config-error',
      message: `[${check.id}] target file not found: ${check.target}`,
    }];
  }
  const text = readFileSync(targetPath, 'utf8');
  const reports = [];

  for (const rule of check.rules ?? []) {
    for (const must of rule.must ?? []) {
      const re = new RegExp(must.regex, 'g');
      const matches = text.match(re) ?? [];
      const min = must.min ?? 1;
      if (matches.length < min) {
        reports.push({
          checkId: check.id,
          severity: 'drift',
          message: `[${check.id}/${rule.id}] required content missing — ${must.label} (found ${matches.length}, need ${min})`,
          file: check.target,
          hint: check.hint,
        });
      }
    }
    for (const mustNot of rule.mustNot ?? []) {
      const re = new RegExp(mustNot.regex);
      if (re.test(text)) {
        reports.push({
          checkId: check.id,
          severity: 'drift',
          message: `[${check.id}/${rule.id}] forbidden content present — ${mustNot.label}`,
          file: check.target,
          hint: check.hint,
        });
      }
    }
  }

  return reports;
}

/**
 * Assert every opening triple-backtick fence in target Markdown files carries
 * a language tag. Closing fences (the matching ``` on a line by itself after
 * the open) are correctly bare; this handler tracks open/close state by
 * counting fence lines per file. Drift = an OPENING fence with no language.
 *
 * Why a dedicated handler instead of forbidden-pattern-in-targets: the regex
 * `^```$` would match both opening AND closing fences and produce false
 * positives on every well-formed code block. The state machine here (toggle
 * `inFence` per `^```` line, only inspect on the open transition) is the
 * minimum needed to distinguish the two cases without spec-grade Markdown
 * parsing.
 *
 * Stage D wave 23, D-CI-001 (F-827321-010): added after the handbook sweep
 * fixed five untagged fences across architecture / state-machines /
 * intelligence-layer. The contract is: every ``` opener in
 * site/src/content/docs/handbook/*.md (and wherever else the config lists)
 * must declare a language so Starlight's Shiki can apply syntax highlighting,
 * the copy-button, and consistent border treatment. Use ```text for ASCII /
 * CLI output, ```bash for shell, ```yaml / ```json / ```ts for code.
 */
async function untaggedFence(check, repoRoot) {
  const reports = [];
  const targetFiles = expandGlobs(check.targets ?? [], repoRoot);
  if (targetFiles.length === 0) {
    return [{
      checkId: check.id,
      severity: 'config-error',
      message: `[${check.id}] no target files matched: ${(check.targets ?? []).join(', ')}`,
    }];
  }

  for (const file of targetFiles) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    let inFence = false;
    lines.forEach((line, idx) => {
      // Match a fence line: starts with three backticks, optional info string.
      const m = /^```(.*)$/.exec(line);
      if (!m) return;
      if (!inFence) {
        // Opening fence — must have a non-empty info string.
        const info = m[1].trim();
        if (info.length === 0) {
          const rel = relative(repoRoot, file).replace(/\\/g, '/');
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}] ${check.title}: ${rel}:${idx + 1} — opening fence missing language tag`,
            file: `${rel}:${idx + 1}`,
            forbidden: ['```\\n (untagged opening fence)'],
            hint: check.hint,
          });
        }
        inFence = true;
      } else {
        inFence = false;
      }
    });
  }

  return reports;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readTargetCorpus(targets, repoRoot) {
  const files = expandGlobs(targets, repoRoot);
  if (files.length === 0) {
    return { error: `[check-doc-drift] no target files matched: ${targets.join(', ')}` };
  }
  const parts = files.map((f) => readFileSync(f, 'utf8'));
  return { text: parts.join('\n\n'), files };
}

/**
 * Minimal glob expansion supporting the patterns we actually use:
 *   - exact paths               ('docs/policy-contract.md')
 *   - single-segment '*'        ('site/src/content/docs/handbook/*.md')
 *   - the doublestar '**' is NOT supported here on purpose. We don't need it
 *     for the wave-19 checks; if a future check does, expand this then.
 */
export function expandGlobs(patterns, repoRoot) {
  const out = [];
  for (const pattern of patterns) {
    const abs = resolve(repoRoot, pattern);
    // Plain file?
    if (!pattern.includes('*') && existsSync(abs)) {
      out.push(abs);
      continue;
    }
    if (pattern.includes('*')) {
      // Split into directory + last-segment glob.
      const lastSlash = pattern.lastIndexOf('/');
      const dirPart = lastSlash === -1 ? '.' : pattern.slice(0, lastSlash);
      const filePart = lastSlash === -1 ? pattern : pattern.slice(lastSlash + 1);
      const dirAbs = resolve(repoRoot, dirPart);
      if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) continue;
      const fileRe = globToRegex(filePart);
      for (const entry of readdirSync(dirAbs)) {
        if (fileRe.test(entry)) {
          const entryAbs = join(dirAbs, entry);
          if (statSync(entryAbs).isFile()) out.push(entryAbs);
        }
      }
    }
  }
  // De-dupe + stable sort for deterministic reporting.
  return [...new Set(out)].sort();
}

function globToRegex(glob) {
  // Escape regex metacharacters except '*' and '?', then translate.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry
// ─────────────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');

  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const checkIdx = args.indexOf('--check');
  const checkId = checkIdx !== -1 ? args[checkIdx + 1] : undefined;

  runDriftChecks({ repoRoot, checkId })
    .then((result) => {
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const verb = checkId ? `check '${checkId}'` : `${result.checksRun} check(s)`;
        if (result.clean) {
          console.log(`[check-doc-drift] OK — ${verb} passed.`);
        } else {
          console.error(`[check-doc-drift] DRIFT — ${result.reports.length} report(s) from ${verb}:\n`);
          for (const r of result.reports) {
            console.error(`  ${r.severity.toUpperCase()}: ${r.message}`);
            if (r.missing && r.missing.length) {
              console.error(`    missing: ${r.missing.join(', ')}`);
            }
            if (r.hint) {
              console.error(`    hint: ${r.hint}`);
            }
            console.error('');
          }
        }
      }
      // Exit codes mirror sync-version.mjs: 0 clean, 1 drift, 2 config error.
      const hasConfigError = result.reports.some((r) => r.severity === 'config-error');
      const hasDrift = result.reports.some((r) => r.severity === 'drift');
      process.exit(hasConfigError ? 2 : hasDrift ? 1 : 0);
    })
    .catch((err) => {
      console.error(`[check-doc-drift] fatal: ${err.message}`);
      process.exit(2);
    });
}
