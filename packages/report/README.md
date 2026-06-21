<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/report

> Submission builder for testing-os — turns a run's results into the JSON envelope the verifier accepts.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

Consumer-side packager. A source repo calls `buildSubmission` at the end of a dogfood run to package its scenario results into the `dogfood-record-submission` envelope that `@dogfood-lab/verify` validates on the receiver side — the payload that rides in the `repository_dispatch` event.

## Install

```bash
npm install @dogfood-lab/report
```

## Usage

```js
import { buildSubmission, precheckSubmission } from '@dogfood-lab/report';

const submission = buildSubmission({
  repo: 'org/repo',                      // required
  commitSha: process.env.GITHUB_SHA,     // required
  startedAt: runStart,                   // required — ISO datetime
  finishedAt: runEnd,                    // required — ISO datetime
  scenarioResults: [/* scenario result objects */], // required
  overallVerdict: 'pass',                // required — must be a string

  // optional provenance + context the verifier confirms on the receiver side:
  workflow: process.env.GITHUB_WORKFLOW_REF,
  providerRunId: process.env.GITHUB_RUN_ID,
  runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  branch, version, attempt, actor, ciChecks, notes,
});

// submission is ready to ride in the repository_dispatch client_payload.
```

## What `buildSubmission` does

- Assembles the canonical `dogfood-record-submission` envelope from the run's metadata and `scenarioResults`.
- Requires `repo`, `commitSha`, `startedAt`, `finishedAt`, and `scenarioResults`; `overallVerdict` must be a string.
- Carries the provenance fields (`workflow`, `providerRunId`, `runUrl`, …) through unchanged — **provenance is confirmed by `@dogfood-lab/verify` on the receiver side via the GitHub API**, not here. The report builder never calls out.

## Prechecking before dispatch

`precheckSubmission(submission)` runs the *same* `@dogfood-lab/schemas` validation the receiver will run, so a producer can catch a malformed envelope before it spends a `repository_dispatch`:

```js
const { valid, errors } = precheckSubmission(submission);
if (!valid) {
  console.error('submission would be rejected:', errors);
  process.exit(1);
}
```

It returns `{ valid: boolean, errors: string[] }` — the same contract the verifier enforces, so a green precheck means the receiver's schema gate will pass.

## Error shape

`buildSubmission` throws a plain `Error` on a contract violation — a missing required param (`buildSubmission: missing required param "commitSha"`) or a non-string `overallVerdict`. These are programmer errors at the call site, not operator-facing structured rejections; fix the call. (Submission-level validation problems surface as the `errors[]` array from `precheckSubmission`, not as throws.)

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
