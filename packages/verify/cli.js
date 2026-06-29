#!/usr/bin/env node
/**
 * verify CLI (FT-c) — local dry-run / explain front-end for the verifier.
 *
 * package.json declared a `verify` bin/script pointing at this file long
 * before it existed, so `node cli.js` / `npx @dogfood-lab/verify` failed with
 * MODULE_NOT_FOUND. This is that file: a thin operator front-end over the
 * library's `verify()` + `parseRejectionReason()` — it does NOT reimplement
 * any validation. A consumer who wants to know WHY a submission would pass or
 * fail before pushing it through CI runs:
 *
 *   node cli.js --file submission.json --explain
 *
 * and gets a human-readable verdict breakdown, with each rejection reason
 * classified (submission-bad vs operational vs ingest vs unknown) so they know
 * WHOSE problem it is — their payload, the verifier/tooling, or ingest.
 *
 * Why this lives in verify and not ingest: ingest's CLI (packages/ingest/run.js)
 * is the WRITE path — it persists records and rebuilds indexes, requires an
 * explicit provenance adapter, and forbids stub provenance in CI. This CLI is a
 * pure READ/preview path: it never touches the filesystem beyond reading the
 * submission + policy files, defaults to stub provenance for a no-network local
 * check, and exits without side effects. The two share an exit-code contract
 * (0 accepted / 1 rejected / 2 operator error) so a wrapper can reason about
 * both uniformly.
 *
 * Exit codes (consistent with packages/ingest/run.js):
 *   0 — submission accepted
 *   1 — submission rejected (verdict reached; the payload is the problem)
 *   2 — operator error (bad flags, unreadable file, invalid JSON, missing
 *       policy) — the consumer must fix their invocation/environment, not the
 *       submission.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify, parseRejectionReason } from './index.js';
import { stubProvenance, provenanceForProvider } from './validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Operator-error sentinel. Thrown for any exit-2 condition (bad flags,
 * unreadable file, invalid JSON, missing/unreadable policy) so the single
 * top-level catch can emit one structured message and exit 2 — distinct from a
 * legitimate rejection (exit 1), which is NOT an error.
 */
class OperatorError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'OperatorError';
    this.hint = hint;
  }
}

const USAGE = `verify — local dry-run / explain for dogfood submissions

USAGE:
  verify --file <path> [--explain | --json] [--provenance=stub|github]
  verify --payload '<json>' [--explain | --json] [--provenance=stub|github]

INPUT (exactly one required):
  --file <path>        Read the submission JSON from a file.
  --payload <json>     Pass the submission JSON inline.

OUTPUT MODE (default: --explain):
  --explain            Human-readable verdict breakdown with each rejection
                       reason classified (who must fix it). [default]
  --json               Machine-readable result for tooling. Mutually exclusive
                       with --explain.

PROVENANCE (default: stub):
  --provenance=stub    No-network local check; provenance is always confirmed.
                       This is a LOCAL DRY-RUN — a real ingest re-checks
                       provenance against the source run. [default]
  --provenance=github  Confirm the source run via the GitHub API. Requires
                       GITHUB_TOKEN or GH_TOKEN in the environment.

  -h, --help           Show this help.

EXIT CODES:
  0  accepted     1  rejected     2  operator error (bad flags / IO / JSON)`;

/**
 * Parse argv into a normalized option set. Accepts BOTH `--flag value` and
 * `--flag=value` forms — mirrors the parser in packages/ingest/run.js so the
 * two CLIs feel identical. Throws OperatorError (→ exit 2) on any malformed or
 * conflicting invocation rather than silently picking a default, so a typo'd
 * flag never produces a misleading verdict.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ help: boolean, file: string|null, payload: string|null,
 *   mode: 'explain'|'json', provenanceMode: 'stub'|'github' }}
 */
