# Troubleshooting

Work through the section that matches the symptom. Each entry gives the cause and the
fix, in the order that resolves it fastest.

## The bridge is not detected by Codex

**Symptom:** no `codex_x_opencode_mcp` namespace, or the seven tools are missing from a
task.

1. Restart Codex, then open a **new task**. The MCP tool list is built at task start; an
   already-open task never picks up a newly registered server.
2. Check that `<user-home>\.codex\config.toml` still contains
   `[mcp_servers.codex_x_opencode_mcp]` and that `args` points at an existing
   `dist\index.js`.
3. Run the server directly to see the real error:

   ```powershell
   $env:OPENCODE_WORKSPACE = "<user-home>\.codex\codex-x-opencode-mcp"
   node "$env:USERPROFILE\.codex\codex-x-opencode-mcp\dist\index.js" --help
   ```

4. Confirm the installed copy exists: `Test-Path "<user-home>\.codex\codex-x-opencode-mcp\dist\index.js"`.
   If it is missing, re-run the installer.

**Symptom:** the tools appear, but the first call fails with `BRIDGE_WORKSPACE is
required`.

The env block lost the variable, usually after a manual config edit. Either name is
accepted (`BRIDGE_WORKSPACE`, or the legacy `OPENCODE_WORKSPACE` the installer writes).
Re-run `scripts\install-windows.ps1`; it rewrites the block idempotently and preserves
unrelated sections.

## Build errors

**Symptom:** `npm ci` or `npm run build` fails, or the installer stops during the build
step.

- Check the Node version first. `node --version` must report 22 or newer. Older runtimes
  fail on the TypeScript build and on modern SDK syntax.
- Delete `bridge\node_modules` and re-run `npm ci`. A partially installed dependency
  tree produces confusing type errors.
- Never hand-edit `bridge\dist\`. It is generated; edit `bridge\src\` and rebuild.
- If the failure mentions the lockfile, use `npm ci` rather than `npm install`, so the
  pinned set is used exactly.
- Corporate proxies break the download step. Set `npm config set proxy` and
  `npm config set https-proxy`, or configure the registry mirror, then retry.

## Port and listener problems

**Symptom:** `EADDRINUSE`, or the bridge cannot start its OpenCode process.

The bridge starts its own `opencode serve` on a random loopback port with temporary Basic
auth, so fixed-port conflicts are rare. When they do happen:

1. Find what holds the port if you set `OPENCODE_BASE_URL` to a fixed value:

   ```powershell
   Get-NetTCPConnection -LocalPort 4096 -ErrorAction SilentlyContinue |
     Select-Object LocalAddress, LocalPort, OwningProcess
   ```

2. Stop the stale process, or point `OPENCODE_BASE_URL` at a server you intend to keep
   running.
3. Check for a leftover managed process after a hard kill of Codex:

   ```powershell
   Get-Process node | Select-Object Id, StartTime, Path
   ```

   Stop only the ones whose path is the installed bridge or OpenCode. Two managed
   servers running at once is harmless; two bridges writing the same state directory is
   not.

**Symptom:** the bridge refuses a non-loopback base URL.

That is intentional. `OPENCODE_BASE_URL` must be a local HTTP address; remote servers are
rejected by design.

## Authentication problems

**Symptom:** HTTP 401 or 403 from OpenCode.

- With the bridge-managed server, auth is generated per start. A 401 usually means
  `OPENCODE_BASE_URL` points at a different server than the credentials in the
  environment, or a stale `OPENCODE_SERVER_PASSWORD` is set.
- With an externally managed server, set all three variables together:
  `OPENCODE_BASE_URL`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`.
- Never put passwords in `config.toml` on a shared machine. Use the process environment
  or a secret store.
- **Symptom:** results are rejected with `jev_route_missing`.

The managed OpenCode process did not produce a routing receipt. This happens when the
routing hook is not loaded, or when an external server was started without
`OPENCODE_HUB_ROUTE_DIR`. Use the bridge-managed runtime, or configure the external
server with that directory so the hub can verify route evidence.

**Symptom:** the OpenCode model provider rejects the request.

The bridge does not manage provider credentials. Re-authenticate OpenCode itself, for
example by running a normal OpenCode session, then retry the task.

## OpenCode version mismatch

**Symptom:** unexpected HTTP 400, missing endpoints, or message reads that fail.

```powershell
opencode --version
```

- The bridge targets **1.18.32**. Verify the exact version rather than a range.
- Newer releases may change configuration syntax or session endpoints. Do not assume V2
  configuration semantics work; treat a version bump as a compatibility change and run
  `npm test` in `bridge\` before relying on it.
- On 1.18.32, a `format: json_schema` request can make session reads fail with HTTP 400.
  The bridge already works around this by requesting JSON through the prompt and
  validating the result. If you see this error, you are running modified bridge code.

## Task-level failures

**Symptom:** `workspace_missing`.

The brief omitted `workspace_root`, sent a relative path, or sent a directory that does
not exist. The bridge fails closed rather than guessing. Fix the brief; do not retry with
a different workspace.

**Symptom:** `validation_failed`.

A check in the validation plan, or an available project script, returned a non-zero exit
code. The result is withheld on purpose. Read the validation evidence, send the failure
back with `harness_correct`, and require the same checks again.

**Symptom:** `capability_unavailable`.

No installed provider satisfies the requested capability. The response includes
candidates marked `unreviewed` and an `approval_key`, or
`reason: no_registry_candidates` when the registry has nothing installable. Review the
candidate, then repeat the call with `approved_mcp_installation_keys`. A key that no
longer matches the candidate, package, or version is rejected.

**Symptom:** a task sits in `executing` far longer than expected.

Tasks with no result contract 30 minutes after the cycle starts are marked failed; a
valid late contract can still recover the status. If a task is genuinely stuck, use
`harness_stop` with a reason rather than leaving it open.

**Symptom:** after a restart, a task resumes unexpectedly.

Recovery is intentional and limited to one attempt per cycle, on the same session and
workspace. The agent is instructed to inspect existing work before continuing. Tasks
with non-idempotent external side effects still need a human check.

## Configuration recovery

The installer writes a backup next to the config before changing it.

```powershell
Get-ChildItem "$env:USERPROFILE\.codex" -Filter "config.toml*"
```

Restore the backup, re-run the installer, and compare the diff. Only the
`[mcp_servers.codex_x_opencode_mcp]` block and its `.env` subsection should ever change.

## Collecting diagnostics

When reporting a problem, include:

- `node --version` and `opencode --version`
- the exact error code from the tool response (`workspace_missing`,
  `jev_route_missing`, `validation_failed`, `capability_unavailable`)
- the output of running `dist\index.js --help` with `OPENCODE_WORKSPACE` set
- whether the bridge was managing its own OpenCode process or using
  `OPENCODE_BASE_URL`

Do not paste credentials, task briefs that contain private context, or full transcripts.
Task state under `.codex-x-opencode-mcp\` can contain sensitive context and should be
scoped down before sharing.
