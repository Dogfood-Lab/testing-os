/**
 * cli-lint.js (VERIFY-F3 + F-49940082) — the `dogfood-verify lint <file>` subcommand.
 *
 * A SEPARATE parse/render path from the verify CLI (cli.js): it takes a policy YAML or
 * (with --scenario) a scenario YAML — not a submission JSON — and reports static lint
 * findings, so it does not share the verify arg parser or output. cli.js's `main`
 * dispatcher routes the `lint` verb here and leaves the verify `run` path untouched. The
 * exit contract mirrors that path, identically for both modes:
 *
 *   0 — clean, or warnings-only (footgun advisories never block).
 *   1 — one or more errors (schema-invalid, a static fault, or unparseable YAML).
 *   2 — operator error (file missing/unreadable, a malformed invocation, or a batch
 *       whose positionals resolved to zero lintable files).
 *
 * YAML that fails to parse is exit 1 (a lint FINDING about the file the author must fix —
 * surfacing "line 4: bad indentation" is the lint's job), not exit 2. A file that does not
 * exist is exit 2 (the author pointed at the wrong path). See docs/policy-lint.md.
 *
 * Two modes share the whole render/exit machinery (F-BACKEND-003):
 *   - default (policy):  lintPolicy(doc, { origin })      → origin global|repo|unknown
 *   - --scenario:        lintScenario(doc, { file })      → origin 'scenario'
 * Both return the same { ok, origin, errors, warnings, coverageNote } shape, so
 * renderLintText / buildLintJson are reused unchanged, single-file or batch.
 *
 * Directory-or-multi-path mode (F-49940082): one or more positionals are accepted. A
 * positional that is a directory is walked recursively for YAML files (extension match,
 * mirroring the discovery semantics of scripts/lint-policies.test.mjs's own policyFiles()
 * walker — see walkYamlFiles below). A positional that is a file is linted directly, no
 * extension filter (an explicit path is trusted as authored intent; the extension filter
 * only exists to skip non-policy noise during an unattended directory walk). The exact
 * single-positional-file invocation shape is untouched: it still runs through the very
 * same statements it always has, so its output is byte-identical to before this mode
 * existed — see the "legacy single-file path" branch in runLint.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
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

Usage:
  dogfood-verify lint <policy-file> [--json]
  dogfood-verify lint <path> [<path> ...] [--json]
  dogfood-verify lint --scenario <scenario-file> [--json]
  dogfood-verify lint --scenario <path> [<path> ...] [--json]

Directory-or-multi-path mode:
  Give more than one positional, or point at a directory, and every path is linted as
  a batch. A directory positional is walked recursively for *.yaml and *.yml files; a
  file positional is linted directly regardless of extension. Results print one block
  per file (same format as single-file mode) followed by a batch summary — files
  linted / clean / with-errors / with-warnings. The batch exit code is 1 if any file
  has an error, 0 if every file is clean or warnings-only — the single-file contract,
  extended across the set. A directory (or set of directories) with nothing to lint is
  an operator error (exit 2), never a silent pass.

What it checks — policy mode (default, no submission needed):
  - structural validity against policy.schema.json
  - every predicate's known leading field, combinator depth, and node budget
  - an ADVISORY warning on the [] footgun (a negative op over a [] path fails open)

  It CANNOT statically catch a type_mismatch or a fanout_budget overrun — those depend
  on submission data. Run \`dogfood-verify --file <submission> --explain\` for that.

What it checks — --scenario mode (no submission needed):
  - structural validity against scenario.schema.json
  - every success_criteria.required_steps entry references a declared steps[].id
  - step ids are unique
  - an ADVISORY warning when the file basename does not match scenario_id (the
    receiver fetches dogfood/scenarios/<scenario_id>.yaml, so a mismatch makes the
    committed definition unreachable and required-steps enforcement fails open)

  It CANNOT verify that a real submission's step_results satisfy required_steps, nor
  that the receiver can fetch the file at the attested commit — run a real ingest.

Options:
  --scenario    Lint the file(s) as scenario definitions (default: policy).
  --json        Machine-readable result for CI. A single-file invocation emits one
                result object, unchanged. Multi-path/directory mode emits
                { mode: "batch", ok, summary, files: [ <one result object per file> ] }.
  -h, --help    Show this help.

Exit codes:
  0  clean or warnings-only     1  errors found     2  operator error (bad flags / IO / nothing to lint)`;

/**
 * Parse the lint argv (everything AFTER the `lint` verb). Accepts one or more positional
 * paths (files and/or directories) plus optional `--scenario` / `--json` / `--help`.
 * Throws LintOperatorError (→ exit 2) on any malformed invocation.
 *
 * `--scenario` is a boolean MODE flag (default: policy mode). It selects which linter runs
 * over every positional; it never consumes a path itself.
 *
 * Whether a given invocation is "single-file" (legacy, byte-identical output) or "batch"
 * (F-49940082) is NOT decided here — this just collects positionals. runLint makes that
 * call once it knows whether the sole positional is a directory.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, paths: string[], json: boolean, scenario: boolean }}
 */
