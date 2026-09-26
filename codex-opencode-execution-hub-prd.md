# Codex ↔ OpenCode Execution Hub

## PRD / Architecture Handoff v0.2

**Status:** Revised architecture / implementation-ready specification

**Primary goal:** Make Codex the executive/lead reasoning layer and OpenCode the execution hub, while preserving Codex-level quality through a closed verification loop.

**Current OpenCode:** 1.18.32

**Bridge target stack:** TypeScript + Node.js 22 + official MCP TypeScript SDK + local `stdio` MCP server + OpenCode HTTP server/client boundary.

**Design principle:** Codex owns intent, architecture decisions, decision rationale, scope, constraints, acceptance criteria, and final quality judgment. OpenCode owns execution, capability management, agent routing, MCP orchestration, validation, artifacts, and task lifecycle.

> **Important correction:** There is no separate "worker-model pool" layer. Sisyphus, Prometheus, Atlas, Hephaestus, Oracle, Explore, Librarian, Reviewer, and other agents are configured agents; each agent already has its own model binding in the OpenCode/OMO configuration.

---

## 1. Executive Summary

The system should not attempt to make OpenCode replace Codex as the architectural brain. Instead, it should treat OpenCode as Codex's right hand:

```text
User
  ↓
Codex
  ↓
Execution Brief
  ↓
OpenCode MCP Bridge
  ↓
OpenCode Execution Hub
  ↓
Jev Decision Maker
  ↓
Sisyphus / OMO / specialist agents
  ↓
Agent-bound models + task-scoped MCPs
  ↓
Validation / artifacts / Result Contract
  ↓
Codex Quality Gate
  ├── PASS → finish
  ├── CORRECTION → Correction Brief → OpenCode
  └── DECISION → OpenCode asks Codex → decision → OpenCode
```

The **main loop** is intentionally closed:

```text
CODEX
  ↓ Execution Brief
OpenCode
  ↓ execute + validate
Result Contract
  ↓
CODEX QUALITY GATE
  ├── PASS → DONE
  ├── CORRECTION → OpenCode → execute again
  └── DECISION → Codex decides → OpenCode resumes
```

### 1.1 Dynamic MCP acquisition

The system should also support **dynamic MCP acquisition**. If a required capability is missing, OpenCode can discover and prepare a suitable MCP, while preserving a strict separation between installation and activation:

```text
capability request
  ↓
registry lookup
  ↓
installed?
 ├─ YES → validate → enable for task
 └─ NO  → discover → evaluate → install disabled
                                ↓
                             health-check
                                ↓
                              enable
                                ↓
                           use + validate
                                ↓
                             disable
                                ↓
                         keep installed cache
```

OpenCode therefore becomes a **capability hub**, not merely a coding agent.

### 1.2 Example

```text
User: "Refactor this database migration."

Codex:
  reasons about architecture, scope, risks, and acceptance.
  decides a DB-aware capability would materially reduce ambiguity.

Codex → OpenCode:
  required_capabilities = ["database-schema-inspection", "migration-validation"]

OpenCode:
  checks capability registry
  ↓
  missing capability
  ↓
  discover candidate MCP
  ↓
  evaluate source / permissions / risk / compatibility
  ↓
  install disabled
  ↓
  health-check
  ↓
  enable for task
  ↓
  Jev routes execution
  ↓
  agent executes with relevant MCP
  ↓
  validate
  ↓
  disable
  ↓
  return compact Result Contract

Codex:
  inspects diff / evidence / validation
  ↓
  PASS or Correction / Decision
```

---

## 2. Problem Statement

Current architecture risks two opposite failures:

### Failure A: Codex does everything

Codex spends expensive reasoning/context on mechanical execution, repeated file inspection, tool calls, testing, browser interaction, CAD interaction, research retrieval, and other operational work.

### Failure B: OpenCode does everything independently

OpenCode may make architectural decisions that should have been made by Codex. Quality can drift because the executor is forced to guess intent.

### Target

Create a closed-loop executive/executor architecture where:

- Codex makes high-value decisions.
- Codex sends a structured decision context, not raw chain-of-thought.
- OpenCode executes those decisions.
- Jev cheaply routes each task.
- OMO provides multi-agent orchestration when required.
- Agents use their already-configured model bindings.
- Specialist MCPs provide domain capabilities.
- Codex verifies the actual result.
- Failed verification creates an explicit correction cycle.
- Architectural ambiguity creates an explicit decision cycle.

---

## 3. Core Responsibility Split