export function parseArgs(argv) {
  let file = null;
  let payload = null;
  let mode = null;            // 'explain' | 'json' — defaulted after parsing
  let provenanceMode = null;  // 'stub' | 'github'  — defaulted after parsing
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        inlineValue = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    const hasValue = inlineValue !== null || argv[i + 1] !== undefined;
    const takeValue = () => (inlineValue !== null ? inlineValue : argv[++i]);

    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--file':
        if (!hasValue) throw new OperatorError('--file requires a path', 'verify --file submission.json --explain');
        if (file !== null) throw new OperatorError('--file given more than once');
        file = takeValue();
        break;
      case '--payload':
        if (!hasValue) throw new OperatorError('--payload requires a JSON string', "verify --payload '{...}' --explain");
        if (payload !== null) throw new OperatorError('--payload given more than once');
        payload = takeValue();
        break;
      case '--explain':
        if (mode === 'json') throw new OperatorError('--explain and --json are mutually exclusive');
        mode = 'explain';
        break;
      case '--json':
        if (mode === 'explain') throw new OperatorError('--explain and --json are mutually exclusive');
        mode = 'json';
        break;
      case '--provenance': {
        if (!hasValue) throw new OperatorError('--provenance requires a value', '--provenance=stub or --provenance=github');
        const v = takeValue();
        if (v !== 'stub' && v !== 'github') {
          throw new OperatorError(`unknown --provenance value: ${v}`, 'use --provenance=stub or --provenance=github');
        }
        provenanceMode = v;
        break;
      }
      default:
        throw new OperatorError(`unknown argument: ${argv[i]}`, 'run `verify --help` for usage');
    }
  }

  if (help) {
    return { help: true, file: null, payload: null, mode: 'explain', provenanceMode: 'stub' };
  }

  if (file === null && payload === null) {
    throw new OperatorError('no submission provided', 'pass --file <path> or --payload <json>');
  }
  if (file !== null && payload !== null) {
    throw new OperatorError('--file and --payload are mutually exclusive', 'provide exactly one input');
  }

  return {
    help: false,
    file,
    payload,
    // --explain is the documented default — a consumer running `verify --file x`
    // wants the human breakdown, not raw JSON.
    mode: mode ?? 'explain',
    // stub is the dry-run default: a local check should not require a network
    // round-trip or a GitHub token just to learn whether the PAYLOAD is shaped
    // right. A real ingest still re-confirms provenance for keeps.
    provenanceMode: provenanceMode ?? 'stub'
  };
}

/**
 * Read and JSON-parse the submission from --file or --payload. Both IO and
 * parse failures are OperatorErrors (exit 2): a submission the consumer cannot
 * even hand us is an invocation problem, not a rejected-but-shaped payload.
 *
 * @returns {object} The parsed submission (may be any JSON value — verify()
 *   itself handles null/non-object/array inputs and produces a rejection).
 */
function loadSubmission({ file, payload }) {
  let raw;
  if (file !== null) {
    try {
      raw = readFileSync(resolve(file), 'utf-8');
    } catch (e) {
      throw new OperatorError(`could not read --file: ${resolve(file)} — ${e.message}`,
        'check the path exists and is readable');
    }
  } else {
    raw = payload;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new OperatorError(`invalid JSON submission — ${e.message}`,
      'the submission must be valid JSON');
  }
}

/**
 * Load the policy set the verifier needs to evaluate this submission.
 *
 * verify is a LEAF package (deps: @dogfood-lab/schemas + js-yaml only); the
 * full policy loader lives in @dogfood-lab/ingest, which sits downstream in the
 * workspace cycle (findings → ingest → dogfood-swarm → findings). Importing it
 * here would add a verify → ingest edge and widen that cycle. Instead this is a
 * deliberately minimal read — the same `yaml.load(readFileSync(...))` the verify
 * test suite uses — kept self-contained so verify stays a leaf. The verifier
 * still owns ALL the policy LOGIC; this only locates and parses the YAML.
 *
 * Global policy is required (a missing one is an operator error → exit 2). Repo
 * policy is optional: absent → null (defaults apply), exactly as the library
 * contract documents.
 *
 * @param {object} submission - used only for submission.repo (repo-policy lookup)
 * @param {string} repoRoot
 * @returns {{ globalPolicy: object, repoPolicy: object|null, policyVersion: string }}
 */
