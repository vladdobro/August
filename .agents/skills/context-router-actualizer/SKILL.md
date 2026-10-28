---
name: context-router-actualizer
description: Use this skill to actualize context-router.md routes and project-context/ documentation from the task's own git diff by updating behavioral rules, business logic, and architectural constraints; small updates are written by the main agent, larger ones by Sonnet writers with per-route plan slices.
---

# CONTEXT ROUTER ACTUALIZATION SKILL

You have been triggered to update the project's documentation because a recent task modified the fundamental business logic, data structures, or architectural rules of the application — or produced important findings (discovered technical constraints, bug root causes with systemic implications, architectural behaviors) that agents must know to work effectively on this project.

Your goal is to ensure the `project-context/` documentation and `context-router.md` accurately reflect the *current* behavioral rules and important technical knowledge of the system.

Follow these steps strictly. The `update_project_context` response already carries the Step 1 scope rule and STOP gate; when you arrive from it, continue at Step 2 with the scope you defined.

## Roles
- Main agent (the agent that did the task): defines the scope, plans every route change, makes every structural decision, runs Steps 1, 2, 4, 5 and 6, and on the fast path also writes the READMEs.
- Writer subagents (Sonnet): only when the fast path does not apply; one per affected route, all spawned in one message so they run in parallel; each executes only its own plan slice.
- No Agent or Workflow call happens outside Step 3 (and Step 5 re-dispatch), and none at all on the fast path.

## Step 1: Define the Scope from the Task's Diff and Run the STOP Gate
1. The scope is this task's own changes, not the whole working tree:
   - uncommitted changes: `git status --porcelain`, `git diff` and `git diff --cached`;
   - commits made for this task on the current branch that are not on the default branch: `git log --oneline <default-branch>..HEAD`, then `git diff <default-branch>...HEAD -- <files>`.
   Find the default branch with `git symbolic-ref --short refs/remotes/origin/HEAD`; when that fails, use `main` (or `master`).
2. Keep only the files this task touched. Other agents may work in the same tree: exclude their unrelated changes and never document or revert them. When you cannot tell whether a change is yours, leave it out and name it in the Step 6 summary.
3. List the in-scope files (`git diff --stat -- <files>`) and read the changed code itself. Commit messages are not a scope signal: a commit titled as docs can carry a feature.
4. Code beats spec: when the task spec or the existing docs disagree with the code, document the code and note the disagreement in one line. A spec requirement the code does not implement is written as "required (not yet implemented at <short sha>)" or left out.
5. Map each in-scope change to the route(s) it affects with `search_project_context` and `read_context_route`; note candidate new routes.
6. STOP gate — classify the result:
   1. An existing route changed (e.g., a new required field, a module works differently, a discovered architectural constraint or important system behavior)? -> Step 2.
   2. A completely NEW route is needed (a new business entity or technical module)? -> Step 2, then Step 4.
   3. A discovery worth preserving — a bug root cause with architectural implications, a technical constraint, or a system behavior that agents must know to avoid mistakes? -> Step 2 for the affected route.
   4. Only a trivial refactor, pure style change, or minor bug fix with no architectural implications and no findings worth preserving for future agents? -> STOP. No actualization is needed.

## Step 2: Plan per Route and Choose the Path (main agent)
Do not call the Agent or Workflow tool in this step. You already hold the diff, the code and the routes; a subagent would have to rediscover them.

Fast path: when at most 2 routes are affected and no route is created, removed or moved, you edit the READMEs yourself in Step 3 and spawn no writer. Why: the plan is already final text, so a writer would only paste it while adding spawn and handoff cost. Otherwise use writers.

Superseded-lines rule (both paths): before adding a fact, find every existing line in the route that states an older or conflicting version of it (search the route for the entity, field, value or behavior). Each such line is rewritten or removed in the same edit. Appending a new fact next to the old one leaves two versions; Yeast found six contradicting lines in one route after append-only writers (YST-149).

Context gaps input: the `update_project_context` response may end with a `CONTEXT GAPS` list — queries for which agents found nothing (empty search, missing route or section, unknown graph entity), recorded locally in `.praxis/analytics/context_gaps.jsonl`. When a listed gap falls inside this task's diff, make the planned route edit answer it (use the gap's own words in the TL;DR or an `Also known as` bullet so the next search hits) and mention the gap in the slice; afterwards resolve it in Settings > Knowledge graph > Context gaps. Gaps outside the diff are not scope for this task.