export function parseLintArgs(argv) {
  const paths = [];
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
    paths.push(arg);
  }

  if (help) return { help: true, paths: [], json: false, scenario: false };
  if (paths.length === 0) {
    const usage = scenario ? 'dogfood-verify lint --scenario <scenario-file|dir> [...]' : 'dogfood-verify lint <policy-file|dir> [...]';
    throw new LintOperatorError(`no ${scenario ? 'scenario' : 'policy'} file or directory provided`, usage);
  }
  return { help: false, paths, json, scenario };
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

/**
 * Recursively collect every YAML file (extension .yaml or .yml) under `dir`, depth-first.
 * This is the F-49940082 directory-walk primitive for batch mode, deliberately mirroring
 * policyFiles() in scripts/lint-policies.test.mjs — the CI gate that has quietly re-walked
 * `policies/` on its own since VERIFY-F3 rather than exercising this CLI (that gap is the
 * whole reason F-49940082 exists). Same two rules, on purpose: no skip-list (a hidden
 * directory or a stray `node_modules` is walked like any other — the intended input here is
 * an author-controlled tree such as `policies/`, not an arbitrary large directory), and
 * symlinks are followed (`statSync`, not `lstatSync`).
 *
 * One deliberate divergence: this returns results in this function's own recursion order,
 * which the caller (runLint) sorts across every discovered file from every positional —
 * policyFiles() returns readdirSync's raw per-directory order because its only consumer is
 * a test that aggregates failures into an unordered list; a human-facing CLI report reads
 * better, and diffs better across runs, sorted.
 *
 * @param {string} dir - an already-resolved, existing directory path
 * @returns {string[]} absolute file paths, unsorted (caller sorts across the full batch)
 */
export function walkYamlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkYamlFiles(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }
  return out;
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

/** Render the batch summary footer printed after every per-file block in
 *  directory-or-multi-path mode (F-49940082). */
export function renderBatchSummary(summary) {
  const { total, clean, withErrors, withWarnings } = summary;
  return [
    '-'.repeat(60),
    `BATCH SUMMARY: ${total} file(s) linted -- ${clean} clean, ${withWarnings} with warnings, ${withErrors} with errors`,
  ].join('\n');
}

/**
 * Build the machine-readable (--json) result for batch mode (F-49940082). Each entry in
 * `files` has the exact shape buildLintJson produces for a single file, so a consumer
 * written against the single-file --json shape only needs to index into `.files[i]`
 * instead of the top-level object. There is no pre-existing batch JSON consumer to match
 * instead: scripts/lint-policies.test.mjs (the only other batch-shaped lint caller in this
 * repo) bypasses the CLI's JSON output entirely and calls lintPolicy() directly — that
 * bypass is F-49940082's own subject, not a shape for this to imitate.
 */
export function buildBatchLintJson(files, summary) {
  return {
    mode: 'batch',
    ok: summary.withErrors === 0,
    summary,
    files,
  };
}

/**
 * Read, parse, and lint ONE file — the primitive shared by the legacy single-file path
 * and batch mode (F-49940082). Deliberately does not catch a read failure: the two
 * callers give it different severity. The legacy path treats "the one named file cannot
 * be read" as an operator mistake (exit 2, and it aborts — there is nothing else to try).
 * Batch mode treats "one file among several cannot be read" as a per-file finding folded
 * into the batch (see unreadableResult) so one bad path does not hide the results for
 * every other path given alongside it. A YAML parse failure, by contrast, IS handled
 * here and returned as an ok:false result — that has always been a lint finding, not an
 * operator error, in both modes.
 *
 * @param {string} path - an already-resolved file path
 * @param {{ scenario: boolean }} opts
 * @returns {{ ok: boolean, origin: string, errors: object[], warnings: object[], coverageNote: string }}
 */
function lintOneFile(path, opts) {
  const raw = readFileSync(path, 'utf-8');

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    // A YAML parse failure is a lint finding about the file (exit 1), not an operator error.
    // Mirrors the policy path exactly, only differing in the origin/label/coverageNote so the
    // scenario report reads as a scenario report.
    const where = e && e.mark ? ` at line ${e.mark.line + 1}, column ${e.mark.column + 1}` : '';
    return opts.scenario
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
  }

  return opts.scenario
    ? lintScenario(doc, { file: path })
    : lintPolicy(doc, { origin: originForPath(path) });
}

/**
 * Build a lint-result-shaped entry for a batch-mode path that could not be read at all
 * (missing, a permission fault, or any other readFileSync failure). `detail` is the real
 * underlying Error#message from that failed read — not a guessed ENOENT string — so the
 * report matches what the OS actually said, the same way the legacy single-file operator
 * error always has.
 *
 * @param {string} path
 * @param {{ scenario: boolean }} opts
 * @param {string} detail - e.message from the failed readFileSync
 */
