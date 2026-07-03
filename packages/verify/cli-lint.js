/**
 * cli-lint.js (VERIFY-F3) — the `dogfood-verify lint <file>` subcommand.
 *
 * A SEPARATE parse/render path from the verify CLI (cli.js): it takes a policy YAML or
 * (with --scenario) a scenario YAML — not a submission JSON — and reports static lint
 * findings, so it does not share the verify arg parser or output. cli.js's `main`
 * dispatcher routes the `lint` verb here and leaves the verify `run` path untouched. The
 * exit contract mirrors that path, identically for both modes:
 *
 *   0 — clean, or warnings-only (footgun advisories never block).
 *   1 — one or more errors (schema-invalid, a static fault, or unparseable YAML).
 *   2 — operator error (file missing/unreadable, or a malformed invocation).
 *
 * YAML that fails to parse is exit 1 (a lint FINDING about the file the author must fix —
 * surfacing "line 4: bad indentation" is the lint's job), not exit 2. A file that does not
 * exist is exit 2 (the author pointed at the wrong path). See docs/policy-lint.md.
 *
 * Two modes share the whole render/exit machinery (F-BACKEND-003):
 *   - default (policy):  lintPolicy(doc, { origin })      → origin global|repo|unknown
 *   - --scenario:        lintScenario(doc, { file })      → origin 'scenario'
 * Both return the same { ok, origin, errors, warnings, coverageNote } shape, so
 * renderLintText / buildLintJson are reused unchanged.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { lintPolicy, COVERAGE_NOTE } from './validators/lint-policy.js';
import { lintScenario, SCENARIO_COVERAGE_NOTE } from './validators/lint-scenario.js';

/** Operator-error sentinel → exit 2 (distinct from a lint finding, which is exit 1). */
class LintOperatorError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'LintOperatorError';
    this.hint = hint;
  }
}

const LINT_USAGE = `dogfood-verify lint — author-time static check for a policy or scenario file

USAGE:
  dogfood-verify lint <policy-file> [--json]
  dogfood-verify lint --scenario <scenario-file> [--json]

WHAT IT CHECKS — policy mode (default, no submission needed):
  - structural validity against policy.schema.json
  - every predicate's known leading field, combinator depth, and node budget
  - an ADVISORY warning on the [] footgun (a negative op over a [] path fails open)

  It CANNOT statically catch a type_mismatch or a fanout_budget overrun — those depend
  on submission data. Run \`dogfood-verify --file <submission> --explain\` for that.

WHAT IT CHECKS — --scenario mode (no submission needed):
  - structural validity against scenario.schema.json
  - every success_criteria.required_steps entry references a declared steps[].id
  - step ids are unique
  - an ADVISORY warning when the file basename does not match scenario_id (the
    receiver fetches dogfood/scenarios/<scenario_id>.yaml, so a mismatch makes the
    committed definition unreachable and required-steps enforcement fails open)

  It CANNOT verify that a real submission's step_results satisfy required_steps, nor
  that the receiver can fetch the file at the attested commit — run a real ingest.

OPTIONS:
  --scenario    Lint the file as a scenario definition (default: policy).
  --json        Machine-readable result for CI.
  -h, --help    Show this help.

EXIT CODES:
  0  clean or warnings-only     1  errors found     2  operator error (bad flags / IO)`;

/**
 * Parse the lint argv (everything AFTER the `lint` verb). Accepts exactly one positional
 * file path plus optional `--scenario` / `--json` / `--help`. Throws LintOperatorError
 * (→ exit 2) on any malformed invocation.
 *
 * `--scenario` is a boolean MODE flag (default: policy mode). It selects which linter runs
 * over the one positional file; it never consumes the path itself.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, file: string|null, json: boolean, scenario: boolean }}
 */
export function parseLintArgs(argv) {
  let file = null;
  let json = false;
  let help = false;
  let scenario = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--scenario') { scenario = true; continue; }
    if (arg.startsWith('-')) {
      throw new LintOperatorError(`unknown argument: ${arg}`, 'run `dogfood-verify lint --help` for usage');
    }
    if (file !== null) {
      throw new LintOperatorError('more than one file given', 'lint one file at a time');
    }
    file = arg;
  }

  if (help) return { help: true, file: null, json: false, scenario: false };
  if (file === null) {
    const usage = scenario ? 'dogfood-verify lint --scenario <scenario-file>' : 'dogfood-verify lint <policy-file>';
    throw new LintOperatorError(`no ${scenario ? 'scenario' : 'policy'} file provided`, usage);
  }
  return { help: false, file, json, scenario };
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
  const kind = opts.scenario ? 'scenario' : 'policy';
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    err(`ERROR: could not read ${kind} file: ${path} — ${e.message}`);
    err('  hint: check the path exists and is readable');
    return 2;
  }

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    // A YAML parse failure is a lint finding about the file (exit 1), not an operator error.
    // Mirrors the policy path exactly, only differing in the origin/label/coverageNote so the
    // scenario report reads as a scenario report.
    const where = e && e.mark ? ` at line ${e.mark.line + 1}, column ${e.mark.column + 1}` : '';
    const result = opts.scenario
      ? {
          ok: false,
          origin: 'scenario',
          errors: [{
            label: 'scenario-schema:',
            code: 'yaml_parse',
            location: '/',
            message: `scenario YAML failed to parse${where} — ${e.message}`,
          }],
          warnings: [],
          coverageNote: SCENARIO_COVERAGE_NOTE,
        }
      : {
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

  const result = opts.scenario
    ? lintScenario(doc, { file: path })
    : lintPolicy(doc, { origin: originForPath(path) });
  out(opts.json ? JSON.stringify(buildLintJson(result, path)) : renderLintText(result, path));
  return result.ok ? 0 : 1;
}