Every planned edit follows `.agents/skills/context-router-actualizer/FORMAT.md` (Rules 1-15, glossary route, required sections); do not restate its rules here. In particular: keep the TL;DR current, including the `Also known as` bullet (Rules 2 and 11); one canonical name per entity, a `## Components` section and one Rule 14 verb per relationship line (Rules 12-14); traverse and update child routes as needed (Rule 5).

On the fast path, decide the exact edits here, including the superseded lines, and go to Step 3. Write plan slices only for writers.

Plan slice template — one self-contained slice per affected route; a writer must not need to search, explore or choose an approach:

```
### Slice: <route>
- Target path: project-context/<route>/README.md
- Action: create | update
- Changes (final text, not goals):
  - Add to <section>: "<new line>"
  - Replace in <section>: "<old line>" -> "<new line>"
- Superseded lines (remove or rewrite): "<existing line>" -> remove | "<rewritten line>"; write "none found" only after checking the route
- Prune: <section or line> (stale content, FORMAT.md Rule 8)
- Key source files: <repo-relative paths>, plus any short code fact the writer needs (writers do not read code)
- Components entities (Rule 13): <canonical name> (<kind>): <fact>
- Format contract: read .agents/skills/context-router-actualizer/FORMAT.md before editing
- Hands-off: Child Routes declarations, other route files, context-router.md and project-context/glossary/README.md (the main agent owns them in Step 4)
```

Large plans: when the slices together exceed about 100 lines or there are more than 3 writers, write the plan to one Markdown file outside `project-context/` (the session scratchpad directory, or the OS temp directory when there is none), one `### Slice: <route>` heading per route. Each writer prompt then carries the file path and its slice heading instead of the slice text.

## Step 3: Write the Routes
Fast path: apply the Step 2 edits yourself, following FORMAT.md, then go to Step 4.

Otherwise spawn one Sonnet writer per affected route, all in a single message so they run in parallel. Each writer receives only its own slice (inline, or the plan file path plus its slice heading).

Writer rules (include them in every writer prompt):
- Edit only the target README named in the slice; re-read the file right before editing and make targeted edits.
- Read only FORMAT.md, the target README and, when given, the plan file; do not call `search_project_context`, `read_context_route`, `query_project_graph` or any other search tool, and do not read source code or other routes.
- Make no structural decisions: no new routes, splits, moves or Child Routes edits.
- Apply every superseded-line change in the slice. If a named old line is not in the file, or the slice is ambiguous or contradicts the file, stop and return the question to the main agent instead of guessing.
- Report back the lines added, changed and pruned.

## Step 4: Integrate the Route Tree (main agent)
1. Update `project-context/glossary/README.md` for every new canonical term or alias (FORMAT.md "Glossary Route").
2. Declare every new child route in its parent README's Child Routes section, and remove the declaration of a removed or moved route (FORMAT.md Rules 5-6).
3. Apply cross-route facts that no single writer owned as small edits.
4. Evaluate the context router impact below.

**Fast-path check — answer before opening any file:**
Did you create a new `.md` file under `project-context/` that did not exist before this task?
- **YES (new route created)** → Open `context-router.md` and follow the steps below.
- **NO (only updated existing route files)** → Skip the rest of Step 4 and proceed directly to Step 5.

Open `context-router.md` at the repository root: `{project_root}/context-router.md`.
> ⚠️ Path warning: `context-router.md` lives at the **repository root**, not inside `project-context/`. The correct path is `{project_root}/context-router.md`. Never attempt `project-context/context-router.md` or any path relative to the context directory — that path does not exist and will produce a "File does not exist" error.

For NEW routes:
1. Rule Check: ONLY add a new route entry if you introduced a completely NEW distinct Route (business entity or technical module).
2. Action: If a new route was created, add a new entry under the `# Core Business Routes (Behavioral Rules)` section using this format:
   ```markdown
   ## [Route Name] Route
   [1-2 sentences explaining the rules governed by this route]
   Directory Path: project-context/[route-name]/README.md
   ```
3. Add a row to the `Route Selection Guide` table mapping relevant task keywords to the new route.
4. Strict Prohibition: NEVER add routes for individual UI components, helper functions, or specific code files to context-router.md. Only top-level business entities or technical modules qualify.