| Layer | Responsibility | Authority |
|---|---|---|
| User | Intent, desired outcome, personally important constraints | Highest human authority |
| Codex | Architecture, strategic reasoning, scope, decision rationale, execution contract, acceptance criteria, final verification | Final technical authority |
| OpenCode | Execution runtime, capability management, file changes, tool calls, testing, artifacts, task lifecycle | Execution authority |
| Jev | Complexity / skill / visual / ultrawork routing | Routing authority only |
| OMO | Multi-agent decomposition and coordination | Execution orchestration |
| Agents | Scoped reasoning, implementation, research, inspection, review | Scoped execution |
| Agent model binding | Model configured for each agent | Agent configuration |
| MCP layer | External/local capabilities and integrations | Tool capability only |

Important rules:

1. **There is no separate worker-model layer.** Models are properties of configured agents.
2. Agents and OpenCode may propose architecture changes, but Codex remains final authority for architecture unless the user explicitly delegates that authority.
3. Codex should not choose individual agents or individual MCP packages unless a special case requires it. Codex should express required capabilities and constraints.
4. Every actionable user task, including quick tasks, enters OpenCode through the bridge. Pure conversation and explanations can remain in Codex.
5. The OpenCode planning agent may plan only the division of Codex-approved work among configured agents. It cannot change the user's objective, the Codex-approved scope, architecture, requirements, constraints, or acceptance criteria.
6. If execution needs a decision outside the brief, OpenCode returns a structured question and options. If Codex can resolve it from the brief, Codex explains its answer briefly and resumes through `opencode_decision`. If the answer depends on user preference, Codex presents interactive choices plus free-text input and waits for the user's reply before resuming.

---

## 4. Codex Reasoning → Execution Brief

The bridge must **not** depend on transferring Codex hidden reasoning or full conversation history.

Codex should reason internally, then distill the relevant result into **decision context** for the executor.

### 4.1 Codex reasoning stages

```text
1. Understand intent
2. Gather relevant context
3. Identify actual problem
4. Decide architecture / approach
5. Define scope
6. Record important decision rationale
7. Define constraints + forbidden changes
8. Define required capabilities
9. Define acceptance + validation
10. Define what OpenCode may decide vs must return to Codex

OUTPUT: Execution Brief
```

### 4.2 Detail principle

> **Detail means reducing executor interpretation space, not sending more prose.**

Good detail:

```text
schema tidak boleh diubah;
endpoint existing harus tetap kompatibel;
benchmark before/after wajib;
gunakan repository layer existing.
```

Bad detail:

```text
buat yang bagus, aman, scalable.
```

The first specifies boundaries and verifiable expectations. The second forces OpenCode to guess what "good" means.

---

## 5. Execution Brief Contract

Recommended canonical structure:

```yaml
EXECUTION_BRIEF:
  task:
    task_id: string
    parent_task_id: string|null
    mode: quick|standard|full|specialist|research|tool-heavy
    requested_by: string

  objective: string

  scope:
    in_scope: []
    out_of_scope: []

  context: string

  current_state: string

  architecture:
    decisions: []
    rationale: []

  decisions_already_made: []
  decision_rationale: []

  requirements: []
  constraints: []
  forbidden_changes: []

  required_capabilities: []

  execution_hints: []

  acceptance_criteria: []
  validation_requirements: []

  expected_artifacts: []

  known_risks: []
  open_questions: []

  decision_policy:
    opencode_may_decide: []
    must_ask_codex: []

  optional_context:
    relevant_files: []
    reference_implementations: []
    performance_targets: []
    security_requirements: []
    rollback_strategy: string|null
    research_evidence_requirements: []

  workspace_root: string
```

### 5.1 Why `decision_rationale` exists

Codex should not send raw reasoning. However, an executor can need the **reason a consequential decision is fixed**.

Example:

```text
DECISION
Keep PostgreSQL + PostGIS.

RATIONALE
The existing dataset and spatial API already depend on PostGIS;
changing the database engine is outside task scope.
```

That is decision context, not raw chain-of-thought.

### 5.2 Why `scope` exists

Large agents tend to broaden tasks unless the boundary is explicit.

```text
IN_SCOPE
- inspect spatial queries
- optimize indexes
- benchmark

OUT_OF_SCOPE
- redesign API
- migrate database engine
- unrelated refactor
```

### 5.3 Decision policy

The planning agent (for example, Prometheus) may turn the approved Execution Brief into bounded subtask assignments and choose which configured agents handle them. That is the limit of its planning authority. It does not re-plan the user's task or decide what result Codex should accept.

