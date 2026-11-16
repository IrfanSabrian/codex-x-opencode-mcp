# Usage examples

Three end-to-end runs that use all seven tools. The briefs are abbreviated: real ones
also carry `context`, `current_state`, `known_risks`, and `decision_policy`.

Every `harness_execute` call needs an absolute `workspace_root`. The bridge rejects the
brief before creating a session when it is missing, relative, or not an existing
directory.

## Example 1: refactor behind a stable API, with one correction

**User request:** "Move the query logic into the existing repository layer. Do not touch
the public response shapes."

### 1. Start the task

```json
harness_execute({
  "task": { "task_id": "refactor-repo-layer", "mode": "standard", "requested_by": "codex" },
  "objective": "Route all read queries through the repository layer without changing public API responses.",
  "scope": {
    "in_scope": ["src/repositories", "route handlers that build queries", "repository tests"],
    "out_of_scope": ["response serializers", "authentication", "database engine"]
  },
  "architecture": { "decisions": ["Keep PostgreSQL and the current connection pool"] },
  "constraints": ["No schema change", "Existing endpoints stay backward compatible"],
  "forbidden_changes": ["Public response shapes", "Migration files"],
  "acceptance_criteria": [
    "No handler issues SQL directly",
    "All existing tests pass",
    "Response payloads are byte-identical for the reference fixtures"
  ],
  "validation_requirements": ["npm test", "npm run typecheck"],
  "workspace_root": "<workspace-root>"
})
```

The reply is compact: a `task_id` and a routing trace. It is not a transcript.

### 2. Poll until a result exists

```json
harness_status({ "task_id": "refactor-repo-layer" })
```

Lifecycle values you will see: `queued`, `resolving`, `executing`, `validating`,
`blocked`, `decision_required`, `completed`, `failed`, `cancelled`. Poll at a sane
interval; the bridge does not push.

### 3. Read the contract

```json
harness_result({ "task_id": "refactor-repo-layer" })
```

The contract reports status, summary, changed files, validation results per check,
risks, assumptions, and unresolved issues. Read the validation block first: a `fail`
there means the work is not done no matter how confident the summary sounds.

### 4. Inspect only what you need

```json
harness_inspect({ "task_id": "refactor-repo-layer", "view": "diff" })
```

Available views: `diff`, `changed_files`, `validation`, `artifacts`, `evidence`,
`decision`, `logs`, `provenance`. Ask for one view at a time. Fetching every view
defeats the point of a compact contract.

### 5. Send a correction

Suppose the diff shows one handler still building SQL inline, and the acceptance
criterion is "no handler issues SQL directly".

```json
harness_correct({
  "task_id": "refactor-repo-layer",
  "failed_criteria": ["No handler issues SQL directly"],
  "observed_problem": "src/routes/orders.ts still builds its own SELECT statement",
  "evidence": "diff view, hunk in src/routes/orders.ts lines 88-104",
  "required_correction": "Move that query into the repository and call it from the handler",
  "must_preserve": ["Response shape", "Existing tests"],
  "revalidation_required": ["npm test", "npm run typecheck", "fixture payload comparison"]
})
```

Do not resend the full brief. The task keeps its original objective, scope, and
constraints; a correction adds the delta.

## Example 2: blocked on a decision, then stopped

**User request:** "Add rate limiting to the public API."

The harness reaches a point where two designs are defensible and the choice changes
behavior the user will notice.

### 1. Start

```json
harness_execute({
  "task": { "task_id": "rate-limit-api", "mode": "full", "requested_by": "codex" },
  "objective": "Add rate limiting to public endpoints without breaking existing clients.",
  "constraints": ["No new paid infrastructure", "Existing clients must keep working"],
  "acceptance_criteria": ["Limits enforced per API key", "429 responses include a retry hint"],
  "decision_policy": {
    "opencode_may_decide": ["middleware structure", "test approach"],
    "must_ask_codex": ["limit values per tier", "storage backend", "client-visible behavior change"]
  },
  "workspace_root": "<workspace-root>"
})
```

### 2. Status reports a decision request

```json
harness_status({ "task_id": "rate-limit-api" })
```

```json
{
  "task_id": "rate-limit-api",
  "status": "decision_required",
  "decisions_required": [
    {
      "decision_id": "d-1",
      "question": "Store counters in-process or in Redis?",
      "options": ["in-process (simpler, resets on restart)", "Redis (survives restart, new dependency)"]
    }
  ]
}
```

### 3. Answer it

If the brief or the user's constraints already settle it, answer directly.

```json
harness_decision({
  "task_id": "rate-limit-api",
  "decision_id": "d-1",
  "decision": "In-process counters. A new Redis dependency is out of scope for this change.",
  "rationale": "The brief forbids new infrastructure, and per-instance limits are acceptable for this release."
})
```

If the answer depends on a user preference, ask the user, wait for the reply, and submit
that answer. Do not decide on their behalf. If the user asks a follow-up instead of
choosing, explain the trade-off and keep the decision pending.

### 4. Stop when it is no longer needed

```json
harness_stop({ "task_id": "rate-limit-api", "reason": "Requirement withdrawn by the user" })
```

Stopping aborts the harness session and releases any MCP connections the bridge opened
for the task. The task ends as `cancelled`; it is not silently completed.

## Example 3: tool-heavy task with capability resolution

**User request:** "The checkout page breaks on mobile widths. Find it and fix it."

The work needs a browser, which the brief requests as a capability rather than a package
name.

### 1. Start with a required capability

```json
harness_execute({
  "task": { "task_id": "mobile-checkout", "mode": "specialist", "requested_by": "codex" },
  "objective": "Find and fix the mobile checkout regression.",
  "scope": { "in_scope": ["checkout UI components", "their tests"], "out_of_scope": ["payment provider integration"] },
  "required_capabilities": ["browser-automation"],
  "acceptance_criteria": [
    "Checkout completes at 390px width",
    "Checkout completes at 768px width",
    "Existing tests pass"
  ],
  "validation_requirements": ["npm test"],
  "workspace_root": "<workspace-root>"
})
```

Two outcomes are both normal:

- A provider already installed for `browser-automation` is connected for the task and
  released afterwards.
- No provider exists. The response is `capability_unavailable` with candidates from the
  MCP registry, each marked `unreviewed`, plus an `approval_key`. Codex shows the
  candidate, publisher, version, and the exact command, and waits for approval. Only
  after approval does Codex repeat the call with `approved_mcp_installation_keys`.

Registry metadata is untrusted until reviewed. Approval is per candidate and version; a
stale key is rejected.

### 2. Read the result and the artifacts

```json
harness_result({ "task_id": "mobile-checkout" })
```

```json
harness_inspect({ "task_id": "mobile-checkout", "view": "artifacts" })
```

Screenshots, traces, and reports arrive as artifacts, not as inline base64. Fetch that
view only when you need to look at them.

### 3. Check what actually ran

```json
harness_inspect({ "task_id": "mobile-checkout", "view": "provenance" })
```

Provenance records the route, the agents and models that ran, the tools and MCPs used,
and the validation that executed. Use it to confirm the claimed verification actually
happened before you accept the result.

## Rules of thumb

- One brief per task. Reference later turns by `task_id`, not by re-describing the task.
- Review evidence, not the summary. A summary can hide a missed criterion.
- Correct with specifics: failed criterion, evidence, required change, retests.
- Answer decisions with a reason, so the next correction does not reopen the question.
- Default to compact results and lazy inspection to keep review cost low.
