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
 * Server-side source extensions for backend's ROOT-LEVEL entry-point
 * heuristics (`main.`, `index.`, `app.`, `server.`, `cli.`).
 *
 * These were bare `main.*` / `index.*` / … and so claimed EVERY extension,
 * including frontend's. Measured against globSpecificity the damage was not
 * uniform, and "both globs match" is not the same as "the freeze gate flags
 * it":
 *
 *   index.*  [0,6,0] beats *.html [0,5,0] -> backend won OUTRIGHT, no tie, so
 *            the gate never fired: `index.html` was SILENTLY backend's.
 *   main.*   [0,5,0] ties  *.html [0,5,0] -> flagged ('main.' and '.html' are
 *            coincidentally both 5 literal chars).
 *   server.* [0,7,0] beats *.html [0,5,0] -> silently backend's.
 *
 * The silent mis-assignments were the worse half: a tie at least fails the
 * freeze loudly. Nothing should have to ADJUDICATE whether `index.html` is
 * frontend — constraining the extension set removes the question rather than
 * arbitrating it. Frontend's `*.html` is correct and is left alone.
 *
 * `.html` / `.css` / `.jsx` / `.tsx` / `.vue` / `.svelte` are deliberately
 * EXCLUDED: frontend owns those.
 *
 * Honest gap, named rather than left silent: this trades the old catch-all's
 * OVER-claiming for UNDER-claiming. A root-level entry point in a language
 * outside this set (`main.zig`, `main.dart`, `server.erl`) is no longer
 * auto-claimed by backend, and a root-level `index.tsx` is now unclaimed by
 * ANY bucket — frontend's JSX/TSX globs are `src/`-scoped (`src/**\/*.tsx`),
 * so they do not reach the repo root. Both land in detectDomains' `unmatched`
 * list, which the operator sees and can assign. That is the safe direction:
 * unmatched is visible and fixable, a silent wrong owner is neither.
 */
const BACKEND_ENTRY_EXT =
  '{js,mjs,cjs,ts,mts,cts,py,go,rs,rb,java,kt,cs,php,c,cc,cpp,swift,ex,exs,scala,sh}';

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
            `server.${BACKEND_ENTRY_EXT}`, `main.${BACKEND_ENTRY_EXT}`,
            `index.${BACKEND_ENTRY_EXT}`, `cli.${BACKEND_ENTRY_EXT}`,
            `app.${BACKEND_ENTRY_EXT}`,
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
 * Whether two single-segment wildcard patterns (`*` = zero-or-more chars,
 * `?` = exactly one char, everything else literal) can match a COMMON
 * string. The classic two-pattern wildcard-intersection recursion, memoized
 * on (i, j) -- segments are short operator-authored config, not attacker
 * input, but memoizing costs nothing and rules out any pathological blowup.
 *
 * @returns {boolean}
 */
