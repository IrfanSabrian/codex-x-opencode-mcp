# Codex Handoff Prompt: Codex → OpenCode Execution Hub

Paste this into a fresh Codex session as the starting instruction for implementation.

```text
I want to build a Codex → OpenCode execution-hub architecture.

ROLE SPLIT
- Codex = executive / lead reasoning / architecture authority / final quality gate.
- OpenCode = right-hand execution hub.
- Jev = cheap routing and task classification inside OpenCode.
- OMO = multi-agent orchestration for complex work.
- The OpenCode planning agent may only divide Codex-approved work into bounded agent assignments; it must not redefine the user task or change Codex decisions.
- Agents = scoped execution units; each agent already has its own configured model binding.
- MCPs = external capabilities owned and managed by OpenCode.

IMPORTANT: THERE IS NO SEPARATE WORKER-MODEL POOL.
Sisyphus, Prometheus, Atlas, Hephaestus, Oracle, Explore, Librarian, Reviewer, and other agents are configured agents. Their models are properties of those agent configurations. Do not introduce a separate model-pool layer.

CORE RULE
Codex decides WHAT correct means.
Codex defines task scope, architecture, constraints, and acceptance criteria.
The OpenCode planning agent only decides WHICH configured agents handle each bounded in-scope subtask.
Jev/OMO route and coordinate execution within Codex's boundaries.
Agents execute within their scope using their configured models.
MCPs provide capabilities.
Codex verifies whether the result is actually correct.

ROUTING RULE
For every actionable task, including quick tasks, Codex must call `opencode_execute` through `opencode_hub`. Every call must include `workspace_root` with the absolute path of the active Codex workspace; never omit it and never fall back to another workspace when it is missing. The bridge canonicalizes the path, verifies the directory exists, and rejects the task before creating any session when the field is absent or invalid. Do not silently perform the requested execution in Codex. Pure conversation and explanations may be answered directly. If `opencode_hub` is unavailable, explain the block rather than silently bypassing it.

MAIN CLOSED LOOP
Codex
  ↓ Execution Brief
OpenCode
  ↓ execution + validation
Result Contract
  ↓
Codex Quality Gate
  ├─ PASS → DONE
  ├─ CORRECTION → Correction Brief → OpenCode → execute again
  └─ DECISION → Codex decides → OpenCode resumes

CODEX REASONING → EXECUTION BRIEF
Do NOT transfer Codex hidden chain-of-thought or the entire conversation to OpenCode.
Codex should reason internally, then distill the relevant decision context into a structured Execution Brief.

The important principle is:
DETAIL = reduce the executor's interpretation space.
Do not save tokens by deleting decisions OpenCode needs.
Do not save tokens by sending raw chain-of-thought.

CODEX REASONING STAGES
1. Understand intent
2. Gather relevant context
3. Identify actual problem
4. Decide architecture / approach
5. Define scope
6. Record important decision rationale
7. Define constraints + forbidden changes
8. Define required capabilities
9. Define acceptance + validation
10. Define what OpenCode may decide vs what must return to Codex

EXECUTION BRIEF
Use a structured contract containing:
- task: task_id, parent_task_id, mode, requested_by
- objective
- scope: in_scope, out_of_scope
- context
- current_state
- architecture
- decisions_already_made
- decision_rationale
- requirements
- constraints
- forbidden_changes
- required_capabilities
- execution_hints
- acceptance_criteria
- validation_requirements
- expected_artifacts
- known_risks
- open_questions
- decision_policy:
  - opencode_may_decide
  - must_ask_codex
- workspace_root: absolute path of the active workspace (mandatory; fail-closed)

GOOD DETAIL
"schema tidak boleh diubah; endpoint existing harus tetap kompatibel; benchmark before/after wajib; gunakan repository layer existing."

BAD DETAIL
"buat yang bagus, aman, scalable."

A good brief removes important ambiguity. It is not merely a longer prompt.

JEV SKILL MODEL
Jev chooses a PRIMARY SKILL / ROUTE, not every supporting skill independently.
The selected primary route resolves a PREDEFINED SKILL BUNDLE.
That bundle becomes load_skills and the referenced SKILL.md files are loaded into the agent context.

Example:
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

Example:
bug-hunter
  → bug-hunter
  → debugging-strategies
  → lint-and-validate
  → code-review-checklist

Jev also decides complexity, ultrawork, visual routing, and execution category.

AGENT ROUTING
- quick → usually Sisyphus direct
- standard → deeper Sisyphus execution + validation
- full → OMO orchestration
- specialist → ultrabrain / ultrawork route
- visual → visual-engineering route

Agents already have model bindings. The bridge must not choose a model pool.

OPEN CODE CONTEXT ASSEMBLY
Execution Brief
+ AGENTS.md / project instructions
+ Jev output
+ resolved skill bundle / load_skills
+ agent profile / permissions / bound model
+ relevant workspace facts
+ task-scoped MCP/tool surface
= bounded agent execution context

Subagents should receive bounded task contracts, not the entire parent context.

MCP HUB
OpenCode is the capability hub. Codex should ideally expose one MCP bridge to OpenCode.
Codex should request capabilities, not hard-code MCP package names whenever possible.
Examples:
- postgresql
- mysql
- browser-automation
- browser-debugging
- autocad
- blender
- research
- documentation
- repository

DYNAMIC MCP ACQUISITION
If a required capability is missing:
1. search local registry;
2. discover candidate MCP(s);
3. evaluate source, publisher, license, permissions, credentials, destructive behavior, transport, version and health;
4. install it in DISABLED state;
5. health-check it;
6. enable only for the current task/session;
7. use it;
8. validate results;
9. disable it after the task;
10. keep the installed definition cached for future tasks unless removed.

Never equate installed with trusted or enabled.
Never allow a newly discovered arbitrary MCP to perform destructive operations without policy/approval.

CURRENT OPENCODE
- Version: 1.18.32
- OMO installed
- Jev Decision Maker installed
- Existing MCPs:
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
- Heavy/inactive candidates include autocad-live, pencil, camofox-browser.

BRIDGE IMPLEMENTATION
Target stack:
- TypeScript
- Node.js 22
- official @modelcontextprotocol/sdk
- local MCP server over stdio toward Codex
- localhost HTTP client toward OpenCode server/runtime
- schema validation (for example Zod)

Transport clarification: `opencode_hub` is an MCP server; `jev-gate` is an OpenCode
plugin hook, not the hub. ACP (Agent Client Protocol) is NOT used in this workflow
and does not replace the MCP task/status/result/decision contract.

Primary optimization target is Codex token/context efficiency, not the smallest binary.

CODEX-FACING MCP SURFACE
Keep the bridge small but expressive. Recommended 7 tools:
1. opencode_execute
2. opencode_status
3. opencode_result
4. opencode_inspect
5. opencode_correct
6. opencode_decision
7. opencode_stop

Do NOT expose internal OpenCode machinery such as run_jev, load_skill, start_sisyphus, start_prometheus, install_postgresql_mcp, enable_playwright, etc.
Those remain internal to OpenCode.

TOOL CONTRACTS

opencode_execute
- input: structured Execution Brief
- output: compact task_id + accepted state
- do not return full transcript

opencode_status
- input: task_id
- output: compact lifecycle state and attention metadata

opencode_result
- input: task_id
- output: compact Result Contract summary
- deeper details are retrieved separately

opencode_inspect
- input: task_id + view
- views may include: diff, changed_files, validation, artifacts, evidence, decision, logs, provenance
- use lazy retrieval: return only the requested view

opencode_correct
- input: task_id + Correction Brief
- output: accepted / resumed state
- do not resend the full Execution Brief

opencode_decision
- input: task_id + decision_id + Codex decision
- used only when OpenCode is waiting for an architecture/risk decision

opencode_stop
- input: task_id + reason
- stop/cancel execution

TOKEN EFFICIENCY POLICY
1. Send the Execution Brief once.
2. Reference later interactions by task_id.
3. Do not resend the entire brief during correction.
4. Return compact status/result by default.
5. Retrieve large diff/evidence/log payloads lazily with opencode_inspect.
6. Do not duplicate the full OpenCode transcript in bridge state.
7. Store task IDs, session IDs, state, and metadata rather than duplicated reasoning.
8. Return machine-readable summaries before large text payloads.

RESULT CONTRACT
Return structured information including:
- task_id
- status
- summary
- what_changed
- changed_files
- artifacts
- validation
- evidence
- risks
- assumptions
- unresolved_issues
- decisions_required
- capabilities_used
- capabilities_installed
- agents_used
- models_used (observability only; not a model pool)
- tools_used
- mcps_used
- mcp_state
- provenance

QUALITY GATE
Codex must review the actual result, not only the summary.
Prefer:
- diff
- changed files
- tests
- typecheck/lint/build
- benchmark
- artifacts
- evidence

If incorrect:
Codex creates a Correction Brief with failed criteria, evidence, and specific revalidation, sends it via `opencode_correct`, and iterates until the acceptance criteria hold. Codex never implements the correction itself.

If architecture is ambiguous:
OpenCode returns the exact question and options.
If Codex can answer from the brief, Codex shows the question and its answer with a short rationale, then submits it through `opencode_decision`.
If the answer needs a user preference, Codex presents 2–3 interactive choices with free-text input and waits. Five-minute rule: silence for five full minutes after the choices are shown means Codex picks the recommended option fitting the brief, tells the user the fallback was used and why, then passes it through `opencode_decision`. Any user message resets the timer. If the user asks a follow-up, Codex explains the trade-offs and keeps the decision pending.
After the user chooses, Codex passes that answer through `opencode_decision` and OpenCode resumes.

CURRENT MCP POLICY
Core candidates:
- claude-mem-search
- context7
- github

Task-based:
- codegraph
- grep_app
- exa
- websearch
- playwright
- chrome-devtools

Dormant specialist:
- autocad-live
- pencil
- camofox-browser

Classify Isp and claude-mem:mcp-search before changing them.

IMPLEMENTATION ORDER
Phase 0: audit and backup existing OpenCode configuration.
Phase 1: capability registry.
Phase 2: thin 7-tool OpenCode bridge.
Phase 3: OpenCode HTTP transport adapter.
Phase 4: Execution Brief + Result Contract schemas and validators.
Phase 5: closed-loop Codex review/correction/decision.
Phase 6: dynamic MCP acquisition with risk policy.
Phase 7: profiles and agent-scoped tool visibility.
Phase 8: telemetry and optimization.

SAFETY / INTEGRITY
- Back up configs before editing.
- Do not overwrite existing MCP/plugin definitions blindly.
- Do not expose secrets in prompts, logs, or registry files.
- Prefer environment references or secure secret storage.
- Pin MCP versions when practical.
- Audit installs, enables, disables, and destructive tool usage.
- Preserve rollback paths.

VERSIONING WARNING
Use OpenCode 1.18.32 behavior as the implementation target. Do not blindly copy newer OpenCode V2 config syntax. Verify exact runtime behavior first.

FIRST ACTION
Do not implement the whole system immediately.
First inspect:
- OpenCode 1.18.32 configuration
- plugins
- MCP definitions
- AGENTS.md
- Jev router / skill routing
- OMO configuration
- configured agent/model bindings
- existing filesystem layout

Then propose the smallest safe Phase-0/Phase-1 implementation with exact files to add/change and validation steps.
```
