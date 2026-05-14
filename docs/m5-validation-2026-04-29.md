# M5 Max validation — Session G (2026-04-29)

> **Source:** Phase 7 swarm post-swarm session roadmap, Session G ("M5 Max migration validation — when M5 arrives ~2026-04-24"). See [`docs/swarm-evidence-2026-04-27.md`](swarm-evidence-2026-04-27.md). Hardware arrived 2026-04-29.
>
> **Scope:** Cross-platform validation of testing-os atomic primitives on Darwin. Run as a 2-filesystem matrix (APFS local, exFAT on the T9-Shared SSD where the working tree currently lives), not APFS-only — testing-os's home filesystem is exFAT post-2026-04-27 reformat, so refusing to test it there hides the real-world support surface.
>
> **Tip:** [`fd697e6`](https://github.com/dogfood-lab/testing-os/commit/fd697e6) — CHANGELOG backfill for v1.1.2 → v1.1.7.

## Environment

| Field | Value |
|---|---|
| Hardware | M5 Max MacBook Pro, 128 GB unified |
| OS | Darwin 25.4.0 |
| Node | v25.9.0 |
| npm | 11.13.0 |
| Local home FS | APFS (`/dev/disk3s5` on `/System/Volumes/Data`) |
| T9-Shared FS | **ExFAT** (`/dev/disk4s2`, mounted via FSKit) |

Node 25 is well past the CI matrix (Node 20 + 22). Both runs below succeeded on Node 25 where the test surface was reachable, so this is a positive forward-compat data point — not a finding.

## linkSync probe (pre-suite)

Run-before-tests probe of the three atomic primitives testing-os depends on, executed against the same Node binary that runs the suite. Source: [`/tmp/linksync-probe.mjs`](file:///tmp/linksync-probe.mjs).

| Primitive | APFS (`~`) | exFAT (T9) |
|---|---|---|
| `linkSync` (hardlink) | **OK** — same inode, nlink=2, both readable | **FAILS** — `ENOTSUP` (errno -45), `syscall: 'link'` |
| `renameSync` | OK | OK |
| Exclusive open (`{ flag: 'wx' }`) | OK — second attempt errors `EEXIST` as expected | OK — `EEXIST` enforced |

**Material finding:** `linkSync` errors **loudly** on exFAT, not silently. This is the good failure mode the advisor pre-flight (#2 conviction) flagged as "the difference between a documented limitation and a silent production-semantics regression." The file-lock CAS in [`findings/lib/file-lock.js:123`](../packages/findings/lib/file-lock.js) (`atomicCreateLock`) propagates the throw upward; callers see the error rather than thinking they hold a lock that was never created.

`renameSync` and exclusive-open both work on exFAT, so SOME atomic patterns are available. The specific pattern testing-os adopted in v1.1.5 (`writeFileSync(tmp, pid) + linkSync(tmp, lock)` for one-syscall publication) does not.

## Suite matrix — `npm run verify`

Both runs use the canonical local check from [CLAUDE.md](../CLAUDE.md): `npm install` then `npm run verify` (which chains `sync-version:check && check-doc-drift && check-regression-pins && test:scripts && build && test`).

### APFS clone — `~/repos/testing-os/`

Fresh `git clone https://github.com/dogfood-lab/testing-os.git` into `~/repos/`, not a copy of the T9 working tree (to keep the FS state uncontaminated).

```text
npm install:    exit 0,  ~13s wall
npm run verify: exit 0
```

Per-package: **965 / 965 tests pass.**

| Package | tests | pass | fail |
|---|---:|---:|---:|
| `test:scripts` (root) | 91 | 91 | 0 |
| `@dogfood-lab/dogfood-swarm` | 380 | 380 | 0 |
| `@dogfood-lab/findings` | 246 | 246 | 0 |
| `@dogfood-lab/ingest` | 85 | 85 | 0 |
| `@dogfood-lab/portfolio` | 57 | 57 | 0 |
| `@dogfood-lab/report` | 27 | 27 | 0 |
| `@dogfood-lab/verify` | 41 | 41 | 0 |
| `@dogfood-lab/schemas` (vitest) | 38 | 38 | 0 |
| **Total** | **965** | **965** | **0** |

Matches the v1.1.5 / v1.1.6 / v1.1.7 CHANGELOG entries' "965/965 tests" claim exactly.

### T9 in-place — `/Volumes/T9-Shared/AI/dogfood-lab/testing-os/`

Same HEAD as the APFS clone (`fd697e6`). `node_modules` was not pre-existing — fresh install on the exFAT volume.

```text
npm install:    exit 0,  ~14s wall
npm run verify: exit 1 (early-exits at first failing workspace)
```

Per-package: **940 / 965 tests pass; 25 failures, all rooted in `linkSync` ENOTSUP** through the file-lock CAS path.

| Package | tests | pass | fail | failure root |
|---|---:|---:|---:|---|
| `test:scripts` (root) | 91 | 91 | 0 | — |
| `@dogfood-lab/dogfood-swarm` | 380 | 380 | 0 | — (does not exercise file-lock in tests) |
| `@dogfood-lab/findings` | 246 | 229 | **13** | `linkSync ENOTSUP` via `atomicCreateLock` (10 direct, 3 cascading assertion failures because fixtures couldn't be written) |
| `@dogfood-lab/ingest` | 85 | 73 | **12** | `linkSync ENOTSUP` via `event-log-race.test.js` + `ingest.test.js:506` |
| `@dogfood-lab/portfolio` | 57 | 57 | 0 | — |
| `@dogfood-lab/report` | 27 | 27 | 0 | — |
| `@dogfood-lab/verify` | 41 | 41 | 0 | — |
| `@dogfood-lab/schemas` (vitest) | 38 | 38 | 0 | — |
| **Total** | **965** | **940** | **25** | — |

Representative error from `review/review.test.js:104` (one of 22 identical-shape errors):

```text
Error: ENOTSUP: operation not supported on socket, link
  '.../packages/findings/review/__test_review__/reviews/2026/2026-04-29-finding-review-log.yaml.lock.10563.654bebdf.tmp'
  -> '.../packages/findings/review/__test_review__/reviews/2026/2026-04-29-finding-review-log.yaml.lock'
  at linkSync (node:fs:1891:11)
  at atomicCreateLock (packages/findings/lib/file-lock.js:123:5)
  at tryAcquire (packages/findings/lib/file-lock.js:159:7)
  at withFileLock (packages/findings/lib/file-lock.js:328:9)
  at appendEvent (packages/findings/review/event-log.js:106:10)
  at performAction (packages/findings/review/review-engine.js:144:3)
  errno: -45, code: 'ENOTSUP', syscall: 'link'
```

The "operation not supported on socket" message is misleading — Darwin's generic `ENOTSUP` text is `"operation not supported on socket"` regardless of whether a socket is involved. The actual problem is exFAT not implementing hardlinks at the FS spec level.

## Findings classified

### Documented limitation — exFAT not a supported filesystem

The file-lock CAS pattern shipped in v1.1.5 ([`packages/findings/lib/file-lock.js`](../packages/findings/lib/file-lock.js), [`packages/ingest/lib/atomic-write.js`](../packages/ingest/lib/atomic-write.js)) is fundamentally incompatible with exFAT because exFAT does not implement `link(2)`. This is a filesystem capability gap, not a code defect.

**Status:** Documented limitation, not a blocker. testing-os was designed against POSIX hardlink semantics (the `writeFileSync(tmp) + linkSync(tmp, lock)` one-syscall publication idiom is well-established and correct). Major filesystems where testing-os is expected to run all support `link(2)`:

| Filesystem | Hardlinks | Status |
|---|---|---|
| APFS (macOS) | yes | **supported** |
| HFS+ (legacy macOS) | yes | supported |
| ext4 (Linux) | yes | supported (CI baseline — ubuntu-latest GHA runner) |
| NTFS (Windows native) | yes | supported |
| **exFAT (cross-platform SSD)** | **no** | **NOT supported** — file-lock errors with `ENOTSUP` |
| FAT32 | no | not supported (same reason) |

**Recommended action:** Add a "Supported filesystems" section to [README.md](../README.md) and [SHIP_GATE.md](../SHIP_GATE.md). Note that the v1.1.5 file-lock implementation requires `link(2)` and explicitly call out exFAT/FAT32 as unsupported. No code changes required.

The error is loud — production code paths that write to a review log on exFAT will throw `ENOTSUP` at the user. A user who hits this and reports it is well-served by clear "exFAT unsupported" docs.

### Wave-X candidate — `package-lock.json` workspace versions stale

`npm install` on this session corrected workspace package versions in [`package-lock.json`](../package-lock.json) from `"version": "1.1.3"` to `"version": "1.1.7"` for `@dogfood-lab/{dogfood-swarm,findings,ingest,portfolio,report,verify,schemas}`. The lockfile had drifted from `package.json` across the v1.1.3 → v1.1.7 bumps because the chore commits that bumped versions never re-ran `npm install`. The change is mechanical and correct (npm would regenerate the same diff on every fresh install on any machine), but the side-effect surfaces in `git status` after every clean install — annoying for CI hygiene and confusing for first-time contributors.

**Status:** Wave-X candidate. Easiest fix is a single `npm install` + commit on the lockfile. Could also be wired into [`scripts/sync-version.mjs`](../scripts/sync-version.mjs) so version bumps automatically refresh the lockfile workspace entries. Reverted in this session to keep the M5 validation commit doc-only.

### Wave-X candidate — `packages/dogfood-swarm/cli.js` mixed line endings

`packages/dogfood-swarm/cli.js` is committed with mixed CRLF + LF line terminators. `git status` shows it as modified on macOS even when no edits have been made because git's CRLF normalization wants to convert it to pure LF on next touch. No behavioral impact; cosmetic git-status noise.

**Status:** Wave-X candidate. One-line fix: re-save the file with LF-only endings (or run `dos2unix`) and commit. Could be enforced repo-wide via `.gitattributes` (`* text=auto`).

### Wave-X candidate — Windows-only invocation paths in operator docs

[CLAUDE.md](../CLAUDE.md) and [HANDOFF.md](../HANDOFF.md) contain hardcoded Windows-style absolute paths in operator-command snippets. **As a snapshot at this document's authoring (2026-04-29) the count was 1 in CLAUDE.md, 10 in HANDOFF.md, 11 total** — that is a historical snapshot, not a current invariant. The authoritative inventory at any later date is the grep itself:

```bash
grep -nE 'F:/AI' CLAUDE.md HANDOFF.md
```

Future audits should rely on the grep, not on the count above — the snapshot is allowed to drift as legacy path snippets are added or pruned, and "count exactly matches the snapshot" is not a soundness condition.

Both files are the legitimate home for that historical context (the `[no-legacy-paths]` doc-drift gate explicitly exempts them as "where historical context belongs"), so the strings themselves aren't a violation. The wave-X surface is that those snippets are non-portable from this side of the M5 transition: on macOS, the Windows drive-letter prefix resolves to nothing, so any contributor copy-pasting them from a Mac shell will hit "no such file."

These are not runtime code — they are operator-shell snippets. None of them block testing-os from running on macOS.

**Status:** Wave-X candidate (post-shipping doc fix). Lowest-friction fix is parameterizing as `${WORKSPACE_ROOT}/AI/...` or a relative `../../shipcheck/bin/shipcheck.mjs` form that resolves from both Windows and macOS working trees. Not in scope for this session.

> **Edit-time meta-finding (this doc).** The first version of this section enumerated each path verbatim in a table. CI failed on `[no-legacy-paths]` because `docs/**` is in the doc-drift gate's path filter (wave-19 Class #11 sweep) and the gate matches on the literal strings regardless of whether they're being used as commands or quoted as evidence. Lesson: when adding a new file to `docs/`, audit what gates fire on that surface *before* committing — the `feedback_edit_time_surroundings_audit` discipline applies to gate boundaries, not just stale-path content. Discovered live in CI run [25092187159](https://github.com/dogfood-lab/testing-os/actions/runs/25092187159) within minutes of the original commit.

### Positive validations

- **Node 25.9.0 forward-compat:** all surfaces that work on the CI Node 20+22 matrix also work on Node 25. No deprecation noise in test output beyond the pre-existing `prebuild-install` and `glob@10.5.0` notices.
- **rename + exclusive-open atomicity:** both work on exFAT. Helpers that use these primitives without `linkSync` are unaffected.
- **dogfood-swarm tests pass on exFAT:** the SQLite control plane uses different atomicity (SQLite's own WAL), not the file-lock CAS — and its 380 tests pass on both filesystems.
- **`npm install` parity:** 13s on APFS vs 14s on exFAT. npm workspaces don't use hardlinks the way pnpm-store does, so the cross-FS hardlink-bloat hazard from the 2026-04-27 reformat incident does not apply here.

## Disposition for v1.1.7 tag

The single material finding (exFAT linkSync ENOTSUP) is a **documented limitation, not a blocker.** The v1.1.7 tag can land. Suggested release-notes phrasing:

> **M5 Max / APFS validated** (Session G, 2026-04-29). 965/965 tests pass on Darwin/APFS. **exFAT not supported** — `link(2)` is required by the file-lock CAS shipped in v1.1.5; testing-os errors visibly with `ENOTSUP` rather than silently degrading. See [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) for the full matrix.

## Logs

- APFS verify: `/tmp/m5-apfs-verify.log`
- exFAT verify: `/tmp/m5-exfat-verify.log`
- exFAT install: `/tmp/m5-exfat-install.log`
- linkSync probe source: `/tmp/linksync-probe.mjs`