```text
OPEN_CODE_MAY_DECIDE
- implementation details
- local refactoring
- test implementation
- file organization
- subagent delegation
- skill routing
- MCP/provider selection
- validation sequencing

MUST_ASK_CODEX
- architecture changes
- API contract changes
- database schema changes outside declared scope
- destructive production operations
- major dependency changes
- unresolved requirement conflicts
- security trade-offs with material impact
```

### 5.4 Workspace root (wajib, fail-closed)

Setiap Execution Brief wajib membawa `workspace_root`: path absolut workspace Codex
yang aktif untuk task tersebut. Bridge memcanonicalize path, memastikan directory ada,
dan menolak brief sebelum sesi OpenCode dibuat bila field hilang, relatif, atau tidak
valid. Seluruh operasi sesi, capability, validasi, dan recovery task itu berjalan pada
workspace tersebut melalui parameter `directory` per request HTTP OpenCode 1.18.32.
Record lama tanpa workspace tidak pernah dialihkan ke workspace lain; ia gagal dengan
alasan `workspace_missing`. `OPENCODE_WORKSPACE` saat startup hanya menentukan lokasi
state dan scope default, bukan workspace task.

---

## 6. Execution Modes

### 6.1 Quick

```text
Codex
  ↓
OpenCode
  ↓
Jev
  ↓
Sisyphus direct
  ↓
agent-bound model
  ↓
validation
  ↓
Codex
```

Use for small tasks where architecture is already obvious.

### 6.2 Standard

```text
Codex → OpenCode → Jev → Sisyphus + validation → Codex
```

Use for multi-file work with clear scope.

### 6.3 Full orchestration

```text
Codex
  ↓
OpenCode
  ↓
Jev
  ↓
OMO
  ↓
Prometheus / Atlas / Sisyphus
  ├── Explore
  ├── Librarian
  ├── Hephaestus
  ├── Oracle
  └── Reviewer
  ↓
Validation
  ↓
Codex
```

The actual set of invoked agents is conditional. Agents already have their own model bindings.

### 6.4 Specialist / tool-heavy

```text
Codex
  ↓
OpenCode
  ↓
Jev
  ↓
specialist route
  ↓
agent with configured model + allowed tools
  ↓
task-specific MCP
  ↓
external application / service
  ↓
artifacts + validation
  ↓
Codex
```

Examples:

- AutoCAD → `autocad-live`
- Browser automation → `playwright`
- Browser debugging → `chrome-devtools`
- Design/CAD workflows → `pencil`
- Code graph → `codegraph`
- Documentation → `context7`
- GitHub work → `github`
- Web research → `websearch` / `exa`
- Memory retrieval → `claude-mem-search`

---

## 7. Jev Routing + Skill Bundle Model

Jev is a cheap routing layer inside OpenCode. It does not need to expose all agent machinery to Codex.

### 7.1 Jev decision dimensions

```text
complexity
ultrawork
visual
primary skill / route
load_skills
execution category
```

### 7.2 Complexity

```text
quick      → direct / low complexity
standard   → deeper route
full       → deep + ultrawork
specialist → ultrabrain + ultrawork
```

With the configured confidence policy:

```text
> 0.85       auto-act
0.60–0.85    act with default
< 0.60       fallback / stronger decision path
```

### 7.3 Ultrawork

```text
need_ultrawork > 0.60 OR complexity ∈ {full, specialist}
```

### 7.4 Visual

```text
is_visual > 0.55
    → visual-engineering route
```

### 7.5 Primary Skill → Skill Bundle

This relationship must remain explicit:

```text
Jev
 ↓
PRIMARY SKILL / ROUTE
 ↓
PREDEFINED SKILL BUNDLE
 ↓
load_skills
 ↓
SKILL.md files loaded into agent context
```

Jev is **not independently picking every supporting skill**.

Examples:

```text
frontend
  → frontend
  → frontend-design
  → design-taste-frontend
  → impeccable
  → hallmark
  → baseline-ui
  → ui-ux-pro-max
  → tailwind-css-patterns
  → antislop
  → antislop-ui
```

```text
bug-hunter
  → bug-hunter
  → debugging-strategies
  → lint-and-validate
  → code-review-checklist
```

```text
backend-architect
  → backend-architect
  → nodejs-backend-patterns
  → nodejs-best-practices
  → api-design-principles
  → architecture
```

The resolved bundle becomes part of the agent's bounded execution context alongside project instructions, AGENTS.md, workspace facts, and relevant tools.

---

## 8. OpenCode Execution Context Assembly

The effective agent context should be assembled from bounded layers:

