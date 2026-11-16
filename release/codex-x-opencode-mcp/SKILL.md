---
name: codex-x-opencode-mcp
description: Delegate coding work from Codex to a multi-harness execution framework over an MCP bridge, where Codex retains intent, scope, and acceptance authority while the selected harness executes. Every harness receives the same vendor-neutral orchestration protocol with ten roles bound to the models that harness provides. Supports OpenCode, Codex CLI, Claude Code, Cursor CLI, Copilot CLI, and Command Code via config; pure mode runs without OMO dependency.
version: 2.1.0
license: MIT
allowed-tools: harness_execute harness_status harness_result harness_inspect harness_correct harness_decision harness_stop
---

# Codex X OpenCode MCP

A local MCP bridge that splits work between two agents. Codex decides what correct
means: objective, scope, architecture, constraints, acceptance criteria. The execution
harness runs against that brief and returns a structured result. Codex then reviews the
evidence and either accepts the work, sends a correction, or answers a blocking
decision.

OpenCode is the default harness. One config file (`harness.config.json`) can route tasks
to Codex CLI, Claude Code, Cursor CLI, Copilot CLI, or Command Code instead, with a
default, fallback order, and per-mode model tiers. In pure mode the bridge needs none of
the OMO/Jev tooling: it picks the harness itself and reports that routing as `unrouted`.

The bridge is local. There is no hosted service, no shared account, and no data
leaving your machine beyond what your chosen harness's model provider already receives.

## When to use

Use this skill when at least one of these is true:

- The request needs sustained execution: a multi-file refactor, a migration, a test
  suite fix, or a feature that touches several modules.
- The work depends on tools Codex should not spend context on: browser automation,
  screenshots, log scraping, repeated test runs, or long research passes.
- You want a second pair of hands with a different model, while keeping Codex as the
  reviewer that decides whether the output is actually correct.
- The task will not finish in one turn and needs state: status polling, lazy diff
  inspection, corrections, or a stop control.

## When NOT to use

- The user has not asked for delegation to the bridge. Do not route work to it on your
  own initiative; it is opt-in per request.
- The task is a single answer, a short explanation, or a one-line edit. Codex is
  faster alone.
- The answer hinges on architecture or product judgment that belongs to Codex. Send a
  brief that already contains those decisions instead of asking the harness to invent
  them.
- The machine is not set up: no harness authentication (OpenCode or the CLI you
  configured), no Node 22+, no bridge install. Fix setup first; a skill cannot make a
  missing MCP server appear.

## Compatibility

`SKILL.md` follows the Agent Skills open standard, so the same package can load in more
than one agent. Confirmed readers are Claude Code, GitHub Copilot, Codex CLI, and
OpenCode. Cursor reads skill files by convention only and does not document Agent Skills
support, so treat Cursor as experimental and verify the load yourself. The MCP half is
client-neutral: any agent that can start a local stdio server with Node can run the
bridge. Per-agent config blocks are in
[`references/setup.md`](references/setup.md).

