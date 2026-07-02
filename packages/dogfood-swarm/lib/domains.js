/**
 * domains.js — Auto-detect repo domains, draft/freeze, ownership enforcement.
 *
 * Domain mapping is draft-first: auto-detect proposes, coordinator edits, then freeze.
 * Three ownership classes: owned (exclusive), shared (multi-domain), bridge (coordinator-approved).
 *
 * Every domain change is persisted as a domain_event.
 *
 * Ownership is checked (checkOwnership) against the CURRENT frozen domain map.
 * The frozen map is kept effectively authoritative for the duration of a wave
 * by two guards: editDomain/addDomain/removeDomain refuse while frozen, and
 * unfreezeDomains refuses while a wave is in flight (dispatched/collecting)
 * unless an explicit { force, reason } is given. Together these close the
 * dispatch→collect drift window so the latest map == the dispatch-time map.
 *
 * Waves still capture a domain_snapshot_id at dispatch time for the audit
 * trail (takeDomainSnapshot). Making checkOwnership consult that literal
 * snapshot payload — rather than relying on the no-drift guards above — is a
 * deeper follow-up (collect.js would need to thread the wave's snapshot id in);
 * see sm-001. Until then the snapshot is forensic, and the no-drift guards are
 * what actually keep ownership honest.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { minimatch } from 'minimatch';
import { isSafeDomainName } from './worktree.js';

/**
 * Default domain buckets with detection heuristics.
 * Order matters: first match wins for a file.
 */
const DEFAULT_BUCKETS = [
  {
    name: 'tests',
    globs: ['tests/**', 'test/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
            '**/conftest.py', '**/pytest.ini', '**/jest.config.*', '**/vitest.config.*'],
    ownership_class: 'owned',
  },
  {
    name: 'ci-tooling',
    globs: ['.github/**', '.gitlab-ci.yml', 'Makefile', 'Justfile',
            'Dockerfile', 'docker-compose.*', '.eslintrc*', '.prettierrc*',
            'tsconfig*.json', 'biome.json', 'ruff.toml', '.cargo/config.toml'],
    ownership_class: 'owned',
  },
  {
    name: 'docs',
    globs: ['*.md', 'docs/**', 'site/**', 'handbook/**', 'LICENSE', 'CHANGELOG*'],
    ownership_class: 'owned',
  },
  {
    name: 'frontend',
    globs: ['src/ui/**', 'src/frontend/**', 'src/client/**', 'src/components/**',
            'public/**', 'static/**', '*.html', 'src/**/*.css',
            'src/**/*.tsx', 'src/**/*.jsx', 'src/**/*.vue', 'src/**/*.svelte'],
    ownership_class: 'owned',
  },
  {
    name: 'backend',
    globs: ['src/**', 'lib/**', 'packages/**', 'crates/**',
            'server.*', 'main.*', 'index.*', 'cli.*', 'app.*',
            'cmd/**', 'internal/**', 'pkg/**'],
    ownership_class: 'owned',
  },
  {
    name: 'shared',
    globs: ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock',
            'pyproject.toml', 'poetry.lock', 'go.mod', 'go.sum',
            '*.toml', '*.json', '*.yaml', '*.yml'],
    ownership_class: 'shared',
  },
];

// ── Directory walker ──

function walkDir(rootDir, maxDepth = 8) {
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', '__pycache__',
                        '.next', 'build', 'coverage', '.turbo', '.cache']);
  const files = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(rootDir, 0);
  return files;
}

// ── Detection ──

export function detectDomains(repoPath) {
  const allFiles = walkDir(repoPath);
  const claimed = new Set();
  const domains = [];

  for (const bucket of DEFAULT_BUCKETS) {
    const matched = [];
    for (const file of allFiles) {
      if (claimed.has(file)) continue;
      for (const glob of bucket.globs) {
        if (minimatch(file, glob, { dot: true })) {
          matched.push(file);
          if (bucket.ownership_class === 'owned') claimed.add(file);
          break;
        }
      }
    }
    if (matched.length > 0) {
      domains.push({
        name: bucket.name,
        globs: bucket.globs,
        ownership_class: bucket.ownership_class,
        matched_files: matched,
      });
    }
  }

  const unmatched = allFiles.filter(f => !claimed.has(f));
  return { domains, unmatched };
}