```text
Execution Brief
        +
AGENTS.md / project instructions
        +
Jev decision
        +
resolved skill bundle / load_skills
        +
agent profile + permissions + bound model
        +
relevant workspace facts
        +
task-scoped MCP/tool surface
        ↓
BOUNDED AGENT EXECUTION CONTEXT
```

Do not copy the entire Codex conversation or private reasoning into every agent.

Subagents receive only the smallest useful task slice:

```text
parent task
  ↓
subtask contract
  ├── goal
  ├── relevant files
  ├── constraints
  ├── required skill subset
  ├── expected output
  └── validation needed
```

---

## 9. Agent → Model Binding

There is **no worker-model pool**.

The configured architecture is:

```text
Jev / OMO selects an agent
        ↓
that agent's configuration determines its model
```

Representative bindings from the current setup include:

```text
Sisyphus           → Muse Spark 1.3
Sisyphus-Junior    → Muse Spark 1.3
Prometheus         → Muse Spark 1.3
Momus              → Muse Spark 1.3
Atlas              → configured Lightning route
Hephaestus         → Ling 3.0 Flash Fin
Oracle             → Nemotron 3 Ultra
Metis              → Nemotron 3 Ultra
Explore            → Nemotron 3.5 Lightning
Librarian          → Nemotron 3.5 Lightning
Multimodal Looker  → MiMo v2.6
Reviewer / Tester  → configured MiMo / Lightning route
```

These are **agent configuration details**, not a separate model-selection layer in the bridge.

---

## 10. MCP Capability Hub

OpenCode should expose a capability-oriented architecture.

> Codex asks for a capability; OpenCode maps that capability to an available provider/MCP.

Example:

```text
Codex:
  required_capabilities = ["database-schema-inspection"]

OpenCode:
  resolve capability
  → PostgreSQL MCP
```

This keeps Codex decoupled from a specific MCP package/provider.

### Capability classes

```text
repository
web-search
browser-automation
browser-debugging
code-graph
web-docs
memory
postgresql
mysql
redis
autocad
blender
3d-design
image-generation
video-generation
filesystem
shell
```

---

## 11. Dynamic MCP Acquisition

### Lifecycle

```text
REQUEST CAPABILITY
  ↓
Registry lookup
  ↓
Installed?
 ├── YES → validate status → enable for task
 └── NO  → discover candidates
             ↓
          evaluate source / permissions / risk / compatibility
             ↓
          install disabled
             ↓
          configure credentials
             ↓
          health check
             ↓
          enable
             ↓
          task execution
             ↓
          validation
             ↓
          disable
             ↓
          keep installed definition cached
```

Current OpenCode documentation confirms that MCPs add tool context and can be enabled/disabled; current plugin APIs also expose MCP transforms and reload/reconciliation. The exact runtime mechanism to use in this project must still be validated against **OpenCode 1.18.32** rather than blindly copying newer V2 config syntax. citeturn698132search0turn698132search1turn698132search3

### Safety gate

Never blindly install arbitrary MCP packages because a model suggested a package name.

**User decision (2026-09-25):** For every MCP that is not already installed, present a reviewed proposal and request user approval before installation. Registry discovery alone never authorizes installation.

Record before installation:

- source/repository URL,
- publisher/owner,
- license when available,
- transport type,
- install command,
- required environment variables,
- required credentials,
- declared tools,
- requested filesystem/network access,
- destructive capability classification,
- version/pin or commit hash when practical,
- selection reason,
- alternatives considered.

New/high-risk sources should stop for approval.

### Installed ≠ active

```text
installed = true
enabled  = false
```

is the normal cached state outside a task.

---

## 12. Existing MCP Inventory

Current reported MCPs:

```text
autocad-live
camofox-browser
chrome-devtools
claude-mem-search
claude-mem:mcp-search
codegraph
context7
exa
github
grep_app
Isp
pencil
playwright
websearch
```

### Suggested policy

Core candidates:

```text
claude-mem-search
context7
github
```

Task-based:

```text
codegraph
grep_app
exa
websearch
playwright
chrome-devtools
```

Dormant specialist:

```text
autocad-live
pencil
camofox-browser
```

`Isp` and `claude-mem:mcp-search` should remain under audit until their actual tool surfaces and overlap are confirmed.

This is a policy proposal, not an automatic configuration change.

---

## 13. MCP Context Budget Policy

OpenCode documentation explicitly warns that MCP servers add tools to model context and that a large number of tools can quickly increase context size. citeturn698132search1

Therefore:

```text
TOTAL INSTALLED CAPABILITIES
    can be large

ACTIVE TOOL SURFACE PER TASK
    should be small
```