Execution harnesses are independent of the skill reader. OpenCode 1.18.32 is the
default and the only harness validated end to end on a live provider; the Codex CLI,
Claude Code, Cursor CLI, Copilot CLI, and Command Code adapters are implemented and
covered by automated tests, but each requires that CLI installed and authenticated on
your machine (Codex CLI under Apache-2.0; the others are proprietary and governed by
their vendors' terms). In pure mode no OMO/Jev dependency is required; OMO (SUL-1.0) is
never bundled and stays optional.

## Prerequisites

- Windows 10 or 11. macOS and Linux are not validated.
- Node.js 22 or newer on `PATH`.
- At least one execution harness installed and authenticated: OpenCode 1.18.32 by
  default (`opencode --version`), or one of Codex CLI, Claude Code, Cursor CLI, Copilot
  CLI, or Command Code configured in `harness.config.json`. The bridge starts its own
  managed `opencode serve` process on a loopback port only when OpenCode is the default
  harness or part of the fallback chain, so a deployment routed to a CLI harness needs no
  OpenCode install at all.
- PowerShell 5.1 or newer for the installer.
- A Codex build that supports MCP servers over stdio, or another agent that can launch a
  local stdio server (see Compatibility).

## Setup

Full steps, including the Codex config block and verification commands, are in
[`references/setup.md`](references/setup.md). Per-agent MCP blocks for Claude Code,
Cursor, GitHub Copilot, Codex CLI, and OpenCode are in the same file, under "MCP
configuration per agent". Short version:

1. Clone the repository and run the installer:

   ```powershell
   git clone https://github.com/IrfanSabrian/codex-x-opencode-mcp.git
   cd codex-x-opencode-mcp
   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
   ```

2. Restart Codex and open a new task so the `codex_x_opencode_mcp` tools load.

3. Confirm the connector is present before sending any brief.

## How it works

```text
Codex writes an Execution Brief
  objective, scope, architecture, constraints, acceptance criteria, workspace_root
        |
        v
harness_execute -> compact task_id plus the routing trace
        |
        v
harness_status  -> lifecycle state until the result exists
        |
        v
harness_result  -> compact Result Contract
        |
        v
Codex reviews the result
  pass          -> done
  wrong         -> harness_correct with failed criteria and retests
  ambiguous     -> harness_decision with the answer and its reason
  no longer needed -> harness_stop
```

Two rules matter more than the rest:

1. Every call carries `workspace_root`, an absolute path to the active workspace. The
   bridge validates it and rejects the brief before creating a session when it is
   missing or invalid. It never falls back to another workspace.
2. Large payloads are fetched on demand with `harness_inspect`. Keep the default
   result compact so review stays cheap.

## Orchestration protocol

Every cycle prompt carries the same orchestration protocol, so the way of working does
not change when you switch orchestrator or harness. The roles are deliberately generic:
`orchestrator`, `intake`, `planner`, `plan-reviewer`, `implementer`, `researcher`,
`reviewer`, `tester`, `advisor`, `inspector`. The sequence is intake, plan, one plan
review, bounded delegation, smallest change, real verification, independent diff review,
iterate until green, stop only for an orchestrator decision, and report only evidence.

The pattern is inspired by OMO's orchestration model, but no OMO code is bundled and no
vendor role name is part of the contract. Configure it in `harness.config.json`:

```json
"orchestration": {
  "profile": "orchestrated",
  "max_parallel_agents": 4,
  "role_names": {},
  "role_models": { "implementer": "standard", "tester": "standard" }
}
```

- `profile`: `orchestrated` for the full protocol (default), `minimal` for four rules,
  or `off`.
- `max_parallel_agents`: how many independent assignments may run at once, 1 to 16.
- `role_names`: rename any role to your team's vocabulary, for example
  `{"implementer": "builder"}`.
- `role_models`: pin a role to a tier. Defaults use the strong tier for planner,
  plan-reviewer, and advisor; standard for orchestrator, implementer, reviewer, and
  tester; cheap for intake, researcher, and inspector.

Each role is bound to a model the selected harness actually offers: the tier is resolved
against that harness's own `models` block, so switching harness changes the model ids
without changing the protocol, and a harness without a binding for a tier keeps its own
default model.

A harness that runs a single agent still receives the protocol; it applies the same
sequence itself and says so in the summary.

## Examples

**Refactor with a hard constraint.** The user asks to restructure a data access layer
without changing the public API.

```text
harness_execute
  objective: move query logic behind the existing repository interface
  in_scope: [repository layer, tests for repository layer]
  out_of_scope: [public API response shapes, database engine]
  constraints: [no schema change, existing endpoints stay compatible]
  acceptance_criteria: [all existing tests pass, no public response shape changes]
  validation_requirements: [npm test, npm run typecheck]
  workspace_root: <absolute path to the repo>
```

Then `harness_status` until the contract exists, `harness_result`, and
`harness_inspect` with view `diff` if the summary is not enough to judge.

**Fix a failing test that only reproduces in a browser.** The user asks why checkout
breaks on mobile widths.

```text
harness_execute
  objective: identify and fix the mobile checkout regression
  required_capabilities: [browser-automation]
  acceptance_criteria: [checkout completes at 390px width, existing tests pass]
  workspace_root: <absolute path to the repo>
```

The result contract reports the capability that was used, the changed files, and the
validation outcome. If the fix is wrong, `harness_correct` lists the failed criterion
and the exact retest, without resending the whole brief.

**Blocked on a decision.** The harness returns a decision request about which migration
strategy to use.

```text
harness_decision
  task_id: <task id>
  decision_id: <decision id>
  decision: keep the expand-and-contract pattern; the old column stays until the
            follow-up release
```

If the choice depends on a user preference instead, ask the user, wait for the answer,
and only then submit it. Do not pick on the user's behalf.

## Troubleshooting

Common failures, from missing tools to version mismatches, are covered in
[`references/troubleshooting.md`](references/troubleshooting.md). The most frequent
one: tools do not appear until Codex restarts and a new task starts.

## Limitations

- Windows only. No macOS or Linux support is claimed or validated.
- The OpenCode harness is pinned to 1.18.32 behavior. Newer configuration syntax is not
  assumed.
- Harness CLIs are never bundled or provisioned. Each harness in
  `harness.config.json` must already be installed and authenticated by you; the
  bridge only invokes the configured binary. Cursor CLI and Copilot CLI cannot resume
  a session, so their next cycles replay a compressed transcript instead.
- Command Code blocks file writes and shell commands in headless mode unless its
  configured `permission_mode` allows them (`accept-edits` for edits, `yolo` for full
  autonomy, `dont-ask` for a fail-closed allowlist). The bridge never adds those flags
  on its own.
- The bridge verifies commands it runs itself. Semantic acceptance criteria still need
  Codex review from the diff, artifacts, and evidence.
- MCP connections are leased per server process, so there is no per-agent tool
  isolation. Agent permission boundaries come from your harness configuration.
- A task with no result contract 30 minutes after the cycle starts is marked failed. A
  valid late contract can still recover the status. Accumulated reported cost above
  `max_cost_usd_per_task` fails the task with `budget_exceeded`.
- Dynamic MCP installation is limited to pinned npm packages and requires explicit
  approval per candidate and version.