// ── CRUD ──

export function saveDomainDraft(db, runId, domains) {
  const insert = db.prepare(
    "INSERT INTO domains (run_id, name, globs, ownership_class, description, frozen) VALUES (?, ?, ?, ?, '', 0)"
  );
  const insertEvent = db.prepare(
    'INSERT INTO domain_events (domain_id, event_type, new_value, reason) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const d of domains) {
      const result = insert.run(runId, d.name, JSON.stringify(d.globs), d.ownership_class);
      insertEvent.run(result.lastInsertRowid, 'created',
        JSON.stringify({ name: d.name, globs: d.globs, ownership_class: d.ownership_class }),
        'Auto-detected from repo structure');
    }
  });
  tx();
}

export function getDomains(db, runId) {
  return db.prepare('SELECT * FROM domains WHERE run_id = ? ORDER BY name').all(runId)
    .map(d => ({ ...d, globs: JSON.parse(d.globs) }));
}

/**
 * Edit a domain's globs, ownership class, or description.
 * Only allowed when domains are NOT frozen.
 */
export function editDomain(db, runId, domainName, changes) {
  const domain = db.prepare('SELECT * FROM domains WHERE run_id = ? AND name = ?').get(runId, domainName);
  if (!domain) throw new Error(`Domain "${domainName}" not found for run ${runId}`);
  if (domain.frozen) throw new Error(`Domain "${domainName}" is frozen. Unfreeze first.`);

  const updates = [];
  const values = [];
  const oldValues = {};

  if (changes.globs) {
    oldValues.globs = domain.globs;
    updates.push('globs = ?');
    values.push(JSON.stringify(changes.globs));
  }
  if (changes.ownership_class) {
    if (!['owned', 'shared', 'bridge'].includes(changes.ownership_class)) {
      throw new Error(`Invalid ownership class: "${changes.ownership_class}"`);
    }
    oldValues.ownership_class = domain.ownership_class;
    updates.push('ownership_class = ?');
    values.push(changes.ownership_class);
  }
  if (changes.description != null) {
    oldValues.description = domain.description;
    updates.push('description = ?');
    values.push(changes.description);
  }

  if (updates.length === 0) return;

  values.push(domain.id);
  db.prepare(`UPDATE domains SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Log event
  db.prepare(
    'INSERT INTO domain_events (domain_id, event_type, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?)'
  ).run(domain.id, 'edited', JSON.stringify(oldValues), JSON.stringify(changes), changes.reason || null);
}

/**
 * Add a new domain to a run. Only allowed when not frozen.
 */
export function addDomain(db, runId, domain) {
  // Domain names flow downstream into filesystem paths (.swarm/worktrees/<name>),
  // git branch names (swarm/<run>/wN-<name>), and shell-quoted git commands
  // (pre-fix). Reject at the boundary so a malicious `swarm domains --add
  // "../../tmp"` or `"; rm -rf / ; "` never reaches createWorktree(). The same
  // predicate guards createWorktree() defense-in-depth.
  if (!isSafeDomainName(domain.name)) {
    throw new Error(
      `Unsafe domain name: ${JSON.stringify(domain.name)} — must match /^[a-zA-Z0-9_-]+$/ and be ≤64 chars`
    );
  }

  // d5-swarm-cli-004 (Stage A): editDomain validates ownership_class against the
  // {owned,shared,bridge} enum but addDomain did not — a literal bad value (e.g.
  // `swarm domains --add x --ownership garbage`) persisted unvalidated and only
  // surfaced as a downstream ownership-accounting surprise. Reject at the same
  // boundary editDomain uses. (Mirrors editDomain's inline guard above.)
  if (domain.ownership_class != null
      && !['owned', 'shared', 'bridge'].includes(domain.ownership_class)) {
    throw new Error(`Invalid ownership class: ${JSON.stringify(domain.ownership_class)}`);
  }

  const frozen = aredomainsFrozen(db, runId);
  if (frozen) throw new Error('Domains are frozen. Unfreeze first.');

  const result = db.prepare(
    'INSERT INTO domains (run_id, name, globs, ownership_class, description, frozen) VALUES (?, ?, ?, ?, ?, 0)'
    // ownership_class is NOT NULL DEFAULT 'owned' in the schema; bind the
    // documented default when the caller omits it rather than binding NULL
    // (which the explicit column list would otherwise force into a constraint
    // violation, bypassing the schema's own default).
  ).run(runId, domain.name, JSON.stringify(domain.globs), domain.ownership_class ?? 'owned', domain.description || '');

  db.prepare(
    'INSERT INTO domain_events (domain_id, event_type, new_value, reason) VALUES (?, ?, ?, ?)'
  ).run(result.lastInsertRowid, 'created', JSON.stringify(domain), 'Manual addition');

  return Number(result.lastInsertRowid);
}

/**
 * Remove a domain from a run. Only allowed when not frozen.
 */
export function removeDomain(db, runId, domainName) {
  const domain = db.prepare('SELECT * FROM domains WHERE run_id = ? AND name = ?').get(runId, domainName);
  if (!domain) throw new Error(`Domain "${domainName}" not found`);
  if (domain.frozen) throw new Error('Domains are frozen. Unfreeze first.');

  // Delete events first (FK), then the domain
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM domain_events WHERE domain_id = ?').run(domain.id);
    db.prepare('DELETE FROM domains WHERE id = ?').run(domain.id);
  });
  tx();
}

