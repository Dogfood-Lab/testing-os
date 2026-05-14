<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/report

> Submission builder for testing-os — turns swarm/run results into the JSON envelope expected by the verifier.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

Consumer-side packager. Used by source repos to package their dogfood evidence (records, findings) into the JSON envelope that `@dogfood-lab/verify` will accept on the receiver side. Builds the payload that goes into the `repository_dispatch` event when a dogfood run completes.

## Install

```bash
npm install @dogfood-lab/report
```

## Usage

```js
import { buildSubmission } from '@dogfood-lab/report';

const submission = buildSubmission({
  repo: 'org/repo',
  commit: process.env.GITHUB_SHA,
  records: [
    /* dogfood records produced by your swarm/test run */
  ],
  findings: [
    /* findings produced by @dogfood-lab/findings derive */
  ],
});

// submission is now ready for repository_dispatch payload OR direct
// POST to a testing-os ingest endpoint.
```

## What `buildSubmission` does

- Validates incoming records and findings against `@dogfood-lab/schemas` (`dogfood-record.schema.json`, `dogfood-finding.schema.json`) before envelope wrapping.
- Wraps them in the `dogfood-record-submission.schema.json` envelope.
- Generates a stable `submission_id` for correlation across the dispatch → ingest chain.
- Stamps `submitted_at` (ISO-8601 UTC).
- Computes payload-size summary for the size-threshold check on the receiver side.

The caller is responsible for adding GitHub Actions provenance fields (`github_run_id`, `github_workflow_ref`) — those get confirmed by `@dogfood-lab/verify` on the receiver side via the GitHub API. Provenance is the verifier's concern, not the report builder's.

## Error shape

`buildSubmission` throws a structured error when:

- A record or finding fails local schema validation
- Required envelope fields are missing (e.g., `repo`, `commit`)
- Embedded payloads exceed the configured size threshold

Each error carries `code`, `message`, `hint`, and `cause?` per the testing-os structured error contract.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
