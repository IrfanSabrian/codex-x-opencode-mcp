---
name: codex-x-opencode-mcp
description: Use the codex_x_opencode_mcp bridge only when the user explicitly asks Codex to delegate the current request to a configured execution harness such as OpenCode, Codex CLI, Claude Code, Cursor CLI, Copilot CLI, or Command Code. Covers execution, decisions, corrections, and Jev reporting for delegated work.
---

# Harness Workflow

Codex owns intent, scope, architecture, requirements, constraints, and acceptance criteria. The configured execution harness executes. This skill changes routing and decision handling only.

## When to use

Use only when the user explicitly asks Codex to delegate the current request to the bridge. This includes simple questions or small tasks when explicitly requested. Otherwise Codex handles the request directly.

The request to delegate is scoped to the current request and never carries over to later requests. Merely mentioning the project or connector is not an instruction to route the work.

## MCP preflight

Before building a brief, confirm the `codex_x_opencode_mcp` connector is available in the current session.

- If unavailable or stale, attempt managed recovery/restart first when possible. If still blocked, stop and explain the blocker transparently. Do not silently execute the work in Codex and do not claim routing happened.
- A skill cannot make an absent MCP appear.

## Codex-owned brief

Codex decides task objective, scope, architecture, constraints, and acceptance criteria before calling `harness_execute`. The harness planner only divides approved in-scope work into bounded assignments and picks configured agents. It must not change the objective, scope, architecture, or acceptance criteria.

Codex may read just enough context to write the brief and to verify the result. Execution itself belongs to the harness.

## workspace_root invariant

Every `harness_execute` call must include `workspace_root` with the absolute active Codex workspace path. Never omit it and never fall back to another workspace when it is missing. The bridge rejects tasks without a valid workspace before a session is created.

## Orchestration protocol

The bridge prepends one vendor-neutral orchestration protocol to every cycle prompt, so the harness follows the same sequence whatever model or CLI executes it: intake, plan, plan review, bounded delegation, smallest change, real verification, independent diff review, iterate until green, report only evidence. The roles are generic (`orchestrator`, `intake`, `planner`, `plan-reviewer`, `implementer`, `researcher`, `reviewer`, `tester`, `advisor`, `inspector`) and can be renamed in `harness.config.json`. Each role is bound to a model tier of the harness that actually runs the task, so subagents use models that harness really offers. Do not restate the protocol in the brief; the bridge already injected it.

## Tool names

The seven primary tools are `harness_execute`, `harness_status`, `harness_result`, `harness_inspect`, `harness_correct`, `harness_decision`, and `harness_stop`. The older `opencode_*` names remain as deprecated aliases and accept the same arguments.

## Jev Decision

Display the returned `Jev Decision` trace verbatim, exactly once per routing step, without rewriting or summarizing it. In pure mode there is no Jev trace; report provenance as `routing:unrouted` instead.

## Pending decisions

When the harness returns `decisions_required`, first check whether the answer follows from the brief and user instructions.

- If inferable: show the harness question plus the Codex answer with a brief reason, then send it with `harness_decision`.
- If it depends on a genuine user preference: ask through Codex native interactive choices with 2-3 concise options, recommended option first. The interface also offers free text. Wait for the user answer before calling `harness_decision`; never choose on behalf of the user.
- Never claim interactive controls appeared unless they did. If the interactive UI is unavailable, report this and keep the decision pending.
- If the user asks about the choices before answering, explain the trade-offs, keep the decision pending, re-offer the choices if needed, then forward the finally selected answer.
- Follow the global decision-timeout policy for unanswered user choices.

## Corrections

After a harness result arrives, verify it against the acceptance criteria. When criteria fail, send `harness_correct` with the failed criteria, evidence, and specific retests, then iterate until done or until a genuinely new decision is needed. Do not implement the correction directly in Codex.

## Final estimate

Show the final Jev Estimate once, with absolute token counts and no percentage. In pure mode no estimate exists; do not invent one.

## Blockers

If a required choice crosses the brief boundary or the bridge is blocked, stop and return the exact question and options. Do not guess and do not continue past it.