Examples:

```text
Large toolbox:        20+ installed capabilities
Frontend task:        ~4–6 active MCP/tool surfaces
AutoCAD task:         ~2–4 active MCP/tool surfaces
Research task:        ~2–4 active MCP/tool surfaces
```

Agent-specific tool permissions should be used where possible so a configured MCP can remain unavailable to agents that do not need it. OpenCode documents per-agent tool control and glob-based MCP tool permissions. citeturn698132search1turn698132search7

---

## 14. Codex ↔ OpenCode MCP Bridge

### 14.1 Architecture

```text
CODEX
  │
  │ local MCP / stdio
  ▼
OPEN CODE MCP BRIDGE
  │
  │ localhost HTTP
  ▼
OPENCODE SERVER / RUNTIME
  ├── Jev
  ├── OMO
  ├── Agents
  ├── Skill Bundles
  ├── Capability Manager
  ├── MCPs
  └── Workspace
```

The bridge is a **thin control plane**, not a second reasoning engine.

### 14.0 Transport clarification: MCP, Jev gate plugin, and ACP

`opencode_hub` is an **MCP server** (local `stdio`) exposing the 7 Codex-facing tools.
`jev-gate` is an **OpenCode plugin** (runtime hook) that runs Jev routing before the
agent turn and stores the route receipt; it is not the hub itself.
**ACP (Agent Client Protocol) is not used in this workflow and does not replace MCP here.**
ACP connects an editor/client to OpenCode as a coding agent via `opencode acp`;
MCP connects the Codex host to the bridge's task/status/result/decision contract.
The interactive choice UI is a Codex-host feature rendering `decisions_required`,
not something MCP or ACP provides automatically.

OpenCode exposes a headless HTTP server through `opencode serve` and session endpoints for creating sessions, sending messages, checking status, retrieving diffs, aborting, and related lifecycle operations. The bridge should use the supported HTTP boundary rather than screen-scraping or simulating terminal interaction. citeturn698132search5

### 14.2 Recommended implementation stack

```text
TypeScript
Node.js 22
@modelcontextprotocol/sdk
MCP stdio server
OpenCode HTTP API
Zod or equivalent schema validation
small local task-state store
```

The primary optimization target is **Codex context/token efficiency**, not the smallest possible bridge binary. TypeScript is preferred because it aligns with the OpenCode ecosystem and MCP SDK while keeping the bridge easy to maintain.

### 14.3 Codex-visible tool surface

Keep the Codex-side bridge small but sufficiently expressive. Recommended **7 tools**:

```text
1. opencode_execute
2. opencode_status
3. opencode_result
4. opencode_inspect
5. opencode_correct
6. opencode_decision
7. opencode_stop
```

Do **not** expose OpenCode's entire internal machinery as Codex MCP tools.

Avoid exposing tools such as:

```text
opencode_load_skill
opencode_run_jev
opencode_run_sisyphus
opencode_start_prometheus
opencode_install_postgresql_mcp
opencode_enable_playwright
...
```

Those are internal execution concerns.

### 14.4 Tool responsibilities

The Codex-side persistent instruction requires `opencode_execute` for every actionable task, including quick tasks. Codex first creates the task contract and retains authority over its objective and architectural decisions. The Jev quick route may then send a small task directly to Sisyphus without extra agent delegation.

#### `opencode_execute`
Starts a task with a complete Execution Brief.

Input conceptually contains:

```text
task
objective
scope
context
current_state
architecture
decisions_already_made
decision_rationale
requirements
constraints
forbidden_changes
required_capabilities
execution_hints
acceptance_criteria
validation_requirements
expected_artifacts
known_risks
open_questions
decision_policy
```

Default output should be compact:

```json
{
  "task_id": "oc_7f29",
  "status": "accepted"
}
```

Do not return the full OpenCode transcript here.

#### `opencode_status`
Returns compact lifecycle state:

```text
queued | resolving | executing | validating | blocked | decision_required | completed | failed | cancelled
```

Include only the minimum progress/attention metadata needed by Codex.

#### `opencode_result`
Returns the compact Result Contract summary. Codex can then decide whether deeper inspection is needed.

#### `opencode_inspect`
Selective/lazy retrieval. Supported logical views should include:

```text
diff
changed_files
validation
artifacts
evidence
decision
logs
provenance
```

Only requested views should be returned.

#### `opencode_correct`
Starts another execution cycle using a Correction Brief attached to the same `task_id`.

#### `opencode_decision`
Returns an explicit Codex architecture/risk decision to a task that is blocked on a decision.

