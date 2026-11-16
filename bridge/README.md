# Codex ↔ OpenCode bridge

Local MCP bridge for the [PRD](../codex-opencode-execution-hub-prd.md). Codex sends one `Execution Brief`; OpenCode 1.18.32 performs the task; Codex retrieves the `Result Contract`, diff, and evidence to run the quality gate.

`codex_x_opencode_mcp` is the name of the MCP connector registered with Codex. It is not an application with its own interface. When the tools are available in a Codex task, Codex can send a brief through `harness_execute`, poll `harness_status`, then read `harness_result`. If the result needs work, Codex sends `harness_correct` after the previous cycle has finished.

## Current status

| Area | State |
| --- | --- |
| Codex ↔ OpenCode connection, seven MCP tools, task state, Result Contract | Working and tested live |
| Jev intake inside the bridge-managed OpenCode process | The OpenCode hook calls Jev before Sisyphus, sends category/skill/ultrawork, and writes a route receipt per cycle. The hub rejects results without a matching receipt; the `quick` and `specialist/ultrabrain` routes were tested live. |
| Correction, decision, stop, and already-installed MCP connections | Implemented and covered by automated tests; a correction is rejected while an older cycle is still running |
| Independent validation and process recovery | The bridge runs the validation plan, or the available Node scripts, for changed files; a failure withholds the result. An interrupted task is resumed once on the same session. Both were tested live. |
| Jev Decision and Jev Estimate reporting | The bridge shows the original Jev Decision trace when a route is available. After the final result with no pending decisions, the bridge shows one Jev Estimate block with absolute Codex tokens saved and context avoided. |
| Discovery and installation of new MCPs | Registry candidates are marked as not yet reviewed. After explicit approval of a candidate and its exact package version, a pinned npm package can be added to the bridge's OpenCode process and its connection status is verified. |
| Non-npm packages, per-agent profiles and tool permissions, advanced telemetry | Not implemented yet. The token/context report is an initial measurement, not the full Phase 8 metric set. |

OpenCode results still need Codex review against the task criteria. When acceptance criteria are not met, Codex sends `harness_correct` with the failed criteria, evidence, and specific retests, then iterates until done; the correction implementation is never performed inside Codex. Live testing proved the file-read flow, a specialist route with three parallel reviews, and acceptance of a result contract, but not the quality of every kind of work.

### Diagram conformance

| Flow page | Implementation status |
| --- | --- |
| 01, 04, 05: brief → bridge → intake → result | Runs through the seven MCP tools, an OpenCode session, separate status, and the Result Contract. |
| 08, 08A, 09: Jev → Sisyphus/OMO | The Jev hook runs before the OpenCode turn; the `quick` and `specialist/ultrabrain` routes are proven through real sessions. The specialist route launches three parallel OMO reviews. |
| 06, 07: capability hub and dynamic MCP | Available providers can be connected and released. New candidates can be discovered; pinned npm versions can be installed after the exact candidate is approved. Full package audit, non-npm registries, and per-agent profiles are still absent. |
| 11-14: validation, result, quality gate, correction | The bridge runs independent checks after the Result Contract, withholds the result on failure, and stores the evidence. Correction and decision loops are available. Criteria that require judgment remain Codex's call. |
| 18, 19: security boundary and bridge contract | Input is validated, the server is bound to loopback, auth is temporary, and large results are read on demand. Sessions and validation can be recovered after the process stops; per-agent MCP isolation is deferred. |

## Multi-harness

The OpenCode adapter is the default execution harness, but the bridge can drive any of
five agent runtimes through one task interface. Each task records which harness executed
it (`harness_id` in the task state), so recovery, status, corrections, decisions, and
stop always resolve to that same harness and never hand a task to a different CLI.

| Harness | Adapter | License | Notes |
| --- | --- | --- | --- |
| OpenCode | `src/harness/opencode.ts` | MIT | Default. Managed `opencode serve` process, structured output via prompts, Jev gate plugin. |
| Codex CLI | `src/harness/codex-cli.ts` | Apache-2.0 | `codex exec` with schema file, result file, and native session resume. |
| Claude Code | `src/harness/claude-code.ts` | Proprietary; use under the Anthropic terms of service | `claude -p --output-format stream-json`, per-cycle usage, native resume. |
| Cursor CLI | `src/harness/cursor.ts` | Proprietary; use under the Cursor terms of service | `agent -p --output-format json`; no session resume, so the next cycle replays the transcript. |
| Copilot CLI | `src/harness/copilot-cli.ts` | Proprietary; requires a Copilot subscription | `copilot -p "<prompt>"`; no resume, no structured output, one repair turn per cycle. |
| Command Code | `src/harness/commandcode.ts` | Proprietary (npm `command-code`) | `commandcode -p` with `--output-format json` NDJSON, `finalText` + usage, `--resume <sessionId>`. Edits need `permission_mode` (`accept-edits`, `dont-ask`, `yolo`). |

