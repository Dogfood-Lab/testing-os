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

Walks the `records/` directory under the testing-os runtime data root, selects the latest record per source repo (by `submitted_at`), and writes an aggregated portfolio summary to `reports/dogfood-portfolio.json`. Downstream consumers — the handbook landing page, the `repo-knowledge` integration — read this aggregated view rather than walking the full `records/` tree.

## Usage — internal

From the monorepo:

```bash
node packages/portfolio/generate.js \
  --records-dir records/ \
  --out reports/dogfood-portfolio.json
```

Or via the workspace `portfolio` bin:

```bash
npm run portfolio --workspace @dogfood-lab/portfolio -- \
  --records-dir records/ \
  --out reports/dogfood-portfolio.json
```

## Why it's not published

`@dogfood-lab/portfolio` is tightly coupled to the testing-os runtime data layout (`records/`, `reports/`, the `latest-by-repo.json` index conventions). External consumers don't have that data layout. Promoting this package to public publishing would first require a data-source-abstraction refactor so callers can supply their own record loader instead of assuming the testing-os filesystem shape.

If a future use-case calls for external consumption, the path is: extract the aggregation algorithm into a pure function, accept an injected loader, then promote. Until then, internal-only.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
