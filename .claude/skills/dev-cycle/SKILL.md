---
name: dev-cycle
description: Runs a Sales360 SmartCore task through the full T-shaped engineering loop — plan, implement, review, test — using this project's specialist subagents (planner, developer/telephony-specialist/crm-specialist, reviewer, tester). Use for any feature or bugfix that should go through planning and review before being called done, not for trivial one-line edits.
---

# dev-cycle

Orchestrate the `planner` → implementer → `reviewer` → `tester` loop for a Sales360 SmartCore task, using the project's T-shaped subagents in `.claude/agents/`. You (the main agent) drive this — read each subagent's output and decide the next step yourself; don't just relay prompts blindly between them.

## Steps

1. **Get the task.** Use `$ARGUMENTS` as the task description. If empty, ask the user what to build or fix.

2. **Plan.** Spawn `planner` (foreground — the next step depends on its output) with the task description. It will return a scope classification (Python backend / websocket-service voice pipeline / Zoho-CRM / mixed), a numbered file-by-file plan, relevant risks, and any open questions.

3. **Resolve open questions.** If the plan raised a genuine decision only the user can make (a design choice, a new env var, a schema change), ask them via `AskUserQuestion` before proceeding. Otherwise, briefly state the plan to the user and continue — don't block on approval for routine work.

4. **Implement.** Based on the planner's scope classification, spawn the matching implementer in foreground:
   - `developer` for general Python backend / FastAPI work.
   - `telephony-specialist` for anything inside the websocket-service real-time voice pipeline.
   - `crm-specialist` for Zoho/CRM-specific work.
   - For mixed-scope tasks, run the relevant implementers in sequence (not parallel, since later steps may depend on earlier ones), passing each its relevant slice of the plan.
   Pass the full plan text, not just the original task description — the implementer should not have to re-derive what the planner already worked out.

5. **Verify the diff yourself.** After implementation, run `git status` / `git diff` and actually read what changed — don't take the implementer's summary on faith before review.

6. **Review.** Spawn `reviewer` in foreground against the current diff.

7. **Address findings.** For each CONFIRMED finding: either send it back to the same implementer for one fix-up round (don't loop indefinitely — one round, then report what's left), or note it to the user as a known/accepted limitation. Don't silently drop findings.

8. **Test.** Spawn `tester` in foreground, pointed at the files that changed, to add/extend tests and actually run them.

9. **Summarize** to the user: what changed (files, one line each), review findings resolved vs. left open and why, and test results (pass/fail, command used). Do not commit or push unless the user explicitly asks.

## Notes

- Each subagent call starts cold — always pass it the concrete context it needs (file paths, the plan, the diff) rather than assuming it remembers prior steps.
- Don't skip straight to implementation for anything beyond a trivial one-line fix — the point of this skill is that planning and review happen before the task is called done.
- If a step's subagent surfaces a reason to change scope (e.g. `developer` says the task is actually telephony-pipeline work), re-route rather than forcing it through the wrong specialist.