function segmentsCanIntersect(a, b) {
  const memo = new Map();
  function go(i, j) {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (i === a.length && j === b.length) {
      result = true;
    } else if (i < a.length && a[i] === '*') {
      result = go(i + 1, j) || (j < b.length && go(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      result = go(i, j + 1) || (i < a.length && go(i + 1, j));
    } else if (i < a.length && j < b.length && (a[i] === '?' || b[j] === '?' || a[i] === b[j])) {
      result = go(i + 1, j + 1);
    } else {
      result = false;
    }
    memo.set(key, result);
    return result;
  }
  return go(0, 0);
}

/**
 * Collapse brace-alternation and char-class syntax to ONE representative
 * literal, leaving `*` / `?` / `**` wildcards untouched -- globsCanIntersect
 * reasons about wildcard SEGMENTS, so it must not flatten them to a sample.
 *
 * sm-p-001 (inherited from the retired sampleGlobPath probe, which this
 * replaced): an operator-authored owned glob like `src/{ui,frontend}/**` must
 * reduce to a representative the comparison can actually reason about
 * (`src/ui/**`). Left literal, the brace/bracket syntax is compared as opaque
 * text and the overlap gate goes BLIND to brace/class domains -- two identical
 * `src/{a,b}/**` owners would freeze silently. A char class collapses to a
 * member the class ACTUALLY matches (the range start `a` for `[a-z]`, the first
 * literal for `[abc]`); a fixed token like `x` would not be a member of `[ab]`
 * and would reintroduce the same blindness. Negated classes `[^...]` fall back
 * to `x`, a safe non-member.
 *
 * Honest bound: collapsing to the FIRST alternative is an approximation --
 * `{a,b}` vs `{b,c}` genuinely intersect at `b`, but both collapse to their
 * first member (`a` vs `b`) and compare disjoint, so this can produce a false
 * "disjoint" for brace globs whose overlap lives outside the first
 * alternative. That is the ONE place this module's error direction inverts
 * (everywhere else it over-approximates toward flagging). It is inherited
 * behavior, not introduced here, and it is why runtime checkOwnership --
 * which matches real paths with minimatch, where braces expand natively --
 * remains the enforcement of record; this gate is defense-in-depth at the
 * freeze boundary.
 */
function collapseAlternation(glob) {
  return glob
    // `{a,b,c}` -> first alternative (`a`); `{a}` and empty `{}` collapse too.
    .replace(/\{([^},]*)(?:,[^}]*)*\}/g, '$1')
    .replace(/\[(\^?)([^\]])[^\]]*\]/g, (_, neg, first) => (neg ? 'x' : first));
}

/**
 * Whether two globs' path languages can share a common member -- computed
 * EXACTLY for the fragment of glob syntax domain globs actually use (literal
 * segments, single-segment `*`/`?`, multi-segment `**`), not by sampling one
 * representative path per glob (sm-p-002: findOwnedGlobOverlaps' sampler
 * misses the case where two globs genuinely intersect but neither glob's OWN
 * sample happens to land in the other's language -- PROVEN: owned
 * `src/a*\/f.js` and owned `src/*b\/f.js` both minimatch `src/ab/f.js`, but
 * `src/a*\/f.js` samples to `src/ax/f.js` (rejected by `src/*b\/f.js`) and
 * `src/*b\/f.js` samples to `src/xb/f.js` (rejected by `src/a*\/f.js`), so
 * neither probe ever sees the other).
 *
 * `**` is handled conservatively, not exactly: a glob containing `**` can
 * absorb any number of segments (including zero) at that position, and
 * proving NON-intersection in that general case needs reasoning this
 * function does not attempt. When either side contains `**`, or the two
 * `**`-free segment sequences have different lengths, this returns
 * true/false by the one thing that IS decidable without it (constant
 * segment-count parity) -- see the two early returns below -- and otherwise
 * assumes POSSIBLE intersection rather than risk a false "disjoint". The
 * safe direction for an ownership gate is to flag a possible conflict, not
 * silently clear one; a false positive here costs an operator a glob
 * rewrite, a false negative costs a silently misattributed file.
 */
