---
name: codex-x-opencode-mcp
description: Route every actionable Codex task through codex_x_opencode_mcp for execution, including small tasks, audits, research, code changes, and tests. Use whenever work needs OpenCode execution, decisions, or corrections.
---

# OpenCode Workflow

Codex owns intent, scope, architecture, requirements, constraints, and acceptance criteria. OpenCode executes. This skill changes routing and decision handling only.

## When to use

Use for every actionable task sent to OpenCode, including small tasks, audits, research, code changes, and tests.

Do not use for ordinary conversation, explanations, or when the user explicitly asks not to use OpenCode. Answer those directly without an execution task.

## MCP preflight

Before building a brief, confirm the `codex_x_opencode_mcp` connector is available in the current session.

- If unavailable, stop and explain the blocker transparently. Do not silently execute the work in Codex and do not claim routing happened.
- A skill cannot make an absent MCP appear.

## Codex-owned brief

Codex decides task objective, scope, architecture, constraints, and acceptance criteria before calling `opencode_execute`. The OpenCode planner only divides approved in-scope work into bounded assignments and picks configured agents. It must not change the objective, scope, architecture, or acceptance criteria.

Codex may read just enough context to write the brief and to verify the result. Execution itself belongs to OpenCode.

## workspace_root invariant

Every `opencode_execute` call must include `workspace_root` with the absolute active Codex workspace path. Never omit it and never fall back to another workspace when it is missing. The bridge rejects tasks without a valid workspace before a session is created.

## Jev Decision

Display the returned `Jev Decision` trace verbatim, exactly once per routing step, without rewriting or summarizing it.

## Pending decisions

When OpenCode returns `decisions_required`, first check whether the answer follows from the brief and user instructions.

- If inferable: show the OpenCode question plus the Codex answer with a brief reason, then send it with `opencode_decision`.
- If it depends on a genuine user preference: ask through Codex native interactive choices with 2-3 concise options, recommended option first. The interface also offers free text. Wait for the user answer before calling `opencode_decision`; never choose on behalf of the user.
- Never claim interactive controls appeared unless they did. If the interactive UI is unavailable, report this and keep the decision pending.
- If the user asks about the choices before answering, explain the trade-offs, keep the decision pending, re-offer the choices if needed, then forward the finally selected answer.
- Follow the global decision-timeout policy for unanswered user choices.

## Corrections

After an OpenCode result arrives, verify it against the acceptance criteria. When criteria fail, send `opencode_correct` with the failed criteria, evidence, and specific retests, then iterate until done or until a genuinely new decision is needed. Do not implement the correction directly in Codex.

## Final estimate

Show the final Jev Estimate once, with absolute token counts and no percentage.

## Blockers

If a required choice crosses the brief boundary or the bridge is blocked, stop and return the exact question and options. Do not guess and do not continue past it.
