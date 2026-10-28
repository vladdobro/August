---
name: context-dream
description: Manually invoked consolidation pass over the whole project-context/ knowledge base. Promotes lessons learned, builds per-domain decision logs, maps POS-id hotspots, merges duplicates into one owner route, normalizes drifting terminology, and prunes noise. Use only when the user explicitly asks to run context-dream (or "dream" / consolidate project-context); never trigger it automatically or from Step 6.
---

# CONTEXT DREAM SKILL

Step 6 (`update_project_context`) appends what one task changed; nothing ever reviews the knowledge base as a whole. This skill does that review. It re-reads every route, promotes durable knowledge into predictable sections, removes what no longer earns its place, and leaves agents with shorter, more accurate, more actionable context.

You edit `project-context/` directly. The user reviews the result via `git diff`, so every change must be justifiable from the diff plus your report.

<scope>
- Source: route `README.md` files under `project-context/` only. Ignore non-README files (e.g. `project-context/config/`).
- Never read task history (`.praxis/tasks/`), chat sessions, git log, `artifacts/`, or source code. Evidence for every edit must come from project-context itself.
- Never read or update `context-router.md`. Route splits create child routes declared in the parent sub-router only.
- Do not commit.
- No auto triggers, scheduling, or provisioning; this skill runs only on explicit request.
</scope>

<quality_rules>
- Observable facts only. Mark inferences as `inferred from [project-context/<route>/README.md]`.
- Never silently resolve contradictions: mark `[CONFLICT  -  verify before use]` and keep both versions on adjacent lines with their source routes.
- Every removal or merge needs evidence: a superseding fact (cite route + line text) or a duplicate owner (cite owner route). No evidence, no deletion.
- BM25 contract: one rule per line, declarative, key domain terms present; TL;DR bullets ≤ 25 words.
- Keep inline POS-ids on rules; they are evidence and hotspot data. Remove only bare POS-id lists that carry no conclusion.
- Move, never copy: when a line is promoted into Lessons Learned or Decisions, delete the original statement so the fact lives once.
- Respect route-declared protocols: if a README names its own update rule (`Update Trigger`, `Source of Truth`, "must use <skill>"), follow it. If that README says it is auto-provisioned or copied from a bundled source, do not edit it; list its findings under "Needs attention" in the report.
</quality_rules>

## What is NOT stored (noise filter)

Remove a line or paragraph when it matches one of these and carries no current rule:
1. One-off task details: what a single task did, file-by-file change narratives, investigation steps, "fixed in POS-x by changing y" with no lasting constraint.
2. Bare POS-id lists without a conclusion: `(POS-1, POS-2, POS-3)` lines, "see POS-x" with nothing else.
3. Changelog-style lines: "Added X", "Renamed Y", "Previously ..., now ..." history, version-by-version notes.

Before removing, extract any lasting rule the noise contains into one standalone line in the right section. A reversal with a reason is not noise: it becomes a RETIRED decision.

## Parallel subagents (default execution mode)

A dream touches every route; one agent reading them all serially is slow and overflows its context. Use parallel subagents wherever the work is independent. Run serially only when no subagent tool exists, or the knowledge base is under ~2000 lines total; say which mode you used in the report.

| Phase | Who | Parallel? |
|---|---|---|
| 1 Inventory | Main agent (scripts) + subagents for TL;DR/heading digests per route group | Yes |
| 2 Global plan | Main agent only: owner map, duplicates, terms, and conflicts need the whole picture | No |
| 3 Consolidation | One subagent per route group | Yes |
| 4 Verify | Main agent, or subagents per check group | Optional |
| 5 Report | Main agent merges fragments | No |

