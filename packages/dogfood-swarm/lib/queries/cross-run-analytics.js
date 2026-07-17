/**
 * cross-run-analytics.js — F4-CP-01 cross-run analytics query layer.
 *
 * Why this module exists
 *
 *   Every `swarm` verb is single-runId scoped (status/runs/findings/verify-*
 *   all take a <run-id>). But the control plane persists data that is only
 *   meaningful ACROSS runs:
 *
 *     - findings.fingerprint is content-addressed (lib/fingerprint.js), and
 *       the schema's UNIQUE constraint is (run_id, fingerprint). So the SAME
 *       fingerprint observed in two distinct runs produces TWO findings rows,
 *       one per run. That is the cross-run recurrence signal: a defect (or a
 *       fix that regressed) that the swarm keeps re-discovering across runs.
 *
 *     - runs/waves/findings together describe a per-run history that, rolled
 *       up, tells you how a repo (or the whole portfolio) trends over time.
 *
 *   No single-run verb can surface either signal. This module is the pure
 *   DB-read query layer the `swarm trends` verb routes to.
 *
 * Discipline
 *
 *   Every function here is a PURE READ: it takes an already-open
 *   better-sqlite3 handle (`db`) and issues SELECT-only statements. No writes,
 *   no connection management, no path resolution — the caller (cli.js's
 *   cmdTrends) owns openDb(getDbPath()). This keeps the module trivially unit-
 *   testable against an in-memory DB (openMemoryDb) and free of the real
 *   control-plane.db tree.
 *
 * Standards compliance (workflow-standards.md — this is a query module, not a
 * multi-step workflow; the six standards apply only weakly):
 *   1. PIN_PER_STEP        — n/a (no model/tool steps)            skip: pure read fns
 *   2. ANDON_AUTHORITY     — n/a (no pipeline to halt)            skip: pure read fns
 *   3. NAMED_COMPENSATORS  — n/a (read-only; nothing irreversible) skip: no mutations
 *   4. DECOMPOSE_BY_SECRETS — 3 (PRESENT+): the cross-run read logic is grouped
 *      here, isolated from cli.js presentation and from the single-run query
 *      surfaces; the SQL shape is the one thing that changes together.
 *   5. UNCERTAINTY_GATED_HUMANS — n/a (no human checkpoints)      skip: read fns
 *   6. EXTERNAL_VERIFIER   — 2 (PRESENT): the companion test file
 *      w3-cross-run-analytics.test.js verifies these reads against a seeded
 *      DB independently of the implementation.
 */

/**
 * Fingerprints observed in MORE THAN ONE run — the cross-run recurrence
 * signal. Because findings is UNIQUE(run_id, fingerprint), a row count > 1 for
 * a fingerprint means it spans that many distinct runs. We join to `runs` to
 * derive first_seen / last_seen from the runs' created_at (the earliest /
 * latest run the fingerprint was observed in).
 *
 * description is taken from a representative row via MAX() (deterministic
 * pick, avoids a correlated subquery) — NOTE it is NOT part of the
 * fingerprint, so wave-to-wave rewordings can differ across runs; the pick is
 * merely stable, not "identical by construction". severity is likewise not
 * fingerprint-folded, so it is ranked EXPLICITLY (F-832f8547): the most
 * severe observation across runs wins. A bare MAX(severity) was an
 * ALPHABETICAL pick — a fingerprint recorded CRITICAL in one run and MEDIUM
 * in another reported 'MEDIUM' ('M' > 'C').
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{
 *   fingerprint: string,
 *   description: string,
 *   run_count: number,
 *   severity: string,
 *   first_seen: string,
 *   last_seen: string,
 * }>} — ordered by run_count DESC, then last_seen DESC (most-recurring,
 *       most-recent first).
 */
export function queryRecurringFindings(db) {
  return db.prepare(`
    SELECT
      f.fingerprint                 AS fingerprint,
      MAX(f.description)            AS description,
      COUNT(DISTINCT f.run_id)      AS run_count,
      CASE MAX(CASE f.severity
        WHEN 'CRITICAL' THEN 4
        WHEN 'HIGH'     THEN 3
        WHEN 'MEDIUM'   THEN 2
        WHEN 'LOW'      THEN 1
        ELSE 0 END)
        WHEN 4 THEN 'CRITICAL'
        WHEN 3 THEN 'HIGH'
        WHEN 2 THEN 'MEDIUM'
        WHEN 1 THEN 'LOW'
        ELSE MAX(f.severity) END    AS severity,
      MIN(r.created_at)             AS first_seen,
      MAX(r.created_at)             AS last_seen
    FROM findings f
    JOIN runs r ON f.run_id = r.id
    GROUP BY f.fingerprint
    HAVING COUNT(DISTINCT f.run_id) > 1
    ORDER BY run_count DESC, last_seen DESC
  `).all();
}

/**
 * Per-run rollup: one row per run with its wave + finding counts, ordered
 * newest-first. Optional `repoPattern` filters on repo via SQL LIKE
 * (`%pattern%`), so `queryPerRepoRunHistory(db, 'repo-a')` matches
 * 'org/repo-a'. A run with zero waves / zero findings still appears (LEFT
 * JOIN-style correlated counts), so the history is complete.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [repoPattern] — substring matched against runs.repo via LIKE
 * @returns {Array<{
 *   run_id: string,
 *   repo: string,
 *   wave_count: number,
 *   finding_count: number,
 *   status: string,
 *   created_at: string,
 * }>}
 */
