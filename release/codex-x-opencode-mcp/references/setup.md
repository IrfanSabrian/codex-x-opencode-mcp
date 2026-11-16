# Setup

The bridge is a local MCP server layered on top of your chosen execution harness (OpenCode by default).
Installation has four parts: build the server, register it with Codex, install the skill
files, then verify. Other agents reuse the same build; their config blocks are in
section 6.

Throughout this document:

- `<user-home>` means your Windows user profile, for example the value of
  `%USERPROFILE%`.
- `<workspace-root>` means the absolute path of the repository you want Codex to work
  in.

## 1. Prerequisites

Check each one before starting. The installer fails in confusing ways when these are
missing.

```powershell
node --version
opencode --version
```

- `node --version` must report 22 or newer.
- `opencode --version` must report 1.18.32.
- Your OpenCode install must already be authenticated and configured with the agents
  and model bindings you plan to use. The bridge does not create accounts, API keys, or
  agent configuration.

## 2. Clone and build

```powershell
git clone https://github.com/IrfanSabrian/codex-x-opencode-mcp.git
cd codex-x-opencode-mcp
```

Build the bridge from source so you can see the code that will run:

```powershell
cd bridge
npm ci
npm run build
cd ..
```

`npm ci` installs the pinned dependency set (`@modelcontextprotocol/sdk`, `zod`, and the
build tooling). `npm run build` emits `bridge\dist\index.js`, which is the MCP server
entry point.

Optional but recommended before installing: run the test suite.

```powershell
cd bridge
npm test
npm run lint
cd ..
```

## 3. Run the installer

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

The script is idempotent and does five things:

1. Copies `bridge\` to `<user-home>\.codex\codex-x-opencode-mcp`, excluding
   `node_modules`, `dist`, state, and logs.
2. Runs `npm ci` and `npm run build` in the installed copy.
3. Installs the skill template to
   `<user-home>\.agents\skills\codex-x-opencode-mcp\SKILL.md`.
4. Seeds `<user-home>\.config\opencode\skills\opencode-skill-discovery\` and its
   `skill-index.json`, only when those files do not already exist.
5. Updates `<user-home>\.codex\config.toml` so the MCP block points at the installed
   build, and writes a backup next to the config.

It resolves your home directory at runtime, so it never hardcodes a username or drive
letter. It never deletes the source clone and never touches unrelated MCP server blocks.

## 4. Configure Codex

The installer writes this block for you. If you configure Codex by hand, or you are
recovering a lost block, the shape is:

```toml
[mcp_servers.codex_x_opencode_mcp]
command = 'C:\Program Files\nodejs\node.exe'
args = ['<user-home>\.codex\codex-x-opencode-mcp\dist\index.js']