// ── Ownership arbitration ──

/**
 * Derive a representative concrete path from a glob by substituting its
 * wildcard segments with a fixed token. Used only to probe whether two owned
 * domains' glob sets can match a common file (overlap detection) — it does NOT
 * need to enumerate every match, just to produce one path the glob owns.
 *
 * `src/**\/*.tsx` → `src/x/x.tsx`; `src/**` → `src/x`; `*.md` → `x.md`.
 *
 * sm-p-001: brace alternations `{a,b}` and char classes `[abc]` are collapsed
 * to one representative literal FIRST, so an operator-authored owned glob like
 * `src/{ui,frontend}/**` yields a probe path (`src/ui/x`) that minimatch still
 * matches against the source glob. Without this, the sampled path kept the
 * literal brace/bracket syntax, minimatch returned false against its own glob,
 * and findOwnedGlobOverlaps was BLIND to brace/class owned domains — two
 * identical `src/{a,b}/**` owners would freeze silently. Defense-in-depth only:
 * runtime checkOwnership matches real file paths where minimatch handles braces
 * natively; this only restores the freeze-time overlap probe.
 */
function sampleGlobPath(glob) {
  return glob
    // `{a,b,c}` → first alternative (`a`); `{a}` and empty `{}` collapse too.
    .replace(/\{([^},]*)(?:,[^}]*)*\}/g, '$1')
    // `[abc]` / `[a-z]` char class → a concrete char the class ACTUALLY matches
    // (the range start `a` for `[a-z]`, the first literal for `[abc]`). A fixed
    // token like `x` would not be a member of `[ab]`, so minimatch would still
    // miss the sample against its own glob and the overlap probe would stay
    // blind. Negated classes `[^…]` fall back to `x` (a safe non-member).
    .replace(/\[(\^?)([^\]])[^\]]*\]/g, (_, neg, first) => (neg ? 'x' : first))
    .replace(/\*\*\//g, 'x/')   // `**/` directory wildcard → one segment
    .replace(/\*\*/g, 'x')      // bare `**` → one segment
    .replace(/\*/g, 'x')        // `*` → token (keeps the extension on `*.tsx`)
    .replace(/\?/g, 'x');
}

/**
 * Score a glob's specificity as a comparable tuple. A glob with more literal
 * path before its first wildcard is more specific; ties break on total literal
 * character count (so `src/**` `*.tsx` outranks `src/**` on its `.tsx` literal);
 * a final tie-break demotes globs with more `**` (broader reach = less
 * specific). This is what lets frontend's `src/ui/**` / `src/**` `*.tsx`
 * out-rank backend's `src/**` for a `.tsx` file — encoding detectDomains'
 * first-match-wins intent as an order-independent property of the globs.
 *
 * @returns {[number, number, number]} [literalLeadSegments, literalChars, -doubleStars]
 */
