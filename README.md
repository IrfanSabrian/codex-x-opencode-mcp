# codex-x-opencode-mcp

Local MCP bridge that makes **Codex** the executive reasoning layer and **OpenCode** the execution hub.

Codex decides what *correct* means (objective, scope, architecture, constraints, acceptance criteria) and sends one structured **Execution Brief** through the bridge. OpenCode executes it — routed by **Jev**, orchestrated by **OMO** when needed — and returns a compact **Result Contract**. Codex verifies the actual result and either passes, corrects, or decides.

## What it does

- Exposes exactly 7 MCP tools to Codex under the `codex_x_opencode_mcp` namespace:
  `opencode_execute`, `opencode_status`, `opencode_result`, `opencode_inspect`,
  `opencode_correct`, `opencode_decision`, `opencode_stop`.
- Carries an Execution Brief (task + scope + architecture + acceptance criteria) to an
  OpenCode runtime over localhost HTTP, then returns status and a Result Contract.
- Runs a Jev routing gate inside the managed OpenCode process before every agent turn
  and stores the `Jev Decision` receipt; results without a matching receipt are rejected.
- After the final result, shows one `Jev Estimate` block (absolute Codex tokens saved /
  context avoided) from a genuine estimate source, or `unavailable` when none exists.
- Supports correction and decision loops: Codex sends the delta, OpenCode resumes.
- Can discover missing capability candidates from the official MCP registry; npm packages
  with pinned versions install only after your explicit approval, disabled-first with a
  connection health-check.
- Runs independent validation after the Result Contract (explicit `validation_plan`, or
  the nearest Node `typecheck`/`lint`/`test`/`build` scripts) and withholds results that fail.

See [`bridge/README.md`](bridge/README.md) for the full implementation status and
[`codex-opencode-execution-hub-prd.md`](codex-opencode-execution-hub-prd.md) for the architecture spec.

## Architecture and real workflow

```text
User
  ↓
Codex (decides scope, architecture, acceptance criteria)
  ↓ Execution Brief
codex_x_opencode_mcp bridge (local MCP over stdio, 7 tools)
  ↓ localhost HTTP
OpenCode runtime (managed `opencode serve` on a random port with temp auth)
  ↓ Jev gate plugin (routes BEFORE the agent turn, writes receipt)
Sisyphus / OMO / specialist agents (each uses its own configured model binding)
  ↓ validation + artifacts + Result Contract
Codex quality gate
  ├── PASS → done
  ├── CORRECTION → opencode_correct → OpenCode executes again
  └── DECISION → opencode_decision → OpenCode resumes
```

Key facts:

- There is **no separate worker-model pool**. Sisyphus, Prometheus, Momus, Oracle,
  Explore, Librarian, and other agents are configured agents; each already has its own
  model binding in the OpenCode/OMO configuration.
- `jev-gate` is an **OpenCode plugin hook**, not the hub. The hub is the MCP server.
  ACP (Agent Client Protocol) is **not** used here.
- Every `opencode_execute` call must include an absolute `workspace_root`. The bridge
  canonicalizes it and rejects the brief before creating a session when it is missing
  or invalid. The bridge never falls back to another workspace.
- After a Codex restart, open a **new Codex task** so the freshly registered
  `codex_x_opencode_mcp` tools load.

## Requirements

| Requirement | Notes |
|---|---|
| Windows 10/11 | Validated on Windows 11. macOS/Linux are **not** validated — no install steps are claimed for them. |
| Node.js 22+ | Validated with Node v24. `node --version` must report 22 or newer. |
| OpenCode 1.18.32 | The implementation target. Verify with `opencode --version`. The managed runtime is started automatically by the bridge. |
| OpenCode authentication + OMO/Jev/agent configuration | The bridge does not provision these. Your OpenCode setup must already be authenticated and configured with OMO, Jev, agents, and model bindings (see [`codex-handoff-prompt.md`](codex-handoff-prompt.md) for the expected shape). |
| GitHub CLI (`gh`), optional | Only needed if you want to publish a fork. Authenticate with `gh auth login`. |
| PowerShell 5.1+ | For `scripts/install-windows.ps1`. |