function loadPolicies(submission, repoRoot) {
  const globalPath = join(repoRoot, 'policies', 'global-policy.yaml');
  let globalPolicy;
  try {
    globalPolicy = yaml.load(readFileSync(globalPath, 'utf-8'));
  } catch (e) {
    throw new OperatorError(`global policy unreadable: ${globalPath} — ${e.message}`,
      'run from the testing-os repo root, or set VERIFY_REPO_ROOT to it');
  }

  let repoPolicy = null;
  const repoSlug = submission && typeof submission === 'object' ? submission.repo : null;
  if (typeof repoSlug === 'string' && repoSlug.includes('/')) {
    const [org, repo] = repoSlug.split('/');
    // Reject path-traversal segments before touching the filesystem — a hostile
    // submission.repo like '../../etc' must never escape policies/repos/.
    const safe = (s) => typeof s === 'string' && s.length > 0 && !s.includes('..') && !s.includes('\\') && s !== '.';
    if (safe(org) && safe(repo)) {
      const repoPath = join(repoRoot, 'policies', 'repos', org, `${repo}.yaml`);
      try {
        repoPolicy = yaml.load(readFileSync(repoPath, 'utf-8'));
      } catch {
        // Absent or unreadable repo policy → null (defaults apply). This CLI is
        // a preview; it does not reproduce ingest's torn-policy sentinel. A real
        // ingest is the authority on a corrupt repo-policy file.
        repoPolicy = null;
      }
    }
  }

  const policyVersion =
    (repoPolicy && repoPolicy.policy_version) ||
    (globalPolicy && globalPolicy.policy_version) ||
    '1.0.0';

  return { globalPolicy, repoPolicy, policyVersion };
}

/**
 * Resolve the provenance adapter for the requested mode. stub is side-effect-
 * free and offline (the dry-run default); the real mode confirms the source run
 * and is routed by `submission.source.provider` (github | gitlab) through the
 * adapter registry, sourcing the provider's token from the environment (missing
 * token → operator error, exit 2).
 */