function globSpecificity(glob) {
  const segments = glob.split('/');
  let literalLead = 0;
  for (const seg of segments) {
    if (seg.includes('*') || seg.includes('?')) break;
    literalLead++;
  }
  const literalChars = glob.replace(/[*?/]/g, '').length;
  const doubleStars = (glob.match(/\*\*/g) || []).length;
  return [literalLead, literalChars, -doubleStars];
}

/** Lexicographic compare of two specificity tuples (>0 ⇒ `a` more specific). */
function compareSpecificity(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The best (highest-specificity) glob in `globs` matching `file`, or null if
 * none match. The returned score arbitrates which owned domain owns the file.
 */
function bestMatchingGlob(globs, file) {
  let best = null;
  for (const glob of globs) {
    if (!minimatch(file, glob, { dot: true })) continue;
    const score = globSpecificity(glob);
    if (best === null || compareSpecificity(score, best.score) > 0) {
      best = { glob, score };
    }
  }
  return best;
}

/**
 * Find pairs of OWNED domains whose globs overlap — i.e. some file is claimed
 * by more than one exclusive owner WITH EQUAL specificity (a genuine
 * criss-cross, e.g. two `**` domains, or `src/a/**` vs `src/a/**`). A
 * strict-SUBSET overlap (one glob strictly more specific, like frontend's
 * `src/ui/**` inside backend's `src/**`) is NOT a conflict: resolveExclusiveOwner
 * arbitrates it to a single owner by specificity, exactly as detectDomains'
 * first-match-wins does. sm-002 rejected ANY glob-level overlap, which broke
 * freezing the auto-detected default full-stack map (sm-r-001); only an
 * equal-specificity tie actually breaches per-domain isolation. We sample a
 * concrete path from each owned glob and, for any OTHER owned domain that also
 * matches it, compare both domains' best-matching specificity.
 *
 * @returns {Array<{ a: string, b: string, file: string }>} conflicting pairs
 */
function findOwnedGlobOverlaps(domains) {
  const owned = domains.filter(d => d.ownership_class === 'owned');
  const conflicts = [];
  const seen = new Set();

  for (const domain of owned) {
    for (const glob of domain.globs) {
      const sample = sampleGlobPath(glob);
      for (const other of owned) {
        if (other.name === domain.name) continue;
        const here = bestMatchingGlob(domain.globs, sample);
        const there = bestMatchingGlob(other.globs, sample);
        if (!here || !there) continue;
        // Only an EQUAL-specificity tie is a genuine breach; if one glob is
        // strictly more specific, resolveExclusiveOwner arbitrates the file to
        // a single owner (same as detectDomains' first-match-wins), so a
        // strict-subset overlap (frontend's src/ui/** ⊂ backend's src/**) is
        // legal — not a conflict (sm-r-001).
        if (compareSpecificity(here.score, there.score) !== 0) continue;
        const key = [domain.name, other.name].sort().join('\u0000') + '\u0000' + sample;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ a: domain.name, b: other.name, file: sample });
      }
    }
  }
  return conflicts;
}

/**
 * Resolve the single exclusive owner of a file by specificity: the owned domain
 * whose best-matching glob is the most specific wins, ties broken
 * deterministically by domain name. This is ORDER-INDEPENDENT — it does not
 * depend on getDomains' ORDER BY name nor on DEFAULT_BUCKETS order — yet it
 * matches detectDomains' first-match-wins intent (the earlier, narrower bucket
 * claims the file), so `src/ui/App.tsx` resolves to frontend (`src/ui/**`,
 * `src/**` *.tsx) over backend (`src/**`). sm-r-001: the prior version iterated
 * getDomains' alphabetical order, which DISAGREED with detection order and
 * misattributed ownership once the freeze guard was relaxed. Returns the owning
 * domain name, or null if no owned domain matches.
 *
 * Exported (wave2-live-001): the non-isolated ownership-probe narrowing in
 * collect/revalidate must use THIS arbitration, not bare glob membership —
 * with overlapping globs (`**\/*.test.*` vs `packages/<pkg>/**`) membership
 * over-collects sibling agents' edits and enforcement then phantom-flags them.
 */
