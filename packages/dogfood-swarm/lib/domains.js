/**
 * domains.js — Auto-detect repo domains, draft/freeze, ownership enforcement.
 *
 * Domain mapping is draft-first: auto-detect proposes, coordinator edits, then freeze.
 * Three ownership classes: owned (exclusive), shared (multi-domain), bridge (coordinator-approved).
 *
 * Every domain change is persisted as a domain_event.
 * Waves capture a domain_snapshot_id at dispatch time.
 * Collect validates against the snapshot, not the latest state.
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

  const frozen = aredomainsFrozen(db, runId);
  if (frozen) throw new Error('Domains are frozen. Unfreeze first.');

  const result = db.prepare(
    'INSERT INTO domains (run_id, name, globs, ownership_class, description, frozen) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(runId, domain.name, JSON.stringify(domain.globs), domain.ownership_class, domain.description || '');

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

// ── Freeze / Unfreeze ──

export function freezeDomains(db, runId) {
  const domains = getDomains(db, runId);
  if (domains.length === 0) throw new Error('No domains to freeze');

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
 * Unfreeze domains. Requires a reason — this is a coordinator-authorized action.
 */
export function unfreezeDomains(db, runId, reason) {
  if (!reason) throw new Error('Unfreeze requires a reason');

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
    const matchesOwn = agentDomain.globs.some(g => minimatch(file, g, { dot: true }));

    if (matchesOwn) {
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

    const owner = domains.find(d =>
      d.ownership_class === 'owned' &&
      d.globs.some(g => minimatch(file, g, { dot: true }))
    );
    violations.push({
      file,
      agent_domain: domainName,
      actual_owner: owner?.name || 'unassigned',
    });
  }

  return { valid, violations };
}