[mcp_servers.codex_x_opencode_mcp.env]
OPENCODE_WORKSPACE = '<user-home>\.codex\codex-x-opencode-mcp'
```

Notes on each key:

- `command`: your Node.js executable. Take the path from `(Get-Command node).Source`
  rather than copying the example.
- `args`: the installed build. This is not the source checkout; that is deliberate, so
  the server keeps working if you move or delete the clone.
- `OPENCODE_WORKSPACE`: the durable install directory. Task state lives under
  `.codex-x-opencode-mcp\` inside it. It is not the task workspace; every brief supplies
  its own absolute `workspace_root`.
- `OPENCODE_HUB_JEV_ESTIMATE = '1'` is optional. It enables one live estimate call per
  final task. Leave it out to keep estimates reported as unavailable.

To use an OpenCode server you already run instead of the bridge-managed one, set
`OPENCODE_BASE_URL` in the same env block, plus `OPENCODE_SERVER_USERNAME` and
`OPENCODE_SERVER_PASSWORD` when that server uses Basic auth. Never store passwords in
`config.toml` on a shared machine.

Agents other than Codex CLI register the same server their own way. Those blocks are in
section 6.

## 5. Restart and verify

1. Restart Codex.
2. Open a new task. The MCP tool list loads at task start, not on demand.
3. Confirm the namespace `codex_x_opencode_mcp` and its seven tools are listed. Each tool
   also appears under a deprecated `opencode_*` alias, so a client that lists both forms
   is showing 14 entries for the same seven tools.

Protocol-level check, without touching Codex:

```powershell
cd <workspace-root>
$env:OPENCODE_WORKSPACE = "<user-home>\.codex\codex-x-opencode-mcp"
node "$env:USERPROFILE\.codex\codex-x-opencode-mcp\dist\index.js" --help
```

A successful start prints usage and exits. Errors about a missing workspace or a failed
OpenCode spawn mean the installed copy is present but not configured correctly; see
`troubleshooting.md`.

End-to-end check from Codex: send one small brief that reads a file and returns a result
contract. If `harness_status` reaches a completed state and `harness_result` returns a
contract, the bridge, the managed OpenCode process, and the tool surface all work.

## 6. MCP configuration per agent

### Harness selection

The MCP configuration above decides which agent can call the bridge. A second file,
`harness.config.json`, decides which execution harness actually runs each task.
The bridge resolves it from `BRIDGE_HARNESS_CONFIG`, then `<state-dir>`, then
`<workspace>\bridge\harness.config.json`, then the built-in default (OpenCode primary,
Codex CLI and Claude Code as fallback). The full shape is documented by
`harness.config.schema.json` in the bridge folder:

```json
{
  "version": 1,
  "pure_mode": true,
  "route_receipts_required": false,
  "harness": {
    "default": "opencode",
    "fallback": ["codex-cli", "claude-code"],
    "routing": {
      "by_mode": { "quick": "cheap", "standard": "standard", "full": "strong" },
      "escalate_on": ["validation_failed", "invalid_result_contract"],
      "escalate_to": "strong"
    }
  },
  "limits": { "max_cost_usd_per_task": 5.0 },
  "orchestration": { "profile": "orchestrated", "max_parallel_agents": 4, "role_names": {}, "role_models": {} },
  "harnesses": {
    "opencode": { "enabled": true, "binary": "opencode" },
    "codex-cli": { "enabled": true, "binary": "codex" },
    "claude-code": { "enabled": true, "binary": "claude" },
    "cursor-cli": { "enabled": false, "binary": "agent" },
    "copilot-cli": { "enabled": false, "binary": "copilot" },
    "commandcode": { "enabled": false, "binary": "commandcode", "permission_mode": "accept-edits" }
  }
}
```

How it behaves:

- `harness.default` runs first; a disabled entry or missing binary falls back to the
  next enabled entry in `harness.fallback`.
- OpenCode is started and required only when it is enabled and either the default
  harness or part of `harness.fallback`, or when `OPENCODE_BASE_URL` is set. A
  deployment that routes to a CLI harness never needs an OpenCode install.
- `orchestration` is injected into every cycle prompt on every harness: intake, plan,
  plan review, bounded delegation, smallest change, real verification, independent diff
  review, iterate until green, stop only for an orchestrator decision, report only
  evidence. `profile` accepts `orchestrated`, `minimal`, or `off`;
  `max_parallel_agents` caps concurrent assignments (1 to 16); `role_names` renames any
  role, for example `{ "implementer": "builder" }`; `role_models` pins a role to a model
  tier. Each role is resolved against the selected harness's own `models` block, so the
  harness receives only model ids it offers.
- Command Code runs headless with `-p`; file edits are blocked unless
  `permission_mode` is `accept-edits`, `dont-ask` (allowlist), or `yolo` (full
  autonomy). It reports usage and a session id, so corrections resume the same session.
- `routing.by_mode` maps a task mode to a model tier (`cheap`, `standard`, `strong`),
  resolved against each harness's `models` bindings. `escalate_on` raises the tier to
  `escalate_to` after specific failures. A harness without a binding for a tier runs
  its own default model.
- `limits.max_cost_usd_per_task` is the accumulated reported cost one task may reach;
  passing it fails the task with `budget_exceeded` and blocks further cycles.
- Every task records its harness, so recovery after a restart, status polling,
  corrections, decisions, and stop always use that same harness.
- Harnesses that cannot resume a native session (Cursor CLI, Copilot CLI) receive the
  next cycle as a replay: the prior transcript is compressed into the prompt
  deterministically (last 12 messages, 2000 characters each), and Copilot CLI gets one
  repair turn when its first reply lacks the Result Contract.

Per-harness authentication uses one environment variable each; the bridge never stores
secret values in the config:

| Harness | Auth environment variable |
| --- | --- |
| OpenCode | Your existing OpenCode authentication. |
| Codex CLI | `CODEX_API_KEY` |
| Claude Code | `ANTHROPIC_API_KEY` |
| Cursor CLI | `CURSOR_API_KEY` |
| Copilot CLI | `GITHUB_TOKEN` |
| Command Code | `COMMAND_CODE_API_KEY`, or the OAuth session from `commandcode login` |

### MCP configuration per agent

Codex CLI is what the installer configures, but the bridge is a plain local stdio server
started with `node`, so every MCP-capable agent can run the same build. Register it once
per agent you want to use.

Two paths matter in this section:

- `<install-dir>` is the clone root, the directory that contains `bridge\`.
- The entry point is `bridge\dist\index.js`. It is produced by `npm run build` inside
  `bridge\`, and it must exist before any agent can start the server.

If you ran the Windows installer, a built copy already exists at
`<user-home>\.codex\codex-x-opencode-mcp\dist\index.js`. Point `args` at that file instead
and skip the build.

Backslashes are doubled inside the JSON snippets because JSON treats `\` as an escape
character. Node also accepts forward slashes on Windows, so either separator works as
long as the JSON stays valid.

### Environment each config needs

The server reads `BRIDGE_WORKSPACE` at startup, or the legacy alias
`OPENCODE_WORKSPACE`, and exits when neither is present. It is the durable install
directory where task state lives, not the repository you delegate work in; every brief
still carries its own absolute `workspace_root`. The Windows installer writes the legacy
name, and both names are accepted, so either one works:

- JSON clients: `"env": { "BRIDGE_WORKSPACE": "<install-dir>/bridge" }` inside the
  server object.
- Codex CLI: a `[mcp_servers.codex_x_opencode_mcp.env]` table with a single
  `BRIDGE_WORKSPACE` key.
- OpenCode: `"environment": { "BRIDGE_WORKSPACE": "<install-dir>/bridge" }` inside the
  server object.

### Claude Code

Project scope, `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "codex-x-opencode-mcp": {
      "command": "node",
      "args": ["<install-dir>\\bridge\\dist\\index.js"],
      "env": { "OPENCODE_WORKSPACE": "<install-dir>/bridge" }
    }
  }
}
```

Or register it from the shell, which writes the same entry for you:

```powershell
claude mcp add --transport stdio codex-x-opencode-mcp -- node "<install-dir>/bridge/dist/index.js"
```

Add `--scope user` to make it available outside the current project, and set
`OPENCODE_WORKSPACE` in the environment before launching Claude Code in that case.

### Cursor

Project scope, `.cursor/mcp.json`. Use `~/.cursor/mcp.json` for a global entry. The shape
is the same `mcpServers` object:

```json
{
  "mcpServers": {
    "codex-x-opencode-mcp": {
      "command": "node",
      "args": ["<install-dir>\\bridge\\dist\\index.js"],
      "env": { "OPENCODE_WORKSPACE": "<install-dir>/bridge" }
    }
  }
}
```

Reload the window after editing the file; Cursor starts MCP servers when the workspace
opens.

### GitHub Copilot in VS Code

Workspace scope, `.vscode/mcp.json`. VS Code keys the list as `servers`, sets an explicit
transport `type`, and takes a `tools` allowlist:

```json
{
  "servers": {
    "codex-x-opencode-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<install-dir>\\bridge\\dist\\index.js"],
      "tools": ["*"],
      "env": { "OPENCODE_WORKSPACE": "<install-dir>/bridge" }
    }
  }
}
```

The user-level files, `~/.copilot/mcp-config.json` or a `.mcp.json` at the workspace
root, carry the same server objects under `mcpServers`. Use Copilot Chat in Agent mode,
then confirm the server appears in the tool picker.

### Codex CLI

`~/.codex/config.toml`, which is the block the installer maintains:

```toml
[mcp_servers.codex_x_opencode_mcp]
command = "node"
args = ["<install-dir>/bridge/dist/index.js"]

