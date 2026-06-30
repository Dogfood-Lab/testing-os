/**
 * cli-lint.js (VERIFY-F3) — the `dogfood-verify lint <policy-file>` subcommand.
 *
 * A SEPARATE parse/render path from the verify CLI (cli.js): it takes a policy YAML
 * (not a submission JSON) and reports static lint findings, so it does not share the
 * verify arg parser or output. cli.js's `main` dispatcher routes the `lint` verb here
 * and leaves the verify `run` path untouched. The exit contract mirrors that path:
 *
 *   0 — clean, or warnings-only (footgun advisories never block).
 *   1 — one or more errors (schema-invalid, a static predicate fault, or unparseable YAML).
 *   2 — operator error (file missing/unreadable, or a malformed invocation).
 *
 * YAML that fails to parse is exit 1 (a lint FINDING about the policy the author must fix —
 * surfacing "line 4: bad indentation" is the lint's job), not exit 2. A file that does not
 * exist is exit 2 (the author pointed at the wrong path). See docs/policy-lint.md.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { lintPolicy, COVERAGE_NOTE } from './validators/lint-policy.js';

/** Operator-error sentinel → exit 2 (distinct from a lint finding, which is exit 1). */
class LintOperatorError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'LintOperatorError';
    this.hint = hint;
  }
}

const LINT_USAGE = `dogfood-verify lint — author-time static check for a policy file

USAGE:
  dogfood-verify lint <policy-file> [--json]

WHAT IT CHECKS (no submission needed):
  - structural validity against policy.schema.json
  - every predicate's known leading field, combinator depth, and node budget
  - an ADVISORY warning on the [] footgun (a negative op over a [] path fails open)

It CANNOT statically catch a type_mismatch or a fanout_budget overrun — those depend
on submission data. Run \`dogfood-verify --file <submission> --explain\` for that.

OPTIONS:
  --json        Machine-readable result for CI.
  -h, --help    Show this help.

EXIT CODES:
  0  clean or warnings-only     1  errors found     2  operator error (bad flags / IO)`;

/**
 * Parse the lint argv (everything AFTER the `lint` verb). Accepts exactly one positional
 * policy-file path plus optional `--json` / `--help`. Throws LintOperatorError (→ exit 2)
 * on any malformed invocation.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, file: string|null, json: boolean }}
 */
export function parseLintArgs(argv) {
  let file = null;
  let json = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg.startsWith('-')) {
      throw new LintOperatorError(`unknown argument: ${arg}`, 'run `dogfood-verify lint --help` for usage');
    }
    if (file !== null) {
      throw new LintOperatorError('more than one policy file given', 'lint one file at a time');
    }
    file = arg;
  }

  if (help) return { help: true, file: null, json: false };
  if (file === null) {
    throw new LintOperatorError('no policy file provided', 'dogfood-verify lint <policy-file>');
  }
  return { help: false, file, json };
}

/**
 * Classify a policy file by its path so the report can name the origin (which decides the
 * runtime fault class: global → operational, repo → submission-bad). Mirrors the
 * `policies/global-policy.yaml` vs `policies/repos/<org>/<repo>.yaml` layout.
 */
export function originForPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (/\/policies\/repos\//.test(norm)) return 'repo';
  if (/(^|\/)global-policy\.yaml$/.test(norm)) return 'global';
  return 'unknown';
}

/** Render the human (default) view of a lint result — verdict-first, ERROR before WARNING. */
export function renderLintText(result, file) {
  const lines = [];
  const verdict = !result.ok ? 'ERRORS' : (result.warnings.length ? 'CLEAN (advisory warnings)' : 'CLEAN');
  lines.push(`VERDICT: ${verdict}`);
  lines.push('');
  lines.push(`  file:   ${file}`);
  lines.push(`  origin: ${result.origin}`);

  if (result.errors.length) {
    lines.push('');
    lines.push(`ERRORS (${result.errors.length}):`);
    for (const e of result.errors) {
      const field = e.field ? ` — field "${e.field}"` : '';
      lines.push(`  - [${e.label} ${e.code}] ${e.location}${field}`);
      lines.push(`      ${e.message}`);
    }
  }

  if (result.warnings.length) {
    lines.push('');
    lines.push(`WARNINGS (${result.warnings.length}) — advisory; the author confirms intent, nothing is auto-applied:`);
    for (const w of result.warnings) {
      lines.push(`  - [${w.label} ${w.code}] ${w.location} — field "${w.field}"`);
      lines.push(`      ${w.message}`);
      lines.push(`      ${w.suggestion}`);
    }
  }

  if (result.ok && !result.warnings.length) {
    lines.push('');
    lines.push('No findings. The policy passes static lint.');
  }

  lines.push('');
  lines.push(`note: ${result.coverageNote}`);
  return lines.join('\n');
}

/** Build the machine-readable (--json) result. */
export function buildLintJson(result, file) {
  return {
    file,
    origin: result.origin,
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    coverageNote: result.coverageNote,
  };
}

/**
 * Run the lint subcommand. Returns the exit code (does not call process.exit) so it is
 * unit-testable with an injected stdout/stderr sink.
 *
 * @param {string[]} argv - args AFTER the `lint` verb
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function runLint(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.stderr ?? ((s) => process.stderr.write(s + '\n'));

  let opts;
  try {
    opts = parseLintArgs(argv);
  } catch (e) {
    err(`ERROR: ${e.message}`);
    if (e.hint) err(`  hint: ${e.hint}`);
    return 2;
  }

  if (opts.help) {
    out(LINT_USAGE);
    return 0;
  }

  const path = resolve(opts.file);
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    err(`ERROR: could not read policy file: ${path} — ${e.message}`);
    err('  hint: check the path exists and is readable');
    return 2;
  }

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    // A YAML parse failure is a lint finding about the policy (exit 1), not an operator error.
    const where = e && e.mark ? ` at line ${e.mark.line + 1}, column ${e.mark.column + 1}` : '';
    const result = {
      ok: false,
      origin: originForPath(path),
      errors: [{
        label: 'policy-schema:',
        code: 'yaml_parse',
        location: '/',
        message: `policy YAML failed to parse${where} — ${e.message}`,
      }],
      warnings: [],
      coverageNote: COVERAGE_NOTE,
    };
    out(opts.json ? JSON.stringify(buildLintJson(result, path)) : renderLintText(result, path));
    return 1;
  }

  const result = lintPolicy(doc, { origin: originForPath(path) });
  out(opts.json ? JSON.stringify(buildLintJson(result, path)) : renderLintText(result, path));
  return result.ok ? 0 : 1;
}