export function resolveExclusiveOwner(domains, file) {
  let winner = null;
  for (const d of domains) {
    if (d.ownership_class !== 'owned') continue;
    const match = bestMatchingGlob(d.globs, file);
    if (!match) continue;
    if (winner === null) {
      winner = { name: d.name, score: match.score };
      continue;
    }
    const cmp = compareSpecificity(match.score, winner.score);
    if (cmp > 0 || (cmp === 0 && d.name < winner.name)) {
      winner = { name: d.name, score: match.score };
    }
  }
  return winner ? winner.name : null;
}

/**
 * Narrow a file set to those THIS domain exclusively owns — the non-isolated
 * ownership-probe narrowing (wave2-live-001 / V2-INVARIAN-002). In a
 * shared-worktree amend wave the whole-tree diff cannot be attributed
 * per-agent, so the independent probe contribution is restricted to the files
 * this domain wins under the SAME specificity arbitration checkOwnership uses
 * — bare glob MEMBERSHIP over-collects when globs overlap (`**\/*.test.*` vs
 * `packages/<pkg>/**`) and enforcement then phantom-flags sibling agents'
 * in-domain edits. ONE helper, consumed by BOTH commands/collect.js and
 * commands/revalidate.js, so the arbitration cannot fork between the two paths.
 *
 * @param {Array<object>} domains — getDomains() rows (globs parsed)
 * @param {string} domainName — the agent's domain
 * @param {string[]} files — forward-slash-normalized candidate paths
 * @returns {string[]} — the subset exclusively owned by `domainName`
 */
export function narrowToExclusivelyOwned(domains, domainName, files) {
  return files.filter(f => resolveExclusiveOwner(domains, f) === domainName);
}

// ── Freeze / Unfreeze ──

export function freezeDomains(db, runId) {
  const domains = getDomains(db, runId);
  if (domains.length === 0) throw new Error('No domains to freeze');

  // sm-002: reject overlapping OWNED globs at the freeze boundary so the bad
  // state never exists. Two exclusive owners that both claim the same file
  // defeat per-domain worktree isolation — fail fast and name the conflict.
  const overlaps = findOwnedGlobOverlaps(domains);
  if (overlaps.length > 0) {
    const detail = overlaps
      .map(c => `"${c.a}" and "${c.b}" both claim ${c.file}`)
      .join('; ');
    throw new Error(
      `Cannot freeze: overlapping owned domains breach exclusive ownership — ${detail}. ` +
      `Make the globs disjoint or reclassify one domain as shared/bridge.`
    );
  }

  db.prepare('UPDATE domains SET frozen = 1 WHERE run_id = ?').run(runId);

  // Log freeze event for each domain
  const insertEvent = db.prepare(
    'INSERT INTO domain_events (domain_id, event_type, reason) VALUES (?, ?, ?)'
  );
  for (const d of domains) {
    insertEvent.run(d.id, 'frozen', 'Coordinator froze domain map');
  }
}

/**
 * Statuses a wave is in while its agents are dispatched or being collected —
 * the window during which the frozen domain map is the live ownership contract.
 * Editing globs here would drift the map out from under in-flight agents.
 */
const ACTIVE_WAVE_STATUSES = ['dispatched', 'collecting'];

/**
 * Is there a wave for this run that is still in flight (dispatched/collecting)?
 */
