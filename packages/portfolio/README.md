<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/portfolio

> Cross-repo portfolio generator for testing-os. Aggregates the latest record per repo into `reports/dogfood-portfolio.json`.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

**Status:** internal workspace package. Not currently published to npm (`private: true`). Used by the testing-os monorepo's CI to generate the cross-repo portfolio view that downstream tools (the `dogfood-lab.github.io/testing-os/` handbook landing page, `repo-knowledge` integrations) render.

## What it does

Reads `indexes/latest-by-repo.json` + `policies/repos/` and writes an aggregated portfolio summary to `reports/dogfood-portfolio.json`. Downstream consumers — the handbook landing page, the `repo-knowledge` integration — read this aggregated view rather than walking the full `records/` tree.

Alongside the report it also emits two **git-ignored runtime artifacts** (`indexes/trends.json` + `indexes/badges/`). They are regenerated on every run and are never committed — the committed deliverable is the generator code, not a snapshot.

### Trend / regression surface (`trends`)

`reports/dogfood-portfolio.json` carries a `trends` key, and the same data is also written standalone to `indexes/trends.json`. While the report's `repos`/`stale`/`missing` arrays describe only the *latest* run per repo+surface (from `latest-by-repo.json`), the trend surface scans the full dated `records/<org>/<repo>/YYYY/MM/DD/run-*.json` history directly. Per repo → product surface it computes:

| field | meaning |
|-------|---------|
| `history` | ordered `{ run_id, verified, finished_at }`, oldest → newest (sorted by `Date.parse(finished_at)`, not ISO string compare) |
| `current` / `previous` | the two newest **accepted** verdicts (`_rejected/` records are excluded) |
| `regressed` | `true` when the surface went `pass` → `fail` |
| `recovered` | `true` when the surface went `fail` → `pass` |
| `pass_rate` | fraction of passing runs inside a rolling window (default 30 days), with `pass_rate_sample` and `pass_rate_window_days` |
| `latest_path` | repo-root-relative path of the newest accepted run (forward-slash, even on Windows) |

The reusable engine is `lib/compute-trends.js#computeTrends(repoRoot, { windowDays, now })`.

### Status badges (shields.io endpoints)

Each repo+surface gets a [shields.io endpoint](https://shields.io/badges/endpoint-badge) JSON written to `indexes/badges/<org>--<repo>--<surface>.json`:

```json
{ "schemaVersion": 1, "label": "dogfood", "message": "pass", "color": "brightgreen" }
```

`message`/`color` are `pass`/`brightgreen`, `fail`/`red`, or `stale`/`orange`. A passing-but-old run (latest `finished_at` beyond the staleness window, default 30 days) or an unparseable timestamp reports `stale`; a `fail` always reports `fail` regardless of age. A repo README renders a live pill by embedding `https://img.shields.io/endpoint?url=<raw url to the badge file>`. The reusable engine is `lib/generate-badges.js#generateBadges(index, { windowDays, now })`.

> **Serving note:** the badge files are git-ignored, so they are not yet reachable at a stable raw URL. Publishing them via CI (parallel to how `reports/dogfood-portfolio.json` is served) is a deferred follow-up.

## Usage — internal

From the monorepo:

```bash
node packages/portfolio/generate.js                       # default report + trends + badges
node packages/portfolio/generate.js --output /tmp/p.json  # custom report path
node packages/portfolio/generate.js --no-trends           # skip indexes/trends.json (trends still in report)
node packages/portfolio/generate.js --no-badges           # skip indexes/badges/
node packages/portfolio/generate.js --help                # full flag reference
```

Or via the workspace `portfolio` bin:

```bash
npm run portfolio --workspace @dogfood-lab/portfolio
```

## Why it's not published

`@dogfood-lab/portfolio` is tightly coupled to the testing-os runtime data layout (`records/`, `reports/`, the `latest-by-repo.json` index conventions). External consumers don't have that data layout. Promoting this package to public publishing would first require a data-source-abstraction refactor so callers can supply their own record loader instead of assuming the testing-os filesystem shape.

If a future use-case calls for external consumption, the path is: extract the aggregation algorithm into a pure function, accept an injected loader, then promote. Until then, internal-only.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