### Cost / third-party notes (only what the code actually uses)

- No paid service is required by the bridge itself. Everything runs locally
  (MCP over stdio + OpenCode over localhost HTTP).
- `npm ci` downloads public npm packages (`@modelcontextprotocol/sdk`, `zod`, plus
  dev tools for the build). No purchase involved.
- Live smoke tests (`live-smoke.mjs`, `interruption-smoke.mjs`) send one real task to
  your configured OpenCode model provider, which may consume that provider's tokens.
- The optional Jev Estimate source (`OPENCODE_HUB_JEV_ESTIMATE=1`) adds one live Jev
  SystemOne call per final task. It stays **off** by default.
- Dynamic MCP discovery reads metadata from the official MCP registry
  (`https://registry.modelcontextprotocol.io/docs`). Registry metadata is untrusted
  until you review publisher, license, permissions, credentials, tools, and
  filesystem/network impact. Only pinned-version npm packages can auto-install, and
  only after your explicit approval.

## Installation (Windows)

1. Clone the repository and enter it:

   ```powershell
   git clone https://github.com/<you>/codex-x-opencode-mcp.git
   cd codex-x-opencode-mcp
   ```

2. Run the idempotent installer (re-running is safe; it never deletes this repo and
   never touches unrelated MCP servers):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
   ```

   What it does:
   - Copies `bridge/` to `%USERPROFILE%\.codex\codex-x-opencode-mcp`
     (excluding `node_modules`, `dist`, state, and logs).
   - Runs `npm ci` + `npm run build` there (requires Node.js 22+ on `PATH`).
   - Installs the skill template to `%USERPROFILE%\.agents\skills\codex-x-opencode-mcp\SKILL.md`.
   - Updates `%USERPROFILE%\.codex\config.toml` so `[mcp_servers.codex_x_opencode_mcp]`
     points at the installed `dist\index.js` and sets `OPENCODE_WORKSPACE` to the
     installed directory (preserving `OPENCODE_HUB_JEV_ESTIMATE` and every unrelated
     section). A backup is written next to the config.
   - The installer resolves your home directory at runtime — it never hardcodes a
     username or drive letter.

3. **Restart Codex**, then open a **new task** so the `codex_x_opencode_mcp` tools load.
   Verify the namespace is present before sending any brief.

4. Confirm the installed runtime no longer depends on the source checkout by deleting
   or renaming the clone later — the MCP server must keep working. (The clone remains
   the source of truth for updates; see below.)

## Configuration

Only one Codex-side block matters:

```toml
[mcp_servers.codex_x_opencode_mcp]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\<you>\.codex\codex-x-opencode-mcp\dist\index.js']