For UPDATED routes:
5. Do NOT add or update `Key files:` or `Critical rules:` in context-router.md — those details live exclusively in the route's README.md. context-router.md stays lean: name, description, and Directory Path only.
6. If new keywords or task types now apply to the route, update the `Route Selection Guide` table.

## Step 5: Format & Constraints Check (main agent)
Before finalizing your updates to `context-router.md` and the route READMEs, verify:
- [ ] There is absolutely NO bold formatting anywhere in the context-router.md file.
- [ ] The file remains clear, concise, and top-level.
- [ ] Every route listed has a matching directory with a README.md sub-router on disk.
- [ ] Every route entry in context-router.md contains ONLY a name, a 1-2 sentence description, and a `Directory Path:` pointing to the README.md file. No `Key files:` or `Critical rules:` — those belong exclusively in the route's README.md.
- [ ] The Route Selection Guide table covers all routes and any new keywords introduced by the changes.
- [ ] The AI Agent Quick Start Protocol, Route Selection Guide, terminology section, hierarchical routing principle, and project terminology sections are intact and unmodified (unless the change specifically requires updating them).
- [ ] Only this task's diff was documented; other agents' changes were left out (Step 1).
- [ ] Every planned change from Step 2 landed, including every named superseded line; nothing outside the plan was changed.
- [ ] No two lines in a changed route state conflicting facts: re-read each changed route and rewrite or remove the older line.
- [ ] Every changed route README follows FORMAT.md: TL;DR (Rule 2), Directory Paths from the repository root (Rule 6), standalone searchable lines (Rule 7), stale content pruned (Rule 8), no orphaned files (Rule 9).
- [ ] The mandatory `about` and `PRD` routes exist (FORMAT.md Rule 10); create a missing one now.
- [ ] Every changed route TL;DR has one sourced `Also known as` bullet (Rule 11).
- [ ] Each entity has one canonical name across routes; alternative spellings appear only in `Also known as` or the glossary (Rule 12).
- [ ] Routes naming services, components, technologies, or integrations have a `## Components` section (Rule 13).
- [ ] Relationships between entities use the Rule 14 verbs, one relationship per line.
- [ ] `project-context/glossary/README.md` has a line for every new canonical term and alias.
- [ ] Secret-pattern grep on every changed README returns no prose hits (Rule 15):
      `grep -nEi 'bearer [a-z0-9]|(secret|password|api-?key)[ ,:"'"'"'=]|AKIA[0-9A-Z]|(^|[^a-z0-9])sk-[a-z0-9]|ghp_|xox[bp]-' <changed README files>`

Fix small issues yourself. For a larger issue on the writer path, re-dispatch that route's writer with a concrete correction (exact lines to change), not a goal.

## Step 6: Completion
Provide a brief summary to the user: the diff scope you documented, the path taken (fast path or N writers), which route rules were updated or created, any change left out because its owner was unclear, and whether new routes were added to the context router.

# Scaling Guidelines