The bridge only invokes the CLIs you already installed and authenticated; it never
installs, updates, or provisions a harness or its credentials.

OpenCode is launched only when it is enabled and either the default harness, part of
`harness.fallback`, or reached through `OPENCODE_BASE_URL`. A deployment routed to a CLI
harness therefore starts with no OpenCode install at all.

### harness.config.json

`bridge/harness.config.json` (validated by `harnessConfigSchema`, documented by
`bridge/harness.config.schema.json`) selects what runs:

- `harness.default` and `harness.fallback`: the ordered harness list. The default runs
  first; a disabled or missing binary falls back to the next enabled entry.
- `harness.routing.by_mode`: maps a task mode to a model tier (`cheap`, `standard`,
  `strong`); `escalate_on`/`escalate_to` raise the tier after specific failures.
- `limits`: per-cycle timeout, first-output timeout, parallel tasks,
  `max_cost_usd_per_task` (the accumulated reported cost of one task; passing it fails
  the task with `budget_exceeded`), stdout cap, and inline prompt cap.
- `harnesses`: per-harness entries with `enabled`, `binary`, model bindings per tier,
  and vendor options (sandbox, permission mode, allowed tools, auth env).
- `orchestration`: the protocol injected into every cycle prompt. `profile` is
  `orchestrated`, `minimal`, or `off`; `max_parallel_agents` caps concurrent assignments;
  `role_names` renames any role; `role_models` pins a role to a model tier, resolved
  against the selected harness's own `models` block.