#### `opencode_stop`
Stops/cancels a running task.

### 14.5 Token efficiency rules

1. Send the Execution Brief once.
2. Reference future interactions by `task_id`.
3. Do not resend the entire brief during correction.
4. Default to compact status/result.
5. Retrieve diff/evidence/logs lazily with `opencode_inspect`.
6. Do not mirror the entire OpenCode transcript into bridge state.
7. Keep bridge-side persistent state to IDs/status/metadata, not duplicated reasoning.
8. Return machine-readable summaries before large text payloads.

This gives Codex enough control for quality while avoiding unnecessary context replay.

---

## 15. Result Contract

OpenCode should return a compact structured result that can be inspected further.

Canonical structure:

```yaml
RESULT_CONTRACT:
  task_id: string
  status: complete|blocked|failed|cancelled|partial
  summary: string
  what_changed: []
  changed_files: []
  artifacts: []
  validation:
    typecheck: pass|fail|not_run
    lint: pass|fail|not_run
    tests: pass|fail|not_run
    build: pass|fail|not_run
    custom_checks: []
  evidence: []
  risks: []
  assumptions: []
  unresolved_issues: []
  decisions_required: []
  capabilities_used: []
  capabilities_installed: []
  agents_used: []
  models_used: []
  tools_used: []
  mcps_used: []
  mcp_state: []
  provenance: []
```

`agents_used` and `models_used` are **observability/provenance fields**, not a worker-pool concept.

---

## 16. Task State Machine

```text
CREATED
  ↓
BRIEF_ACCEPTED
  ↓
CAPABILITIES_RESOLVED
  ↓
CAPABILITIES_READY
  ↓
EXECUTING
  ↓
VALIDATING
  ↓
RESULT_READY
  ↓
CODEX_REVIEW
 ├── APPROVED → COMPLETE
 ├── CHANGES_REQUIRED → CORRECTION → EXECUTING
 └── DECISION_REQUIRED → WAITING_FOR_CODEX → EXECUTING
```

Exceptional states:

```text
BLOCKED
WAITING_FOR_HUMAN
FAILED
CANCELLED
```

---

## 17. Correction Loop

### PASS

```text
Result satisfies execution brief + acceptance criteria.
→ COMPLETE
```

### CORRECT

Codex creates a Correction Brief containing:

```text
failed criteria
observed problem
evidence
expected behavior
required correction
must preserve
forbidden side effects
revalidation required
```

Then:

```text
Codex
  ↓ correction
OpenCode
  ↓ execute
validation
  ↓
Result Contract
  ↓
Codex
```

### ESCALATE / DECISION

```text
OpenCode encounters architecture ambiguity
  ↓
structured decision request
  ↓
Codex shows the exact question and options to the user
  ↓
Codex chooses an option / adds a constraint and explains it briefly
  ↓
OpenCode resumes
```

If the answer depends on an unstated user preference, Codex uses the host's interactive choice UI with concise options and free-text input, then waits instead of selecting an option on the user's behalf. If the user asks a follow-up before choosing, Codex explains the trade-offs and keeps the decision pending.

Decision wait timeout: five minutes from the moment the choices are shown. If the user sends no message for five full minutes, Codex selects the recommended option that best fits the brief and instructions, tells the user the fallback was used and why, then resumes via `opencode_decision`. Any user message resets the five-minute timer. Decisions derivable from the brief are answered immediately without waiting.

Correction loop: after each OpenCode result, Codex inspects it against the acceptance criteria. If unmet, Codex sends `opencode_correct` with the failed criteria, evidence, and specific revalidation, then iterates until done or until a genuinely new decision is required. Codex never performs the correction implementation itself.

### ABORT

Stop when risk exceeds policy or the operation cannot safely continue.

---

## 18. Research Workflow

Research uses the same bridge, but the artifact is evidence rather than code.

```text
User question
  ↓
Codex Research Brief
  ↓
OpenCode
  ↓
Jev
  ↓
Research agent
  ↓
websearch / exa / docs / browser
  ↓
evidence collection
  ↓
source normalization
  ↓
preliminary synthesis
  ↓
Result Contract
  ↓
Codex evidence review
  ↓
final synthesis
```

Research results should preserve:

- source URL,
- source title,
- publication/update date when available,
- claim supported,
- extracted evidence,
- limitations,
- contradictions,
- retrieval timestamp.

---

## 19. Tool-Heavy Workflow

```text
Codex defines desired result
  ↓
OpenCode resolves capability
  ↓
Jev selects specialist route
  ↓
agent with configured model + scoped tools
  ↓
MCP performs real-world operations
  ↓
artifacts + validation
  ↓
Codex verifies output
```