function resolveProvenance(provenanceMode, submission) {
  if (provenanceMode === 'github') {
    const provider = (submission && submission.source && submission.source.provider) || 'github';
    const factory = provenanceForProvider(provider);
    if (!factory) {
      throw new OperatorError(`unknown provenance provider '${provider}' (supported: github, gitlab)`,
        'check submission.source.provider, or use --provenance=stub for a local dry-run');
    }
    const token = provider === 'gitlab'
      ? (process.env.GITLAB_TOKEN || process.env.CI_JOB_TOKEN)
      : (process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    if (!token) {
      const need = provider === 'gitlab' ? 'GITLAB_TOKEN or CI_JOB_TOKEN' : 'GITHUB_TOKEN or GH_TOKEN';
      throw new OperatorError(`real provenance for provider '${provider}' requires ${need}`,
        'export a token with read access to the CI run, or use --provenance=stub for a local dry-run');
    }
    return factory(token);
  }
  return stubProvenance;
}

/**
 * Human-readable label + one-line fix hint per rejection class. The class is
 * the routing decision parseRejectionReason() makes; this maps it to operator
 * language so the consumer knows WHOSE problem each reason is.
 */
const CLASS_LABEL = {
  'submission-bad': 'SUBMISSION  — fix your payload and resubmit',
  'operational': 'OPERATIONAL — verifier/tooling fault; page ops, do not bounce to submitter',
  'ingest': 'INGEST      — ingest-side load fault (scenario fetch)',
  'unknown': 'UNKNOWN     — unrecognized reason; log and inspect raw'
};

/**
 * Render the explain (human) view of a verification result. Groups rejection
 * reasons by class so the consumer can see at a glance how many of their
 * failures are their own payload vs the verifier vs ingest.
 *
 * @param {object} record - the persisted record returned by verify()
 * @returns {string}
 */
export function renderExplain(record) {
  const v = record.verification || {};
  const reasons = v.rejection_reasons || [];
  const accepted = v.status === 'accepted';
  const lines = [];

  // Uppercase the rendered state word to match the sibling verdict banners
  // (findings-render.js). This is display-only; the underlying enum
  // (v.status, --json output) stays lowercase.
  lines.push(`VERDICT: ${(v.status || (accepted ? 'accepted' : 'rejected')).toUpperCase()}`);
  lines.push('');
  lines.push(`  schema_valid:         ${v.schema_valid}`);
  lines.push(`  policy_valid:         ${v.policy_valid}`);
  lines.push(`  provenance_confirmed: ${v.provenance_confirmed}`);
  if (record.overall_verdict) {
    const ov = record.overall_verdict;
    const downgraded = ov.downgraded ? ` (downgraded from ${ov.proposed ?? 'null'})` : '';
    lines.push(`  verdict:              ${ov.verified ?? 'null'}${downgraded}`);
  }

  if (accepted) {
    lines.push('');
    lines.push('No rejection reasons. This submission would be accepted.');
    return lines.join('\n');
  }

  // Group reasons by class so the breakdown reads as "here is who must act,"
  // not a flat undifferentiated list. parseRejectionReason owns the taxonomy.
  const byClass = new Map();
  for (const reason of reasons) {
    const parsed = parseRejectionReason(reason);
    if (!byClass.has(parsed.class)) byClass.set(parsed.class, []);
    byClass.get(parsed.class).push(parsed);
  }

  lines.push('');
  lines.push(`REJECTION REASONS (${reasons.length}):`);
  // Stable, operator-meaningful order: payload problems first (most actionable
  // by the consumer), then operational, ingest, unknown.
  const ORDER = ['submission-bad', 'operational', 'ingest', 'unknown'];
  for (const cls of ORDER) {
    const items = byClass.get(cls);
    if (!items || items.length === 0) continue;
    lines.push('');
    lines.push(`  [${CLASS_LABEL[cls]}]`);
    for (const parsed of items) {
      const prefix = parsed.prefix ? `${parsed.prefix} ` : '';
      lines.push(`    - ${prefix}${parsed.detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the machine-readable (--json) result. Each reason is pre-classified so
 * tooling never has to re-implement parseRejectionReason at the call site.
 *
 * @param {object} record
 * @returns {object}
 */
export function buildJsonResult(record) {
  const v = record.verification || {};
  const reasons = v.rejection_reasons || [];
  return {
    status: v.status ?? null,
    run_id: record.run_id ?? null,
    verdict: record.overall_verdict?.verified ?? null,
    schema_valid: v.schema_valid ?? null,
    policy_valid: v.policy_valid ?? null,
    provenance_confirmed: v.provenance_confirmed ?? null,
    rejection_reasons: reasons.map(reason => {
      const parsed = parseRejectionReason(reason);
      return { class: parsed.class, prefix: parsed.prefix, detail: parsed.detail, raw: reason };
    })
  };
}

/**
 * Run the CLI. Returns the process exit code instead of calling process.exit,
 * so the function is unit-testable (a test drives it with argv + an injected
 * stdout sink and asserts on the code + output).
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, repoRoot?: string }} [io]
 * @returns {Promise<number>} exit code (0 accepted / 1 rejected / 2 operator error)
 */
export async function run(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.stderr ?? ((s) => process.stderr.write(s + '\n'));
  const repoRoot = io.repoRoot
    ?? (process.env.VERIFY_REPO_ROOT ? resolve(process.env.VERIFY_REPO_ROOT) : resolve(__dirname, '../..'));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`ERROR: ${e.message}`);
    if (e.hint) err(`  hint: ${e.hint}`);
    return 2;
  }

  if (opts.help) {
    out(USAGE);
    return 0;
  }

  let record;
  try {
    const submission = loadSubmission(opts);
    const { globalPolicy, repoPolicy, policyVersion } = loadPolicies(submission, repoRoot);
    const provenance = resolveProvenance(opts.provenanceMode, submission);
    record = await verify(submission, { globalPolicy, repoPolicy, provenance, policyVersion });
  } catch (e) {
    // OperatorError → exit 2 with a hint. Anything else thrown here is an
    // unexpected fault in the preview path; surface it as exit 2 too (the
    // consumer cannot fix a payload we never managed to verify).
    err(`ERROR: ${e.message}`);
    if (e.hint) err(`  hint: ${e.hint}`);
    return 2;
  }

  if (opts.mode === 'json') {
    out(JSON.stringify(buildJsonResult(record)));
  } else {
    out(renderExplain(record));
  }

  return record.verification?.status === 'accepted' ? 0 : 1;
}

// --- CLI entrypoint ---
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, 'cli.js');
if (isMain) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
