# codex-x-opencode-mcp skill package

A Codex skill that installs and drives a local MCP bridge between Codex and a
delegated execution harness. Codex keeps architecture authority and final review; the
harness performs execution and returns evidence for that review. OpenCode is the
default harness; Codex CLI, Claude Code, Cursor CLI, and Copilot CLI are selectable
through `harness.config.json`.

## What this package contains

| File | Purpose |
| --- | --- |
| `SKILL.md` | The skill itself: triggers, prerequisites, workflow, examples, limits. |
| `references/setup.md` | Step-by-step installation, Codex configuration, verification. |
| `references/usage-examples.md` | End-to-end walkthroughs for all seven MCP tools. |
| `references/troubleshooting.md` | Failure modes and fixes, from missing tools to version drift. |
| `agents/openai.yaml` | Minimal metadata so Codex CLI can register the skill. |
| `LICENSE` | MIT. |

Installing the skill does not install the bridge by itself. `references/setup.md` walks
through the repository installer, which builds the MCP server, registers it in the Codex
config, and installs the companion skill files.

## What the skill gives Codex

Seven MCP tools, and nothing else:

| Tool | Purpose |
| --- | --- |
| `harness_execute` | Start a task with a complete Execution Brief. |
| `harness_status` | Poll lifecycle state until a result exists. |
| `harness_result` | Read the compact Result Contract. |
| `harness_inspect` | Fetch one view on demand: diff, changed files, validation, artifacts, evidence, decision, logs, provenance. |
| `harness_correct` | Send a correction with failed criteria and retests, on the same task. |
| `harness_decision` | Answer a blocking architecture or risk question. |
| `harness_stop` | Cancel a running task. |

The older `opencode_*` names remain registered as deprecated aliases of the same seven
tools, so existing configs keep working. Harness internals stay behind the bridge. There
are no tools for loading skills, starting sub-agents, or installing MCP packages, so the
orchestrator tool surface stays small and review stays cheap.

## Orchestration protocol

Every cycle prompt, on every harness, carries one vendor-neutral protocol: intake, plan,
plan review, bounded delegation, smallest change, real verification, independent diff
review, iterate until green, stop only for an orchestrator decision, report only
evidence. The roles are generic: `orchestrator`, `intake`, `planner`, `plan-reviewer`,
`implementer`, `researcher`, `reviewer`, `tester`, `advisor`, `inspector`.

Each role is bound to a model tier of the harness that actually runs the task. The bridge
resolves that tier against the harness's own `models` block, so the harness spawns its
subagents on model ids it really offers, and switching harness changes the models
without changing the protocol. Pin a role with `orchestration.role_models`.

The pattern is inspired by OMO's orchestration model, but no OMO code is bundled, no
vendor role name is part of the contract, and every role can be renamed in
`harness.config.json` under `orchestration`. Set `profile` to `orchestrated` (default),
`minimal`, or `off`, and cap parallel assignments with `max_parallel_agents`.

## Quick start

```powershell
git clone https://github.com/IrfanSabrian/codex-x-opencode-mcp.git
cd codex-x-opencode-mcp
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Restart Codex, open a new task, and check that `codex_x_opencode_mcp` tools are listed.
Then follow `references/usage-examples.md` for a first delegated task.

The installer is idempotent. It copies the bridge to
`%USERPROFILE%\.codex\codex-x-opencode-mcp`, builds it, installs the skill files, and
rewrites only the `[mcp_servers.codex_x_opencode_mcp]` block in
`%USERPROFILE%\.codex\config.toml`, keeping a backup next to it.

## Compatibility

Any MCP-capable orchestrator can drive any of the six harnesses, because the bridge speaks MCP over stdio. What differs is how each harness behaves, so the capability matrix below is per harness, not per pair.

| Orchestrator | How it registers the bridge | Status |
| --- | --- | --- |
| Codex CLI | `[mcp_servers.codex_x_opencode_mcp]` in `config.toml` | Validated |
| Claude Code | `claude mcp add --transport stdio codex-x-opencode-mcp -- node "<install-dir>/bridge/dist/index.js"` | Supported |
| Cursor | `.cursor/mcp.json` | Supported |
| GitHub Copilot | `.vscode/mcp.json` | Supported |
| OpenCode | `opencode.json` under `mcp` | Supported |
| Any other MCP client | stdio command pointing at `bridge/dist/index.js` | Supported |

Note that only Codex CLI is marked Validated because the other clients are covered by automated tests and documented config, not by an end-to-end run on every release.

| Harness | Resume | Structured result | Subagents for the ten roles | Usage and cost | Default |
| --- | --- | --- | --- | --- | --- |
| OpenCode | Yes | JSON schema | Yes, via `task` and configured agents | No | Yes |
| Claude Code | Yes | JSON schema | Yes, Task tool subagents | Yes | No |
| Command Code | Yes | None, parsed from `finalText` | Yes, `agent` tool plus `.commandcode/agents/*.md` | Yes | No |
| Codex CLI | Yes | JSON schema file | Single agent per cycle | Yes | No |
| Cursor CLI | No, replays compressed transcript | None, parsed from output | Single agent per cycle | No | No |
| Copilot CLI | No, replays compressed transcript | None, parsed from output | Single agent per cycle | No | No |

Usage means the harness reports token counts and cost. A harness without it still runs every
task, but the per-task cost cap cannot measure what that task spent.

Each role in the orchestration protocol is bound to a model tier that the selected harness actually offers, so switching harness changes the model ids without changing the protocol; a single-agent harness runs the same ten-role sequence itself and reports it in its summary.

## Requirements

| Requirement | Notes |
| --- | --- |
| Windows 10 or 11 | Validated on Windows 11. |
| Node.js 22+ | The bridge targets Node 22 and is tested on newer LTS builds. |
| One execution harness | OpenCode 1.18.32 is the default target. Codex CLI, Claude Code, Cursor CLI, Copilot CLI, and Command Code are supported through `harness.config.json`. A deployment routed to a CLI harness does not need OpenCode installed. |
| Harness authentication | Each harness CLI must be installed and authenticated by you, the buyer. The bridge never bundles, installs, or provisions a harness or its credentials; it only invokes the binary you configure. Auth keys are referenced by environment variable (`CODEX_API_KEY`, `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `GITHUB_TOKEN`, `COMMAND_CODE_API_KEY`). |
| PowerShell 5.1+ | Needed by the installer. |

OMO and Jev are optional. The package ships in pure mode: the bridge picks the harness
itself and reports routing as `unrouted`, with no OMO/Jev dependency. OMO is licensed
SUL-1.0 and is not bundled; install and configure it yourself only if you want Jev
routing.

## Repository

Source, issues, and updates: <https://github.com/IrfanSabrian/codex-x-opencode-mcp>

The repository also contains the architecture document, the bridge source, and the
internal skill templates the installer uses.

## Cost notes

The bridge itself needs no paid service. Everything runs locally over stdio and
loopback HTTP. Two things can consume third-party quota: the OpenCode model provider
your tasks run against, and the optional live smoke tests that send one real task
through that provider.

## License

MIT. See `LICENSE`.

Copyright (c) 2026 Irfan.