export function queryPerRepoRunHistory(db, repoPattern) {
  const where = repoPattern ? `WHERE r.repo LIKE ?` : ``;
  const sql = `
    SELECT
      r.id                                                              AS run_id,
      r.repo                                                            AS repo,
      (SELECT COUNT(*) FROM waves w WHERE w.run_id = r.id)              AS wave_count,
      (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id)          AS finding_count,
      r.status                                                          AS status,
      r.created_at                                                      AS created_at
    FROM runs r
    ${where}
    ORDER BY r.created_at DESC, r.id DESC
  `;
  const stmt = db.prepare(sql);
  return repoPattern ? stmt.all(`%${repoPattern}%`) : stmt.all();
}

/**
 * Recurrence-rate stats over the run population. `windowDays`, when given,
 * restricts the run population to those whose created_at falls within
 * `windowDays` of the MOST RECENT run's created_at (a trailing window). The
 * recurrence metrics are then computed over findings belonging to in-window
 * runs only.
 *
 *   total_runs              — runs considered (after the optional window)
 *   distinct_fingerprints   — distinct fingerprints across in-window runs
 *   recurring_fingerprints  — fingerprints spanning > 1 in-window run
 *   recurrence_rate         — recurring / distinct  (0 when distinct is 0,
 *                             never NaN)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} [windowDays] — trailing window anchored at the newest run
 * @returns {{
 *   total_runs: number,
 *   distinct_fingerprints: number,
 *   recurring_fingerprints: number,
 *   recurrence_rate: number,
 *   window_days: number | null,
 * }}
 */
export function queryFindingRecurrenceRate(db, windowDays) {
  // F-36327af8: validate BEFORE windowDays reaches the SQL date-modifier
  // string below. Number(windowDays) on a malformed value (the realistic
  // operator typo '30days', or 'abc') is NaN, and SQLite's datetime() returns
  // NULL for an unparseable modifier like '-NaN days' rather than throwing —
  // so the WHERE clause silently matched zero rows and this function
  // returned the SAME clean, all-zero shape a genuinely empty run population
  // produces, with no error and no warning. Not reachable via the shipped
  // `swarm trends` CLI (cli.js already validates --window-days against a
  // strict ^\d+$ regex before calling here) but IS reachable via this
  // package's documented public surface (package.json's "./lib/*" export) —
  // mirrors this package's own established discipline elsewhere of not
  // trusting a single call site to be the only guard for a shared, exported
  // function (see lib/verify/runner.js's readEnvMaxBufferBytes, which
  // validates with the same Number.isFinite check rather than trusting its
  // one caller).
  // F-b5fd9887: `Number('') === 0`, a well-known JS coercion quirk, so an
  // empty/whitespace-only windowDays (an unfilled form field, or an unset
  // query-string param forwarded verbatim as `?windowDays=`) passed
  // Number.isFinite cleanly and was silently treated as a valid "window = 0
  // days" request — the exact "plausible result masking malformed input"
  // shape F-36327af8 already named, just for a narrower value that guard
  // didn't reach. Checked BEFORE the Number.isFinite fallback so a
  // non-numeric-looking string never gets a chance to coerce to a number at
  // all; a genuine numeric string ('30', '3650') has no leading/trailing-only
  // whitespace content and is untouched by this clause.
  if (
    windowDays !== undefined && windowDays !== null
    && (String(windowDays).trim() === '' || !Number.isFinite(Number(windowDays)))
  ) {
    throw new Error(
      `queryFindingRecurrenceRate: windowDays must be a finite number, or omitted/null for "all runs" — got ${JSON.stringify(windowDays)}`,
    );
  }

  // Resolve the in-window run id set. Without a window, all runs are in scope.
  let runIds;
  if (windowDays === undefined || windowDays === null) {
    runIds = db.prepare(`SELECT id FROM runs`).all().map(r => r.id);
  } else {
    // Anchor: the newest run's created_at. The window is [anchor - N days,
    // anchor]. datetime() arithmetic stays inside SQLite so it honors the
    // stored 'YYYY-MM-DD HH:MM:SS' format consistently.
    const anchorRow = db.prepare(`SELECT MAX(created_at) AS anchor FROM runs`).get();
    const anchor = anchorRow ? anchorRow.anchor : null;
    if (!anchor) {
      runIds = [];
    } else {
      runIds = db.prepare(`
        SELECT id FROM runs
        WHERE created_at >= datetime(?, ?)
      `).all(anchor, `-${Number(windowDays)} days`).map(r => r.id);
    }
  }

  const total_runs = runIds.length;
  if (total_runs === 0) {
    return {
      total_runs: 0,
      distinct_fingerprints: 0,
      recurring_fingerprints: 0,
      recurrence_rate: 0,
      window_days: windowDays ?? null,
    };
  }

  const placeholders = runIds.map(() => '?').join(',');

  const distinctRow = db.prepare(`
    SELECT COUNT(DISTINCT fingerprint) AS n
    FROM findings
    WHERE run_id IN (${placeholders})
  `).get(...runIds);
  const distinct_fingerprints = distinctRow.n;

  // Fingerprints spanning > 1 of the in-window runs.
  const recurringRow = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT fingerprint
      FROM findings
      WHERE run_id IN (${placeholders})
      GROUP BY fingerprint
      HAVING COUNT(DISTINCT run_id) > 1
    )
  `).get(...runIds);
  const recurring_fingerprints = recurringRow.n;

  const recurrence_rate =
    distinct_fingerprints > 0 ? recurring_fingerprints / distinct_fingerprints : 0;

  return {
    total_runs,
    distinct_fingerprints,
    recurring_fingerprints,
    recurrence_rate,
    window_days: windowDays ?? null,
  };
}