Auth keys are referenced by environment variable name only: `CODEX_API_KEY`,
`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `GITHUB_TOKEN`. No secret value is ever written
to the config.

### Orchestration protocol

`src/orchestration.ts` renders one protocol block that `Hub.submit` prepends to every
cycle prompt, for resumable and replay harnesses alike. Roles are generic:
`orchestrator`, `intake`, `planner`, `plan-reviewer`, `implementer`, `researcher`,
`reviewer`, `tester`, `advisor`, `inspector`. The sequence is intake, plan, plan review,
bounded delegation, smallest change, real verification, independent diff review, iterate
until green, stop only for an orchestrator decision, report only evidence.

The pattern is inspired by OMO's orchestration model, but the bridge bundles no OMO code
and no vendor role name belongs to the contract. Override `role_names` to match your
team's vocabulary; a single-agent harness runs the same sequence itself and says so in
the summary.

How each harness can act on the roles:

| Harness | Subagent mechanism | Role models |
| --- | --- | --- |
| OpenCode | `task` tool plus configured agents | per-agent `model` |
| Claude Code | Task tool subagents | inherited or per-subagent model |
| Command Code | `agent` tool plus `.commandcode/agents/*.md` | `model` in agent frontmatter |
| Codex CLI | single agent per cycle | task model only |
| Cursor CLI | single agent per cycle | task model only |
| Copilot CLI | single agent per cycle | task model only |

The protocol line names the model per role, so a harness with subagents can bind them
directly, and a single-agent harness keeps the same sequence without inventing agents it
cannot run.

### Pure mode

`pure_mode: true` (the default) makes the OMO/Jev tooling optional. The bridge then
chooses the harness itself, `route_receipts_required` defaults to `false`, and results
carry `routing:unrouted` plus `harness:<id>`, `model:<id|harness-default>`, and
`tier:<tier>` in `provenance` instead of a Jev trace. No token-savings block is
produced. Enabling Jev routing stays possible by installing and configuring OMO/Jev
yourself and setting `route_receipts_required: true`.

### License and bundling note

OMO is licensed SUL-1.0 and is NOT bundled with this bridge. If you want Jev routing and
the OMO orchestration routes, you install and configure OMO yourself; the bridge never
assumes it exists. In pure mode nothing outside the five CLI adapters above is needed.

### Process security

Every harness adapter runs the configured binary through a fixed argv array: no
`shell: true`, no string concatenation into a shell. Each harness inherits only an
explicit per-harness allowlist of environment keys plus the bridge's own variables, so a
harness cannot read unrelated secrets. A running cycle is cancelled by killing the whole
process tree, so child processes spawned by the CLI do not outlive a stop or timeout.

## Implementation details

- Seven tools: `harness_execute`, `harness_status`, `harness_result`, `harness_inspect`, `harness_correct`, `harness_decision`, `harness_stop`.
- Brief, correction, decision, and result contracts are validated with Zod. Status and large results are fetched separately.
- The OpenCode HTTP API is called through loopback only. By default the bridge starts its own `opencode serve` 1.18.32 on a random port with temporary Basic auth. `OPENCODE_BASE_URL` can point at an already-running local server.
- Every prompt uses the `/session/{id}/message` endpoint in a background request. `harness_execute` waits up to 15 seconds for the Jev trace, then returns a receipt together with the trace when it is already available; `harness_status` can deliver a trace that was not ready in time. Status keeps reporting execution until the Result Contract exists.
- In a bridge-managed OpenCode process, the plugin `bridge/plugin/jev-gate.mjs` calls `omoRoute()` from Jev before the message reaches Sisyphus. The bridge stores and returns the `Jev Decision` trace from the Jev formatter without altering its presentation, plus a compact decision for routing. For `quick`, delegation tool calls (`task`/`delegate_task`) are rejected; for the ultrawork route, the instructions request OMO orchestration. A failing Jev stops the turn; a result without route evidence matching the nonce is reported as `jev_route_missing`. Verified routes are added to the Result Contract `provenance`.
- MCP answers carry the Jev Decision trace as a separate text block exactly as formatted by Jev. When `harness_result` returns the final result with no pending decisions, that block is followed by the `token_savings.display` block titled `Jev Estimate`, for example `Codex tokens saved: ~1.2k tokens` and `Context avoided: ~5k tokens`. Jev Estimate is a separate operation from Jev Decision and never changes routing. Values under that title come only from a genuine Jev estimate source; without one the bridge reports `Codex tokens saved: unavailable` / `Context avoided: unavailable` instead of inventing numbers or presenting local arithmetic as Jev output. The estimate runs once per parent task final outcome; intermediate cycles, pending decisions, and active tasks produce no estimate. Genuine values are absolute approximate token counts: tokens saved estimates Codex usage avoided by delegating execution, context avoided estimates task/repository context Codex never had to process. Values are marked approximate; context-window capacity is never presented as savings. These metrics are Codex-side context only; OpenCode and Jev token usage stay separate.
- A genuine source is implemented in `src/jev-estimate-source.ts` (`SystemOneJevEstimator`): it asks the existing Jev SystemOne backend dedicated banded estimate questions (tiny/small/medium/large, mapped to the disclosed representatives 500/3k/12k/40k tokens) with only transcript/payload lengths as grounding, never content. It needs no new MCP/plugin, credential, or backend change, but enabling it adds one live SystemOne call per final task, so it stays OFF by default. Proposed activation, pending explicit user approval: set `codex_x_opencode_mcp_JEV_ESTIMATE=1` in the bridge process environment and restart the bridge. Until then every estimate reports unavailable.
- The Jev plugin is installed only through inline configuration on the bridge-managed OpenCode process. Global plugin configuration, including OMO, is still merged by OpenCode. The `OPENCODE_PURE=1` option is rejected because it disables plugins. A regular OpenCode Desktop process does not use this gate.
- The registry maps the MCPs observed during the audit. The capability manager reads runtime status, connects the installed providers a task needs, and releases the connections it opened once the cycle is finished. Providers that were already connected before the task are left untouched.
- The generic `read_files`/`edit_files` capabilities are OpenCode-native and need no external MCP provider. The capability manager (`src/capabilities.ts`, `src/capability-manager.ts`) resolves them directly through OpenCode built-in tools over the task workspace; no MCP status call, registry lookup, or installation happens for them. The `bridge/config/registry.json` file is only for external MCP providers.
- When a capability is missing, the bridge searches for candidates in the [official MCP Registry](https://registry.modelcontextprotocol.io/docs) and returns metadata marked `unreviewed`. If the registry returns no installable candidate, the `capability_unavailable` response includes `reason: no_registry_candidates`, an explanation, and an actionable `next_action`, without implying an installation path that does not exist. Codex shows the candidate, source, version, and the command that would run. After explicit approval, Codex repeats `harness_execute` with `approved_mcp_installation_keys`; the bridge looks the candidate up again and verifies that the key still matches the approved capability, server, package, and version.
- For candidates with an npm package at a pinned semver version, the bridge builds a restricted `npx --yes <package>@<version>` command and registers it through the OpenCode dynamic MCP endpoint. The bridge checks connection status before starting the task. It never runs arbitrary commands from registry metadata. Other registry packages, floating versions, and secret configuration still need manual handling.
- Approved installations and their configuration are stored without credentials in `.codex-x-opencode-mcp/mcp-installations.json`. A provider is installed only on the bridge-managed headless OpenCode process, not in the Desktop/global OpenCode configuration. Connections opened by the bridge are released after the task; the approved provider configuration remains available for later tasks and can be registered again after a restart.
- Task state stores the session ID, the last cycle request, the validation plan/result, and the recovery count under `.codex-x-opencode-mcp/`; transcripts stay in the OpenCode session. The state directory is git-ignored because briefs can contain sensitive context. Jev evidence, including the original trace, is stored in the `routes/` subdirectory and can be recovered from the session transcript.
- After the Result Contract appears, the bridge runs `validation_plan` when the brief provides one. Each step defines the check type, executable, arguments, relative working directory, and timeout; commands run without a shell and the working directory must stay inside the workspace. Without a plan, when the result reports changed files in a Node project, the bridge runs the `typecheck`, `lint`, `test`, and `build` scripts available in the nearest `package.json`. Unavailable checks are recorded as `not_run`; a failure produces `validation_failed` plus evidence for `harness_correct`.
- When the bridge restarts, stored active tasks are reconciled with their OpenCode sessions. An existing result is reused without resending the task. When there is no result yet and the session is idle, the bridge sends one follow-up request on the same session asking the agent to inspect the work already done. Interrupted validation runs again. Recovery is limited to one automatic attempt per cycle.
- When Jev routing is enabled, the bridge-managed OpenCode process disables the 9router route and uses the configured TypeSafe route. Agent name bindings are left to your own OMO configuration; the bridge never reads or rewrites them.
- The pure skill-discovery helpers in `src/skill-discovery.ts` (`decideSkillSource`, `emptyOrNoMatch`, `reviewSkillCandidate`, `buildIndexEntry`, `findReuse`) and `test/skill-discovery.test.ts` cover general-vs-UI catalog routing, the discovery trigger when Jev returns nothing or no match, the trust-review rules (reject secrets/overrides/destructive behavior/hooks), the index entry shape, and reuse from an existing index.

## Running

Requires Node.js 22 or newer and at least one configured harness: OpenCode 1.18.32 by
default, or one of the CLI harnesses. Inside the `bridge` folder:

```powershell
npm ci
npm run build
$env:BRIDGE_WORKSPACE = '<workspace-root>'
node dist/index.js
```

`stdout` is the MCP protocol channel. Test the server through an MCP client; do not type requests into that terminal. To use an already-running OpenCode server, set `OPENCODE_BASE_URL` and, when the server uses Basic auth, `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` in the process environment. Never store passwords in the Codex config.

The bridge is registered in Codex as `codex_x_opencode_mcp`. Open a new Codex task so the newly registered MCP tool list is loaded.

Run the checks with `npm test`, `npm run lint`, `npm run build`, and `npm audit --audit-level=high`. `node scripts/stdio-smoke.mjs` verifies the handshake and the seven MCP tools. `node scripts/live-smoke.mjs` sends one file-read task to the OpenCode model; `node scripts/interruption-smoke.mjs` stops and restarts the server in the middle of a task. Both can consume tokens from your OpenCode provider.

## Current limits

- MCP candidate discovery reads metadata from the official registry. That metadata stays untrusted and needs review for publisher, license, permissions, credentials, tool list, and filesystem/network impact before approval. The bridge installs only pinned npm packages using arguments it builds itself; other packages stop as a manual proposal.
- For supported candidates, the approval flow, installation into the OpenCode runtime, connection check, lease, and connection release are implemented. Installation applies only to the bridge-managed server; the npm installer still executes the chosen package code once the user approves the candidate and version.
- The OpenCode MCP connection applies to the server process, so a bridge lease gives no per-agent tool isolation. Agent permission boundaries still have to be enforced by the OpenCode/OMO configuration.
- Live testing of the `specialist/ultrabrain` route produced three parallel OMO reviews and a valid Result Contract. That proves one scenario, not the behavior of every `full`, `specialist`, or visual task.
- When `OPENCODE_BASE_URL` points at an external OpenCode server, the server operator must install the hook and provide `codex_x_opencode_mcp_ROUTE_DIR` so the hub can verify Jev evidence. Without that directory, route evidence verification is inactive.
- The workspace is determined by the absolute `workspace_root` in every Execution Brief. The bridge canonicalizes that path, verifies the directory exists, and rejects a brief without a valid workspace before any OpenCode session is created. All session, capability, validation, and recovery operations for that task run in that workspace through the `directory` parameter on each OpenCode 1.18.32 HTTP request. Old task records without a workspace fail closed (`workspace_missing`) and are never redirected to another workspace.
- `OPENCODE_WORKSPACE` at bridge startup only sets the state location (`.codex-x-opencode-mcp/`) and the default scope; it no longer determines the task workspace. Other projects do not need a separate bridge instance as long as each brief carries the correct `workspace_root`.
- Automatic recovery reuses the same session and workspace. The agent is told to inspect state before continuing, but non-idempotent external side effects still need review; after one failed attempt the task asks for a correction. Old MCP leases that exist only in memory are not recovered, which matches the deferred MCP work.
- A task without a Result Contract 30 minutes after the cycle starts is marked failed; a valid contract arriving later can still recover the status. Status no longer fails just because the background agent stayed quiet for 10 seconds.
- The bridge verifies output from the commands it runs itself. Semantic acceptance criteria are still judged by Codex from the result, diff, and evidence. When there is neither a validation plan nor a relevant project script, the bridge reports `not_run` and that is not evidence of passing tests.
- On the tested OpenCode 1.18.32, `prompt_async` sometimes produced no answer, while `format: json_schema` made session message reads fail with HTTP 400. The bridge therefore uses `/message`, requests JSON through the prompt, validates the result with Zod, and normalizes a single description or empty object in list fields when that is safe. Results that still violate the contract are reported as failures.

## Protocol and decision split

`codex_x_opencode_mcp` is a **local MCP server** that exposes seven control tools to Codex. The bridge talks to OpenCode over loopback HTTP. The `jev-gate.mjs` plugin is a separate OpenCode plugin component that runs Jev and stores route evidence. The hub as a whole is therefore not an OpenCode plugin; MCP is the Codex connector, while the Jev plugin is an OpenCode runtime hook.

ACP in the OpenCode documentation means **Agent Client Protocol**. ACP lets an editor or compatible client run OpenCode as a coding agent through the `opencode acp` process. ACP connects an editor to an agent; MCP connects an AI host to a tool server. For this workflow MCP remains the correct path because Codex needs to call the bridge's task/status/result/decision contract. ACP does not replace that contract and does not make Codex the decision holder by itself. This bridge does not use ACP.

Codex sends the objective, scope, architecture decisions, constraints, and acceptance criteria. The harness planner only divides approved work into subtasks and picks an agent for each subtask. If OpenCode needs a decision outside the brief, the bridge returns the question together with the options. Codex answers on its own when the brief is sufficient; when the decision depends on user preference, Codex uses interactive choices with free-text input and waits for the answer before sending `harness_decision`. The wait limit is five minutes from the moment the choices are shown: five full minutes of silence means Codex selects the recommended option that best fits the brief, tells the user about the fallback and its reason, then forwards the choice. Any user message resets the timer. Follow-up questions from the user are answered while the decision stays pending.

Every MCP response that routes through Jev shows the `Jev Decision` block exactly as the receipt formatter produced it. On the final result only, it is followed by the `Jev Estimate` block with `Codex tokens saved` and `Context avoided` lines in absolute tokens. The numbers are computed deterministically by `src/reporting.ts` from characters/4 of the full transcript versus the compact Codex payload; the agent never invents numbers.

The global Codex rules in `<user-home>\.codex\AGENTS.md` make bridge use opt-in per request. By default Codex handles requests directly. The bridge is used only when the user explicitly asks for Codex X OpenCode/OpenCode for that request. If the bridge is unavailable or stale for a delegated task, Codex first tries managed recovery/restart when possible; if it stays blocked, Codex explains the blocker and never silently takes the task over.

## Moving to another machine

It works, but the current configuration is not one-click portable because the Codex MCP entry points at a local path. A new machine needs Node.js 22+, an authenticated OpenCode 1.18.32 configured with the OMO, Jev, agents, and model bindings in use, then the bridge must be installed (`npm ci` and `npm run build`) and registered again in the Codex config with that machine's paths and workspace. Copy the global Codex rules as well so bridge use stays opt-in. Do not copy raw credentials; re-authenticate the providers on the new machine.

The OpenCode configuration observed during the audit contained credentials written inline. Do not copy that file into the workspace or into bridge logs; rotate those credentials on the relevant service side.