export function hasActiveWave(db, runId) {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM waves
     WHERE run_id = ? AND status IN (${ACTIVE_WAVE_STATUSES.map(() => '?').join(', ')})`
  ).get(runId, ...ACTIVE_WAVE_STATUSES);
  return row.cnt > 0;
}

/**
 * Unfreeze domains. Requires a reason — this is a coordinator-authorized action.
 *
 * sm-001: refuses while a wave is in flight (dispatched/collecting). Unfreezing
 * mid-wave lets an operator broaden globs between dispatch and collect, so a
 * file that was out-of-domain at dispatch time silently passes ownership at
 * collect time and the captured domain_snapshot_id becomes decorative. The
 * guard keeps the frozen map authoritative for the duration of a wave. An
 * explicit { force: true } (still requiring a reason) is the documented escape
 * hatch for a coordinator who has stopped the wave by hand.
 *
 * @param {Database} db
 * @param {string} runId
 * @param {string} reason
 * @param {object} [opts]
 * @param {boolean} [opts.force] — bypass the in-flight-wave guard
 */
export function unfreezeDomains(db, runId, reason, opts = {}) {
  if (!reason) throw new Error('Unfreeze requires a reason');

  if (!opts.force && hasActiveWave(db, runId)) {
    throw new Error(
      `Cannot unfreeze: a wave is in flight (${ACTIVE_WAVE_STATUSES.join('/')}) for run ${runId}. ` +
      `Editing the domain map now would drift ownership out from under the dispatched agents ` +
      `(the dispatch-time snapshot would no longer match the live map). ` +
      `Collect or abort the wave first, or pass { force: true } with a reason if you have ` +
      `already halted the wave by hand.`
    );
  }

  const domains = getDomains(db, runId);
  db.prepare('UPDATE domains SET frozen = 0 WHERE run_id = ?').run(runId);

  const insertEvent = db.prepare(
    'INSERT INTO domain_events (domain_id, event_type, reason) VALUES (?, ?, ?)'
  );
  for (const d of domains) {
    insertEvent.run(d.id, 'unfrozen', reason);
  }
}

export function aredomainsFrozen(db, runId) {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM domains WHERE run_id = ? AND frozen = 0'
  ).get(runId);
  const total = db.prepare(
    'SELECT COUNT(*) as cnt FROM domains WHERE run_id = ?'
  ).get(runId);
  return total.cnt > 0 && row.cnt === 0;
}

// ── Domain snapshots ──

/**
 * Take a snapshot of the current frozen domain map.
 * Returns a snapshot ID (content hash of domain config).
 */
export function takeDomainSnapshot(db, runId) {
  const domains = getDomains(db, runId);
  const payload = domains.map(d => ({
    name: d.name,
    globs: d.globs,
    ownership_class: d.ownership_class,
  }));
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return { snapshotId: hash, domains: payload };
}

/**
 * Get domain events for a run.
 */
export function getDomainEvents(db, runId) {
  return db.prepare(`
    SELECT de.*, d.name as domain_name
    FROM domain_events de
    JOIN domains d ON de.domain_id = d.id
    WHERE d.run_id = ?
    ORDER BY de.created_at
  `).all(runId);
}

// ── Ownership checking ──

export function checkOwnership(db, runId, domainName, changedFiles) {
  const domains = getDomains(db, runId);
  const agentDomain = domains.find(d => d.name === domainName);
  if (!agentDomain) throw new Error(`Domain "${domainName}" not found for run ${runId}`);

  const valid = [];
  const violations = [];

  for (const file of changedFiles) {
    // sm-002: resolve the file's SINGLE exclusive owner via first-match-wins
    // (same arbitration detectDomains uses) rather than testing the agent's
    // globs in isolation. With overlapping owned globs (which freezeDomains now
    // rejects, but this is the defense-in-depth runtime half) a bare
    // `globs.some(...)` would let a non-owner pass; here a file owned by some
    // OTHER owned domain falls through to the violation path below.
    const exclusiveOwner = resolveExclusiveOwner(domains, file);

    if (exclusiveOwner === agentDomain.name) {
      valid.push({ file, reason: 'matches own domain' });
      continue;
    }

    const sharedDomain = domains.find(d =>
      d.ownership_class === 'shared' &&
      d.globs.some(g => minimatch(file, g, { dot: true }))
    );
    if (sharedDomain) {
      valid.push({ file, reason: `shared via ${sharedDomain.name}` });
      continue;
    }

    const bridgeDomain = domains.find(d =>
      d.ownership_class === 'bridge' &&
      d.globs.some(g => minimatch(file, g, { dot: true }))
    );
    if (bridgeDomain) {
      valid.push({ file, reason: `bridge via ${bridgeDomain.name}` });
      continue;
    }

    violations.push({
      file,
      agent_domain: domainName,
      actual_owner: exclusiveOwner || 'unassigned',
    });
  }

  return { valid, violations };
}