[mcp_servers.codex_x_opencode_mcp.env]
OPENCODE_WORKSPACE = "<install-dir>/bridge"
```

Use forward slashes in TOML. A double-quoted TOML string interprets `\` as an escape, so
a Windows path written with single backslashes parses as a broken string.

### OpenCode

`opencode.json` or `opencode.jsonc` at the project root, or the same file in
`~/.config/opencode/`:

```json
{
  "mcp": {
    "servers": {
      "codex-x-opencode-mcp": {
        "type": "local",
        "command": ["node", "<install-dir>\\bridge\\dist\\index.js"],
        "environment": { "OPENCODE_WORKSPACE": "<install-dir>/bridge" }
      }
    }
  }
}
```

Restart OpenCode after the edit. The server shows up as a local MCP connection, not as a
plugin.

**Caution:** this skill does not bundle the bridge. The MCP server has to be cloned and
built from <https://github.com/IrfanSabrian/codex-x-opencode-mcp>, and the snippets above
only tell an agent how to launch that local build. Without the clone and a real
`bridge\dist\index.js`, every client fails at startup with a module-not-found error.

## 7. Updating

```powershell
cd codex-x-opencode-mcp
git pull
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Restart Codex afterwards. Task state under the install directory is left untouched.

## 8. Uninstalling

1. Remove the `[mcp_servers.codex_x_opencode_mcp]` block and its `.env` subsection from
   `<user-home>\.codex\config.toml`, or restore the backup the installer wrote.
2. Remove the entry from every other agent config you added in section 6.
3. Delete `<user-home>\.codex\codex-x-opencode-mcp`.
4. Delete `<user-home>\.agents\skills\codex-x-opencode-mcp`.
5. Restart Codex. Other MCP servers and configuration are unaffected.