function globsCanIntersect(globA, globB) {
  const segsA = collapseAlternation(globA).split('/');
  const segsB = collapseAlternation(globB).split('/');

  const starA = segsA.indexOf('**');
  const starB = segsB.indexOf('**');

  // Every segment BEFORE the first `**` is positionally fixed in BOTH globs,
  // so ONE provably-disjoint constant pair there proves the whole languages
  // share no member. sm-p-002-r-001: the first draft of this function skipped
  // straight to `return true` whenever either side contained `**`, which
  // discarded exactly this information -- and since essentially every real
  // domain glob ends in `**`, freezeDomains then rejected every multi-domain
  // map (`packages/a/**` vs `packages/b/**` scored as a conflict). The
  // over-approximation direction was right; making it TOTAL was the defect.
  const fixedLen = Math.min(
    starA === -1 ? segsA.length : starA,
    starB === -1 ? segsB.length : starB,
  );
  for (let i = 0; i < fixedLen; i++) {
    if (!segmentsCanIntersect(segsA[i], segsB[i])) return false;
  }

  // A `**` on either side absorbs a variable-length gap, so from the first one
  // onward the two globs' segments no longer line up positionally and this
  // method decides nothing further -- fall back to the safe direction.
  if (starA !== -1 || starB !== -1) return true;

  // Neither glob has `**`: each segment consumes EXACTLY one path segment, so
  // a length mismatch is provably disjoint. When the lengths do match, the
  // loop above already compared every segment (fixedLen is both lengths).
  return segsA.length === segsB.length;
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
 * equal-specificity tie actually breaches per-domain isolation.
 *
 * sm-p-002: compares glob PAIRS directly rather than sampling one point per
 * glob -- globSpecificity is a pure function of the glob STRING (no sample
 * needed), so two globs (one from each domain) are a genuine tie candidate
 * whenever their specificity scores are equal AND globsCanIntersect proves
 * their languages share a member. This is sound and complete for the
 * single-glob-per-domain shape the regression proves; a domain whose OWN
 * glob LIST has a more-specific glob that shadows the compared one at every
 * point of the compared intersection is a residual gap this does not chase
 * (it would require reasoning about a witness FILE, not just glob pairs) --
 * documented, not hidden, and it only widens the SAFE direction (an
 * occasional over-flag an operator must disambiguate, never a silent miss).
 *
 * Evidence, in two tiers:
 *
 *   - With `files` (the run's real checkout — the normal path): a candidate
 *     tie is a conflict only when an ACTUAL file matches BOTH globs, and that
 *     file is reported as the `witness`. Nothing is assumed, nothing is
 *     fabricated.
 *   - Without `files` (no reachable local_path): fall back to the
 *     glob-language over-approximation and report the GLOB PAIR. There is no
 *     honest witness to name on this path -- when globsCanIntersect returns
 *     true via its `**` branch it has ASSUMED intersection rather than proven
 *     it, so no member of both languages is known to exist. The pre-fix
 *     message sampled a path from the FIRST glob and asserted "both claim" it
 *     -- for `packages/schemas/**` vs `swarms/templates/**` it named
 *     `packages/schemas/x`, which the second glob cannot match under any
 *     expansion, so the cited witness disproved the very claim it was cited
 *     for. The glob pair is accurate in every case AND is the thing the
 *     operator actually has to edit.
 *
 * The witness tier deliberately narrows the gate from "these globs COULD
 * collide" to "these globs DO collide in this checkout" -- see freezeDomains
 * for what that trade buys and what it gives up.
 *
 * @param {Array<object>} domains — getDomains() rows (globs parsed)
 * @param {string[]|null} [files] — the run's real file list, or null when unreachable
 * @returns {Array<{ a: string, b: string, globA: string, globB: string, witness: string|null }>}
 */
function findOwnedGlobOverlaps(domains, files = null) {
  const owned = domains.filter(d => d.ownership_class === 'owned');
  const conflicts = [];
  const seen = new Set();

  for (const domain of owned) {
    for (const glob of domain.globs) {
      const domainScore = globSpecificity(glob);
      for (const other of owned) {
        if (other.name === domain.name) continue;
        for (const otherGlob of other.globs) {
          if (compareSpecificity(domainScore, globSpecificity(otherGlob)) !== 0) continue;
          if (!globsCanIntersect(glob, otherGlob)) continue;

          let witness = null;
          if (files !== null) {
            witness = files.find(f =>
              minimatch(f, glob, { dot: true }) && minimatch(f, otherGlob, { dot: true })) || null;
            // Provably no file in this checkout is doubly-claimed, so these two
            // exclusive owners cannot actually contend for anything.
            if (witness === null) continue;
          }

          const key = [domain.name, other.name].sort().join('\u0000')
            + '\u0000' + [glob, otherGlob].sort().join('\u0000');
          if (seen.has(key)) continue;
          seen.add(key);
          conflicts.push({ a: domain.name, b: other.name, globA: glob, globB: otherGlob, witness });
        }
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

  // Resolve the run's real checkout so a candidate tie can be settled against
  // actual files rather than assumed from the glob languages. The gate's own
  // stated purpose is about FILES ("two exclusive owners that both claim the
  // same file"), so a tie no file can realize is not the bad state it exists
  // to prevent, and refusing the freeze for it is a false positive.
  //
  // The honest cost, stated rather than buried: this narrows a decidable
  // STATIC property to a point-in-time SNAPSHOT. A colliding file created
  // after the freeze is not re-checked here, and would surface later as a
  // checkOwnership arbitration (possibly a phantom violation) with no
  // freeze-time warning. The glob-only path below remains the fallback and
  // keeps the static guarantee whenever the checkout is unreachable.
  const run = db.prepare('SELECT local_path FROM runs WHERE id = ?').get(runId);
  let files = null;
  if (run?.local_path && existsSync(run.local_path)) {
    try {
      files = walkDir(run.local_path);
    } catch {
      files = null; // unreadable checkout — fall back rather than freeze on a lie
    }
  }

  // sm-002: reject overlapping OWNED globs at the freeze boundary so the bad
  // state never exists. Two exclusive owners that both claim the same file
  // defeat per-domain worktree isolation — fail fast and name the conflict.
  const overlaps = findOwnedGlobOverlaps(domains, files);
  if (overlaps.length > 0) {
    const detail = overlaps
      .map(c => (c.witness
        ? `"${c.a}" (${c.globA}) and "${c.b}" (${c.globB}) both claim ${c.witness}`
        : `"${c.a}" (${c.globA}) and "${c.b}" (${c.globB}) overlap at equal specificity`))
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
 * Statuses a wave is in while its agents are dispatched, being collected, or
 * mid-recovery — the window during which the frozen domain map is the live
 * ownership contract. Editing globs here would drift the map out from under
 * agents that were dispatched (or briefed) against the OLD map.
 *
 * F-60309675: 'failed' belongs here too. commands/revalidate.js re-runs the
 * ownership check on the 'failed' -> 'collected' recovery path, and
 * checkOwnership resolves against the LIVE domain map (getDomains), not the
 * wave's captured domain_snapshot_id (that snapshot is forensic only — see
 * this module's header). Without 'failed' in this list, an operator could
 * unfreeze a 'failed' wave, broaden the globs to cover files that violated
 * ownership at dispatch time, re-freeze, then `swarm revalidate --apply` —
 * laundering the violation into a pass against a map the agents were never
 * briefed with, with no error and only an auditable-but-easy-to-miss
 * unfrozen/frozen domain_events pair. Blocking unfreeze here keeps the
 * documented `{force:true}` + reason escape hatch for an operator who has
 * genuinely halted the wave by hand.
 *
 * 'collecting' has NO writer anywhere in this package (verified: no INSERT
 * or UPDATE sets a wave's status to the literal 'collecting' — only
 * db/schema.js's STATUS.wave enum and this module's own header mention it).
 * It is kept in this list — a phantom coverage gap costs nothing since it can
 * never fire — but its real coverage today is 'dispatched' and 'failed'; the
 * next writer that DOES use 'collecting' inherits the guard automatically.
 */
const ACTIVE_WAVE_STATUSES = ['dispatched', 'collecting', 'failed'];

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

    // DS-MUT-003: the shared/bridge fallback is ONLY for files with no
    // exclusive owner. A file exclusively owned by a DIFFERENT owned domain is
    // a VIOLATION even when a broad shared/bridge glob ALSO matches it — the
    // classic case is a root `tsconfig.json` claimed by an owned `ci-tooling`
    // domain (`tsconfig*.json`) AND the shared `*.json` glob. Letting the
    // shared match win here would override the exclusive owner and rule agent
    // A's edit of domain B's file "shared-valid", silently bypassing exclusive
    // ownership. Only fall through when the file is genuinely unowned.
    if (exclusiveOwner === null) {
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
    }

    violations.push({
      file,
      agent_domain: domainName,
      actual_owner: exclusiveOwner || 'unassigned',
    });
  }

  return { valid, violations };
}