### AutoCAD example

```text
Codex
  ↓
required_capabilities = ["autocad"]
  ↓
OpenCode capability check
  ↓
Jev → autocad-router
  ↓
autocad specialist agent
  ↓
autocad-live
  ↓
DWG / geometry
  ↓
validation
  ↓
Codex
```

The agent already has its configured model. The bridge does not select a model for it.

---

## 20. Dynamic MCP Example: Database Refactor

### User

> "Refactor this database structure and make migration safer."

### Codex decision context

```yaml
objective: "Safely refactor database structure."
required_capabilities:
  - repository
  - database-schema-inspection
  - migration-validation
constraints:
  - "Do not destroy production data."
  - "Generate reversible migration where practical."
forbidden_changes:
  - "Do not change public API contracts."
decision_policy:
  must_ask_codex:
    - "production schema change"
    - "destructive operation"
acceptance_criteria:
  - "Existing application tests pass."
  - "Migration can be validated against a safe database target."
  - "Schema diff is documented."
```

OpenCode resolves capability to the best available provider. If the capability is missing, it follows the acquisition lifecycle.

### Database safety boundary

Read/analysis examples:

```text
inspect schema      YES
inspect indexes     YES
inspect constraints YES
EXPLAIN queries     YES
read test DB        YES
```

Production mutation should be denied or explicitly approved unless policy says otherwise.

---

## 21. Existing MCP Inventory and Profiles

Current reported MCPs:

```text
autocad-live
camofox-browser
chrome-devtools
claude-mem-search
claude-mem:mcp-search
codegraph
context7
exa
github
grep_app
Isp
pencil
playwright
websearch
```

Suggested initial policy:

```text
CORE CANDIDATES
  claude-mem-search
  context7
  github

TASK-BASED
  codegraph
  grep_app
  exa
  websearch
  playwright
  chrome-devtools

DORMANT SPECIALIST
  autocad-live
  pencil
  camofox-browser
```

Classify `Isp` and `claude-mem:mcp-search` after inspecting actual tool surfaces and overlap.

Profiles should constrain the **active surface**, not remove capabilities from the installed registry.

---

## 22. Security Requirements for Dynamic MCP

### P0

- Never install arbitrary MCPs solely because an LLM proposed a package name.
- Record source and install command before installation.
- Separate install from enablement.
- Destructive MCP tools require stricter policy than read-only tools.
- Secrets must not be embedded in prompts, logs, or registry files.
- Prefer environment references / secure secret storage.
- Pin versions when practical.
- Audit installation, activation, tool usage, and disablement.

### P1

- Trusted-source allowlist.
- Health-check and timeout policy.
- Capability-level risk labels.
- Quarantine failed/untrusted MCPs.

### P2

- Usage-based capability suggestions.
- Duplicate-capability detection.
- Stale MCP detection.
- Context-cost telemetry.

---

## 23. Observability

The bridge should log metadata such as:

```text
task_id
brief_id
execution_id
jev_decision
selected_agents
agent-bound models used
requested_capabilities
mcps_enabled
mcps_disabled
tool_calls
validation_results
artifacts
corrections
final_codex_decision
```

Do not store sensitive content unnecessarily.

A trace should answer:

> Why did OpenCode use this route, this agent, this capability, and this tool for this task?

---

## 24. Codex-Side vs OpenCode-Side Tool Surface

### Codex side

Keep deliberately small:

```text
ONE MCP BRIDGE
  └─ 7 tools:
     execute
     status
     result
     inspect
     correct
     decision
     stop
```

Codex should **not** receive all internal MCP, agent, skill, and routing tools.

### OpenCode side

Keep broad capability, but route narrowly:

```text
Plugins
MCP registry
MCP profiles
Jev
OMO
Agents
Skill bundles
Agent model bindings
Workspace tools
Validation
```

This preserves high total capability without forcing Codex to carry the entire execution surface in its context.

---

## 25. Implementation Phases

### Phase 0 — Freeze current behavior

- backup current OpenCode config,
- inventory all MCPs/plugins/agents,
- record active/inactive state,
- record current Jev routing,
- record OMO config,
- no architectural changes yet.

### Phase 1 — Capability registry

Build:

```text
registry.json
profiles.json
policies.json
mcp-lock.json
```

### Phase 2 — Thin bridge server

Build the local MCP server with exactly the 7 Codex-facing tools:

```text
opencode_execute
opencode_status
opencode_result
opencode_inspect
opencode_correct
opencode_decision
opencode_stop
```