## When to split a route into child routes
- The route's README.md exceeds ~1000 lines because it documents multiple distinct rule sets.
- Two sub-areas have invariants that are independent or contradictory.
- A sub-area has its own lifecycle (e.g., can be created/modified/deleted independently of the parent route's rules).

## When NOT to split
- The route is small and all rules fit in one readable README.md.
- A child route would have only 1-2 invariants with no potential for further growth.
- The split would create routes that always need to be read together anyway.

## The fractal contract
Every sub-router (README.md) at any depth follows the same structure: Purpose, Core Concepts, Invariants, Constraints, and optional Child Routes. This is what makes the system scale infinitely — there is no special format for depth 1 vs depth 5. The root context-router.md never needs to change when a route splits into children; the split happens inside the sub-router.

## Where growth happens
- context-router.md (root) stays concise: only top-level routes. It rarely changes.
- Sub-routers absorb complexity: when a feature grows, its sub-router declares child routes.
- Leaf routes stay simple: no Child Routes section, just business rules.

# Terminology Reference

When writing or updating documentation, use these terms consistently:
- Context Router: The root `context-router.md` file providing a high-level map of the entire project.
- Route: A specific directory representing a business or technical module. Contains a README.md sub-router.
- Sub-router: The `README.md` file inside any route directory. Acts like the root context router but scoped to its route. Can declare child routes, creating infinite depth.
- Hierarchical routing: Router -> Route (Dir) -> Sub-router (README.md) -> Child Route (Dir) -> Child Sub-router (README.md), infinitely recursive.

# Reference Structure

## context-router.md required sections (in order)

```
# context-router.md Purpose
  - Root router / compass definition
  - "Implementation is the map, router is the compass"
  - Trigger rule

# AI Agent Quick Start Protocol
  - 6-step numbered protocol for agents to follow before coding
  - Emphasizes: read this file -> identify routes -> read TL;DR -> read deeper if needed -> find files -> implement

# Route Selection Guide
  - Markdown table mapping task keywords to route names
  - Helps agents skip irrelevant routes without reading them

# context-router.md terminology
  - Context Router  (this root file)
  - Route           (directory = business/technical module node)
  - Sub-router      (README.md inside a route directory)

# Hierarchical routing principle
  - Recursive tree, no depth limit
  - Router -> Route (Dir) -> Sub-router (README.md) -> Child Route -> ...

# Project terminology
  - Application vs Agent/Copilot/LLM definitions

# Mandatory Execution Rules
  - Start from this file
  - Never hallucinate — read sub-routers
  - Traverse recursively
  - [PROJECT SPECIFIC RULE]
  - Load selectively
  - UPDATE TRIGGER (CRITICAL)

# Project context map (Routes)
  ## About (MANDATORY)
     Directory Path: project-context/about/README.md
  ## PRD (MANDATORY)
     Directory Path: project-context/PRD/README.md

# Core Business Routes (Behavioral Rules)
  ## Route A
     Directory Path: project-context/route-a/README.md
  ## Route B
     Directory Path: project-context/route-b/README.md
  ## AI Skills and Agents
     Directory Path: .agents/skills/

# Rules for this file (context-router.md)
```

Route README required sections and Directory Path examples: see FORMAT.md "Reference Structure".

## File system structure produced by context-router

```
project-root/
|-- context-router.md              <- Root Router (compass)
|
|-- project-context/
|   |-- config/
|   |
|   |-- routes/
|       |-- about/
|       |   |-- README.md          <- MANDATORY: project overview (name, description, audience, stack)
|       |-- PRD/
|       |   |-- README.md          <- MANDATORY: product requirements document (vision, audience, behaviors)
|       |-- glossary/
|       |   |-- README.md          <- DEFAULT: alias -> canonical name map (FORMAT.md "Glossary Route")
|       |-- route-a/
|       |   |-- README.md          <- Sub-router for Route A
|       |   |-- child-route-1/
|       |   |   |-- README.md      <- Child sub-router (same contract)
|       |   |-- child-route-2/
|       |       |-- README.md
|       |
|       |-- route-b/
|       |   |-- README.md          <- Sub-router for Route B
|       |
|       |-- route-c/
|           |-- README.md          <- Sub-router for Route C
|
|-- .agents/
    |-- skills/                    <- AI Skills and Agents route
        |-- context-router-actualizer/   <- SKILL.md + FORMAT.md (route format contract)
        |-- context-router-initializer/
```

## Directory Path rule in sub-routers

All Directory Paths MUST be relative to the repository root. This applies equally inside context-router.md and inside any sub-router README.md.

In context-router.md (root router) — points directly to the README.md file:
```
## Route A
Directory Path: project-context/route-a/README.md
```

In project-context/route-a/README.md (sub-router declaring child routes) — points to the child route directory:
```
## Child Route 1
Directory Path: project-context/route-a/child-route-1/

## Child Route 2
Directory Path: project-context/route-a/child-route-2/
```

NEVER use relative paths like `Directory Path: child-route-1/` in a sub-router.

## Traversal flow (how an agent reads context)

```
1. Agent receives task
        |
        v
2. Read context-router.md (root router)
        |
        v
3. Identify which route(s) the task touches
        |
        v
4. Navigate to route directory -> Read README.md (sub-router)
        |
        v
5. Sub-router declares child routes? --YES--> Read child README.md
        |                                          |
        NO                                         v
        |                                    Repeat until leaf
        v
6. Agent has full context -> Execute task
```

# Examples

- `examples/context-router-taskpilot.md` - A fully realized context-router from a production project (Python Slack bot with Jira integration). Use as reference for real-world route naming, project-specific rules, and proper structure.
- `examples/context-router-example/context-router.md` - A generic template with placeholders, matching the AWESOME structure. Use as the starting point for new projects.
- `examples/scaling-example.md` - Shows how the same routing system scales from a 2-route tiny project to a 3+ level deep project without changing any structural rules. Demonstrates the fractal contract, when to split, and when not to.