[mcp_servers.codex_x_opencode_mcp.env]
OPENCODE_WORKSPACE = 'C:\Users\<you>\.codex\codex-x-opencode-mcp'
OPENCODE_HUB_JEV_ESTIMATE = '1'
```

- `command` is your Node.js executable (detected from `PATH` at install time).
- `OPENCODE_WORKSPACE` is the durable install directory (task state lives under
  `.codex-x-opencode-mcp/` inside it). Per-task workspaces still come from each
  brief's `workspace_root`.
- `OPENCODE_HUB_JEV_ESTIMATE=1` enables the genuine Jev Estimate call. Remove it or
  set `0` to go back to `unavailable` estimates.
- To point at an externally managed OpenCode server instead, set `OPENCODE_BASE_URL`
  (plus `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` when it uses Basic auth)
  in the bridge process environment. Never store passwords in `config.toml`.

The global routing skill lives at
`%USERPROFILE%\.agents\skills\codex-x-opencode-mcp\SKILL.md` and is installed from
[`skill/codex-x-opencode-mcp/SKILL.md`](skill/codex-x-opencode-mcp/SKILL.md).
Do not copy anyone's personal `AGENTS.md`, credentials, logs, or sessions.

## Quick verification

From any directory **outside** the repository (proves workspace independence):

```powershell
cd $env:USERPROFILE
$env:OPENCODE_WORKSPACE = "$env:USERPROFILE\.codex\codex-x-opencode-mcp"
node "$env:USERPROFILE\.codex\codex-x-opencode-mcp\dist\index.js" --help 2>&1 | Select-Object -First 5
```

Then run the project checks from the repository clone:

```powershell
cd bridge
npm test            # full bridge test suite (83 tests)
npm run build       # TypeScript build
node scripts/stdio-smoke.mjs   # MCP handshake + exactly 7 tools
```

`live-smoke.mjs` additionally sends one real file-read task through your OpenCode
provider (may use provider tokens).

## Usage

In Codex, every actionable task — including small ones — goes through the bridge:

1. Codex writes an Execution Brief (objective, scope, architecture, constraints,
   acceptance criteria, `workspace_root` = the active workspace's absolute path).
2. Codex calls `opencode_execute`. The reply is a compact `task_id` plus the
   `Jev Decision` trace, shown verbatim.
3. Codex polls `opencode_status` and reads `opencode_result` (compact Result Contract).
   Large diffs/evidence/logs are fetched lazily with `opencode_inspect`.
4. Codex verifies the result against the acceptance criteria:
   - pass → done (the final result carries one `Jev Estimate` block);
   - fail → `opencode_correct` with failed criteria, evidence, and retests;
   - ambiguity → answer via `opencode_decision` (user preference goes through
     Codex's interactive choices; 5-minute silence falls back to the recommended option).
5. `opencode_stop` cancels a running task.

Pure conversation and explanations stay in Codex. If the bridge is unavailable, Codex
must say so instead of silently doing the work itself.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `codex_x_opencode_mcp` tools missing in Codex | Restart Codex and open a **new task**. The tool list loads at session start. |
| `OPENCODE_WORKSPACE is required` | The MCP env block lost `OPENCODE_WORKSPACE`. Re-run the installer. |
| `workspace_missing` rejection | The brief omitted `workspace_root` or it is not an existing absolute directory. Fix the brief — the bridge fails closed by design. |
| `jev_route_missing` | The managed OpenCode process did not produce a Jev receipt (hook misconfigured or external server without `OPENCODE_HUB_ROUTE_DIR`). Check the bridge-managed runtime first. |
| Tests fail after `npm ci` | Ensure Node.js 22+ (`node --version`) and re-run `npm run build`. Do not hand-edit `dist/`. |
| Config broken after install | Restore the backup next to `config.toml` (`config.toml.bak-codex-x-opencode-mcp`), then re-run the installer and report the diff. |
| Old workspace path still referenced | Search the config for the old drive path; only `[mcp_servers.codex_x_opencode_mcp]` should have changed. Re-run the installer — it rewrites that block idempotently. |

## Update

```powershell
cd codex-x-opencode-mcp
git pull
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Then restart Codex. Your task state under `.codex-x-opencode-mcp/` in the install
directory is left untouched.

## Uninstall

1. Remove the MCP block `[mcp_servers.codex_x_opencode_mcp]` (and its `.env`
   subsection) from `%USERPROFILE%\.codex\config.toml`.
2. Delete `%USERPROFILE%\.codex\codex-x-opencode-mcp`.
3. Delete `%USERPROFILE%\.agents\skills\codex-x-opencode-mcp`.
4. Restart Codex. Other MCP servers and configuration are unaffected.

## Limitations (accurate as of this release)

- Windows only. No macOS/Linux support is claimed or validated.
- Pinned to OpenCode 1.18.32 behavior; newer OpenCode V2 config syntax must not be
  assumed.
- The `specialist/ultrabrain` path is proven by one live scenario (three parallel OMO
  reviews + a valid Result Contract), not by exhaustive coverage of every task shape.
- MCP connection leases apply per server process — there is no per-agent tool
  isolation in the bridge; agent permission boundaries must come from OpenCode/OMO config.
- Tasks without a Result Contract 30 minutes after the cycle starts are marked failed
  (a late valid contract can still recover the status).
- The bridge verifies command output it runs itself; semantic acceptance criteria are
  always judged by Codex from diffs, artifacts, tests, and evidence.
- The active MCP server process keeps using its in-memory paths until Codex restarts;
  config changes take effect on the next startup.