Bridge should use structured schemas and compact default responses.

### Phase 3 — OpenCode transport adapter

Connect bridge to the supported OpenCode HTTP server boundary. Prefer a persistent local `opencode serve` process over spawning a fresh CLI process for every request when the installed version supports the required lifecycle.

### Phase 4 — Execution Brief + Result Contract

Create stable schemas + validators.

### Phase 5 — Closed-loop verification

Implement:

```text
Result
  ↓
Codex review
  ↓
Correction / Decision
  ↓
OpenCode retry / resume
```

### Phase 6 — Capability manager

Implement discovery/evaluation/install-disabled/health-check/enable/disable/reuse with policy gates.

### Phase 7 — MCP profiles + agent tool scopes

Implement coding/research/browser/CAD/design/database profiles and agent-specific tool visibility.

### Phase 8 — Telemetry and optimization

Measure:

- Jev Estimate (separate from Jev Decision; runs once on the final result with no pending decisions): `Codex tokens saved` and `Context avoided` as absolute token counts from a genuine Jev estimate source only, never percentages, allowance conversions, or context-window capacity; report `unavailable` when no genuine estimate exists and never present local arithmetic as Jev output,
- active tool surface size,
- correction rate,
- capability activation rate,
- repeated-install avoidance,
- result retrieval size,
- time-to-result,
- failed tool selection.

---

## 26. Success Criteria

### Quality

- Codex can reject incorrect OpenCode output and request corrections.
- Architecture decisions are preserved across delegation.
- Acceptance criteria are explicitly verified.

### Efficiency

- Codex does not spend most tokens on mechanical tool execution.
- Execution Brief is sent once per task and reused by task ID.
- Result details are fetched lazily.
- OpenCode handles bulk implementation/retrieval.
- Repeated MCP installation is avoided.

### Capability

- OpenCode can use specialized MCPs without exposing all tools to every agent.
- A missing capability can be acquired safely when justified.
- New tools can be added without redesigning Codex prompts.

### Safety

- Unknown MCPs are not trusted automatically.
- Destructive capabilities have explicit policy controls.
- Secrets are isolated.
- Tool and installation events are auditable.

### Operability

- A failed task can be resumed or corrected.
- Artifacts and diffs are recoverable.
- MCP state is inspectable.

---

## 27. Anti-Patterns

### 1. Codex → "Do everything" → OpenCode

Architecture decisions become implicit.

### 2. Codex → entire conversation → OpenCode

Huge context, duplicated reasoning, poor signal-to-noise.

### 3. OpenCode → every MCP always active

Unnecessary tool/context surface. OpenCode documentation explicitly warns about MCP context growth. citeturn698132search1

### 4. LLM says "install package X" → immediate install

Supply-chain/security risk.

### 5. OpenCode finds ambiguity → silently changes architecture

Decision authority leaks away from Codex/user.

### 6. Codex reviews only natural-language summary

Summary can hide defects. Prefer diff, artifacts, tests, evidence, and selective inspection.

### 7. Bridge exposes every OpenCode internal tool to Codex

This increases tool-schema context, couples Codex to OpenCode internals, and defeats the right-hand boundary.

### 8. Correction resends the entire Execution Brief

Unnecessary token usage. Reuse `task_id` and send only the correction delta.

---

## 28. One-Sentence Design Rule

> **Codex decides the task, boundaries, and what “correct” means; OpenCode's planner only assigns bounded work to agents; Jev/OMO route and coordinate execution; agents use their configured models; MCPs provide capabilities; Codex decides whether the result is actually correct.**

---

## 29. Direct Handoff Prompt for Codex

Use the updated handoff prompt stored alongside this PRD.

---

## 30. Current Documentation Notes

Current official documentation supports the architectural direction used here:

- OpenCode supports local and remote MCP servers and warns that MCP tools add to model context. citeturn698132search0turn698132search1
- OpenCode exposes a headless HTTP server with session/status/diff/abort/message endpoints through `opencode serve`. citeturn698132search5
- OpenCode exposes per-agent tool controls and MCP tool permission patterns. citeturn698132search7
- OpenCode's current plugin API can transform/reload MCP configuration, but this project's implementation target remains OpenCode 1.18.32 and must verify exact runtime behavior before relying on newer V2 config semantics. citeturn698132search3
- OpenAI documents connecting Codex to MCP servers and building MCP servers with the official TypeScript SDK. citeturn176855search0turn176855search7

The v1.18.32 release is a real pinned OpenCode release; implementation should verify that exact installed behavior before relying on newer configuration syntax. citeturn340643search0