function unreadableResult(path, opts, detail) {
  const kind = opts.scenario ? 'scenario' : 'policy';
  const message = `could not read ${kind} file: ${path} — ${detail}`;
  return opts.scenario
    ? {
        ok: false,
        origin: 'scenario',
        errors: [{ label: 'scenario-schema:', code: 'path_unreadable', location: '/', message }],
        warnings: [],
        coverageNote: SCENARIO_COVERAGE_NOTE,
      }
    : {
        ok: false,
        origin: originForPath(path),
        errors: [{ label: 'policy-schema:', code: 'path_unreadable', location: '/', message }],
        warnings: [],
        coverageNote: COVERAGE_NOTE,
      };
}

/**
 * stat a path without throwing. `null` means "does not exist, or could not be stat'd for
 * any other reason" — the caller never needs to know which, because either way the path
 * is not a confirmed directory, so it is handled as a candidate file, and any real fault
 * (missing, permission, ...) surfaces through the normal readFileSync path with its own
 * accurate message instead of a guess made here.
 */
function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Run the lint subcommand. Returns the exit code (does not call process.exit) so it is
 * unit-testable with an injected stdout/stderr sink.
 *
 * Routing (F-49940082): a single positional that does not resolve to an existing
 * directory takes the legacy single-file path below, unchanged in every statement and
 * every error message from before directory-or-multi-path mode existed. Anything else —
 * two or more positionals, or the sole positional resolving to a directory — is batch
 * mode: every positional is either walked (if a directory) or linted directly (if a
 * file), results are aggregated, and a batch summary is printed after the per-file
 * blocks. See the module docstring for the discovery-semantics parity statement against
 * scripts/lint-policies.test.mjs's policyFiles().
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

  const resolvedPaths = opts.paths.map((p) => resolve(p));
  const soleStat = resolvedPaths.length === 1 ? safeStat(resolvedPaths[0]) : null;
  const isBatch = resolvedPaths.length > 1 || (soleStat !== null && soleStat.isDirectory());

  if (!isBatch) {
    // ── legacy single-file path — byte-identical to pre-F-49940082 behavior. Same
    // statements, same order, same error text; only factored through lintOneFile so
    // batch mode below can share it instead of duplicating the read/parse/lint sequence. ──
    const path = resolvedPaths[0];
    const kind = opts.scenario ? 'scenario' : 'policy';
    let result;
    try {
      result = lintOneFile(path, opts);
    } catch (e) {
      err(`ERROR: could not read ${kind} file: ${path} — ${e.message}`);
      err('  hint: check the path exists and is readable');
      return 2;
    }
    out(opts.json ? JSON.stringify(buildLintJson(result, path)) : renderLintText(result, path));
    return result.ok ? 0 : 1;
  }

  // ── batch mode (F-49940082): directory-or-multi-path ──
  const kind = opts.scenario ? 'scenario' : 'policy';
  const discovered = new Set();
  for (const p of resolvedPaths) {
    const st = safeStat(p);
    if (st !== null && st.isDirectory()) {
      for (const f of walkYamlFiles(p)) discovered.add(f);
    } else {
      // Not a confirmed directory: a file, a missing path, or anything else safeStat
      // could not classify. Hand it to lintOneFile as a candidate — a genuinely missing
      // or unreadable path surfaces its real OS error there, not a guess made here.
      discovered.add(p);
    }
  }
  const files = [...discovered].sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    // Every positional was a confirmed directory and none contributed a file to lint.
    // A lint that finds nothing and exits 0 is a vacuous pass — fail loud instead of
    // silently doing nothing (swarms/CLAUDE.md: "a gate that can't go red is theater").
    err(`ERROR: no ${kind} files found under: ${resolvedPaths.join(', ')}`);
    err('  hint: an empty directory, or one with no yaml files, has nothing to lint');
    return 2;
  }

  const summary = { total: files.length, clean: 0, withErrors: 0, withWarnings: 0 };
  const textBlocks = [];
  const jsonFiles = [];

  for (const path of files) {
    let result;
    try {
      result = lintOneFile(path, opts);
    } catch (e) {
      result = unreadableResult(path, opts, e.message);
    }

    if (result.errors.length) summary.withErrors++;
    else if (result.warnings.length) summary.withWarnings++;
    else summary.clean++;

    if (opts.json) jsonFiles.push(buildLintJson(result, path));
    else textBlocks.push(renderLintText(result, path));
  }

  out(opts.json
    ? JSON.stringify(buildBatchLintJson(jsonFiles, summary))
    : `${textBlocks.join('\n\n')}\n\n${renderBatchSummary(summary)}`);

  return summary.withErrors > 0 ? 1 : 0;
}
