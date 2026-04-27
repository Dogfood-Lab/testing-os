# Dogfood Rollout Doctrine

Reusable rules extracted from rollout across 13 repos and 8 surface types.
These are not guidelines — they are rollout law, proven by real failures.

## Surface truth

**Surface names must match product reality exactly.**
The schema enforces an enum (`cli`, `desktop`, `web`, `api`, `mcp-server`, `npm-package`, `plugin`, `library`). Source repos must declare what they actually are. Do not let repos pick a convenient surface to satisfy policy.

*Proven by:* guardian and crawler were rejected when they used `mcp` instead of `mcp-server`.

## Build output truth

**Scenarios must exercise the built artifact, not source files.**
TypeScript repos compile to `dist/` or `build/`. Scenarios must call the built entrypoint (`dist/cli.js`, `build/index.js`), never `src/cli.ts`. The CI workflow must run the build step before the scenario.

*Proven by:* guardian, crawler, and loadout all failed until workflows were corrected to use built output paths.

## Protocol truth

**MCP servers must be validated as protocol servers, not fake CLIs.**
MCP servers speak JSON-RPC over stdio. The dogfood scenario must exercise the actual protocol — send an `initialize` message, verify the response. Do not pretend an MCP server is a CLI with subcommands.

*Proven by:* repo-crawler-mcp had no CLI crawl command. The honest test was stdio JSON-RPC initialization.

## Runtime truth

**API/service scenarios must account for real port and route discovery.**
- Check the actual port the server listens on (env var, config, or code default)
- Check the actual route prefix (e.g., `/api/health` not `/`)
- Check whether a catch-all middleware intercepts routes you expect to exist

*Proven by:* vocal-synth-engine used port 4321 (not 3000), routes were at `/api/*` (not root), and cockpit catch-all returned 404 for all routes when UI wasn't built.

## Process truth

**Background server processes require single-shell execution.**
GitHub Actions runs each step in a separate shell. A server started with `&` in step 1 is killed before step 2 runs. All scenario steps that depend on a running server must execute in a single `run:` block.

Additionally, use `shell: bash --noprofile --norc {0}` with `set +e` for scenario steps that include expected failures (like curl polling a not-yet-ready server). Default `bash -e` will exit on the first failed curl.

*Proven by:* vocal-synth-engine failed three times before this was identified and fixed.

## Dispatch truth

**Repository dispatch payloads must send JSON objects, not strings.**
`gh api -f "client_payload[submission]=..."` sends the value as a string. Use `jq -n --argjson` with `--input -` to send a proper JSON object. The ingestion entrypoint should also defensively re-parse strings (`typeof === 'string'`).

*Proven by:* shipcheck's first dispatch crashed the verifier because submission arrived as a string, not an object.

## Concurrency truth

**Ingestion must tolerate concurrent writes.**
When multiple repos dispatch simultaneously, the ingestion push can fail because another ingestion committed first. Use `git pull --rebase` with a retry loop (3 attempts) before failing.

*Proven by:* three simultaneous dispatches from guardian, crawler, and loadout caused a push rejection.

## Verdict truth

**Every step that contributes to the scenario must be included in the verdict.**
If the verdict logic omits a step (like `verify-output`), a failed step can produce a passing verdict. The verifier will catch step/verdict inconsistencies and downgrade, but the source workflow should compute the verdict honestly in the first place.

*Proven by:* shipcheck's verdict originally omitted `verify_output` status, allowing a pass with a failed verification step.

## Evidence truth

**Evidence requirements should reflect natural outputs, not forced artifacts.**
If a scenario doesn't naturally produce an artifact, don't require one just to satisfy policy. Forced evidence is worse than no evidence — it teaches repos to manufacture compliance rather than demonstrate reality.

*Proven by:* shipcheck's `artifact` evidence requirement was satisfied by adding a forced evidence step, not a natural output. Relaxed to `log` only after calibration.

## Entrypoint truth

**Scenarios must use the real CLI interface, not assumed flags.**
Every repo has its own argument shape. Positional args, subcommands, flag names — none should be guessed. Read `--help` or the CLI source before writing the scenario. A wrong flag produces exit code 2 (argparse error), which the verifier correctly records as a fail.

*Proven by:* code-batch used `--store` (not a real flag — `init` takes a positional), zip-meta-map used bare `.` (not a real invocation — requires `build` subcommand), voice-soundboard imported `Compiler` (not exported — the function is `compile`).

## Read-after-write timing

**Gate F reads via raw.githubusercontent.com, which has a CDN cache (3–5 minutes).**
After a fresh ingestion, the testing-os index is updated immediately in git. However, Gate F fetches the index via the GitHub raw content CDN, which may serve stale data for up to 5 minutes. This is an operational timing seam, not a product failure.

Operators should expect:
- Fresh ingestion → git shows pass immediately
- Gate F → may show the previous state for 3–5 minutes
- This resolves without intervention; no retry or fix needed

Do not "fix" this by adding cache-busting headers or switching to the GitHub API. The CDN behavior is correct and expected.

*Proven by:* voice-soundboard and zip-meta-map showed "fail" in Gate F for ~3 minutes after their corrected runs were ingested and verified as pass in git.