Rules:
- Launch all subagents of a phase in ONE message with multiple Agent calls, so they run concurrently. Wait for all before the next phase.
- Partition by files, never by concern: each route README belongs to exactly one subagent per phase. Two agents never edit the same file.
- Group routes by top-level domain (a parent route with all its children), then balance groups to roughly equal line counts. Aim for 3–8 groups; a route over ~1000 lines may get its own agent.
- Give each subagent: its exact file list, the scratch plan path, this SKILL.md path (scope, quality rules, noise filter, Phase 3 steps, section formats), and the report-fragment format from Phase 5.
- Subagents do not rebuild the global plan or edit routes outside their list. A cross-route need (owner change, new conflict, a fact that belongs in another group's route) is returned as a "Needs attention" item; the main agent applies it after all agents finish.
- Main agent merges fragments into one report, sums line counts, and runs Phase 4 over the whole tree.

## Phase 1: Inventory (scripted, no full reads)

Run from the repository root.

1. Route list with sizes: `find project-context -name README.md -exec wc -l {} + | sort -n`
2. Task ID prefix: the dominant `<PREFIX>-<digits>` token in project-context (`POS` in PraxisOS).
3. Hotspot counts (unique task IDs per route, then lines):
   ```bash
   for f in $(find project-context -name README.md); do
     printf '%s\t%s\t%s\n' "$(grep -oE 'POS-[0-9]+' "$f" | sort -u | wc -l | tr -d ' ')" "$(wc -l < "$f" | tr -d ' ')" "$f"
   done | sort -rn
   ```
   Aggregate per top-level domain (first path segment under `project-context/`) as the union of unique IDs across its routes.
4. Global overview: read every route's `## TL;DR` (use `read_context_route` mode `tldr` when Praxis MCP is available) and its heading list (`grep -n '^#' <file>`).

## Phase 2: Global plan (cross-route, before any edit)

Build these from the TL;DRs plus targeted `grep -rn` over project-context. Verify each entry by reading the matching lines in every route involved.

1. Owner map: concept → the one route that owns it. Owner = the route whose Purpose covers the concept; if two qualify, the more specific (deeper) route; a route that explicitly declares itself source of truth always wins.
2. Duplicate list: the same fact stated in 2+ routes → owner route + copies to replace with a link.
3. Term table: concept → canonical term → variants found (with routes). Include stale names such as old step numbers, renamed features, renamed files. Canonical = the term the owner route uses for the current behavior.
4. Conflict list: statements that disagree where project-context gives no superseding evidence.
5. Split candidates: routes already over ~1000 lines, or expected to cross it after Phase 3.

Write the plan to a scratch file; Phase 3 subagents read it instead of rebuilding it.

## Phase 3: Per-route consolidation

Run in parallel subagents per route group (see "Parallel subagents"). Each agent reads each of its route READMEs fully, then applies in this order:

1. Noise: apply the noise filter.
2. Duplicates: in non-owner routes, replace the copy with one line `- <short fact>: see project-context/<owner-route>/README.md`. In the owner route, keep the most complete version once. Never replace the owner's copy.
3. Terminology: rewrite variants to the canonical term. Record the canonical term in the owner route (see format).
4. Conflicts: mark per quality rules. Resolve only with evidence (a newer explicit statement such as "since POS-x", "supersedes", "RETIRED", or an owner route that declares itself source of truth) and say so in the report.
5. Decisions: collect choices that have rationale ("because", "instead of", "chosen over", "never X since", "RETIRED", "replaced", "supersedes") from prose, history narratives, and scattered sections into `## Decisions`. Keep the bare rule in Invariants/Constraints; the Decisions entry holds the why. A route that already has a dedicated decision section (e.g. `Retired Claims`, `Scope Decisions`) keeps it under its existing heading; append there, do not create a second log.
6. Lessons Learned: promote a statement only if it passes all three tests:
   - Reusable: changes how a future agent works in this domain.
   - Non-obvious: not a generic best practice ("write tests", "handle errors").
   - Backed by a concrete case with a task ID in project-context (bug root cause, failed approach, incident).
   Statements without a task ID stay where they are.
7. Size: if the README now exceeds ~1000 lines, split cohesive H2/H3 groups into child routes (`project-context/<route>/<child>/README.md`, same fractal structure with TL;DR), and declare each in the parent `## Child Routes` with a root-relative `Directory Path`.
8. TL;DR: update it so it reflects the consolidated route.

### Section formats and placement

Place new sections after `## Route-Specific Constraints` and before `## Child Routes`, in this order: Decisions, Lessons Learned, Canonical Terms. Create a section only when it has at least one entry.

```markdown
## Decisions
- <What was decided> — Why: <rationale from context> (POS-1234)
- RETIRED (POS-1100): <old decision> → Replaced by: <new decision> (POS-1234) — Why: <reason, or "reason not recorded in project-context">

## Lessons Learned
- <Imperative rule> → Why: <the concrete case and its root cause> → Source: POS-1234

## Canonical Terms
- <canonical term> — not: <variant 1>, <variant 2>
```

Example of a correct promotion. Before, buried at the end of a narrative paragraph:
`Future agents must never launch a Windows post-quit helper with Node's detached: true; use a spawnSync + Start-Process launcher instead.` (section header cites POS-2597)
After, in `## Lessons Learned`, original sentence deleted:
`- Launch Windows post-quit helpers via spawnSync + Start-Process, never Node detached: true → Why: DETACHED_PROCESS gave PowerShell no console, so the installer never ran → Source: POS-2597`

## Phase 4: Verify

- [ ] No README over ~1000 lines; every split child is declared in its parent with a root-relative `Directory Path`.
- [ ] Every `see project-context/...` link points to an existing README that still contains the fact.
- [ ] Every route still starts with `# <Title>` then `## TL;DR`.
- [ ] No empty Decisions / Lessons Learned / Canonical Terms sections.
- [ ] Every removed line is covered by a noise rule, a superseding fact, or a duplicate owner.
- [ ] Every conflict is marked, not resolved, unless evidence is cited.
- [ ] `context-router.md`, non-README files, and auto-provisioned routes are untouched.

## Phase 5: Report

End with this report and nothing else. Keep each line to one fact; omit empty sections.

```markdown
## Context Dream Report — <YYYY-MM-DD>
Scope: <N> routes, <lines before> → <lines after> lines
Mode: parallel (<K> subagents) | serial — reason: <no subagent tool | under ~2000 lines>

### Promoted (Lessons Learned)
- <route>: <rule> (POS-x)
### Decisions logged
- <route>: <n> decisions, <m> retired
### Merged (duplicates)
- <fact> → owner <route>; replaced in <routes>
### Removed
- <route>: <what> — reason: <noise rule # | superseded by <route/fact>>
### Terms normalized
- <canonical> ← <variants> (<routes>)
### Conflicts marked
- <route>: <topic> — <version A> vs <version B>
### Hotspots (unique task IDs)
| Rank | Domain / route | IDs | Lines | Note |
### Needs attention
- <items not editable here: auto-provisioned routes, missing referenced skills, splits deferred>
```

Hotspots are inferred from task-ID density: a frequently changed domain is a candidate for refactoring or tests, not proof of a defect.
