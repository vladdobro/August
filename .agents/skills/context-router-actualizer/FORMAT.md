# Route README Format Contract

This file is the route README format contract of the context-router-actualizer skill. Whoever writes or updates a route README under `project-context/` (the main agent or a writer subagent) reads this file first; Step 5 of SKILL.md checks it.

# Format Rules

1. Every route README states the current business rules, required elements, and constraints for its route.
2. TL;DR: every route README starts with a `## TL;DR` section immediately after the `#` heading and reflects the current state. If the README lacks a TL;DR, add one. Each bullet is a single declarative sentence of ≤ 25 words containing the key domain terms agents would search for. No compound sentences joining unrelated facts. No prose paragraphs. Cover: the most critical rules, key data structures or storage details, main workflow or constraint, and key implementation files.
3. Focus on the "why" and "what must be done": explain the structural rules and architectural decisions.
4. Do not duplicate code: no function signatures, interface definitions, or line-by-line implementations. Code is the map; documentation is the compass.
5. Child routes are traversed and updated recursively: the routing system is a tree with no depth limit.
6. Directory Path rule: every `Directory Path` in any router or sub-router is relative to the repository root, never relative to the current file. A child route inside `route-a` is `Directory Path: project-context/route-a/child-route/`, not `Directory Path: child-route/`.
7. BM25 searchability contract: `search_project_context` scores individual lines using BM25 with field boosting (headings > body), and `read_context_route` in tldr mode reads the TL;DR first. Every behavioral rule, invariant, and business constraint occupies its own dedicated line. Multi-rule sentences and prose paragraphs bury key terms and cause recall failures. The format of the content IS the retrieval contract.
8. Prune stale content: remove historical detail, resolved issue narratives, and redundant explanations that dilute term frequency for current rules. Every line is either a current behavioral rule or essential architectural context.
9. No orphaned files: every non-README.md file or subdirectory inside a route directory is declared as a child route in that route's README.md. Convert an undeclared file into a proper child route (its own directory with a README.md) or remove it; agents never discover loose files through traversal.
10. Mandatory routes: `project-context/about/README.md` (project overview: name, description, target audience, tech stack, value proposition) and `project-context/PRD/README.md` (vision, audience, behaviors; template `.agents/skills/context-router-initializer/templates/prd-route-template.md`) exist in every project.
11. Also known as: every route README TL;DR contains one bullet `- Also known as: <comma-separated alternative names>.` listing synonyms, abbreviations, business names, UI labels, and code identifiers for the route's main concept, so queries worded differently from the route text still match. Aliases come only from this project's code, docs, existing routes, or the glossary route; never invent terms.
12. One canonical name per entity: every service, component, technology, and integration is called by exactly one name throughout the route and across routes, preferring the code name (`search_project_context`, `ApiManager`, `fs-bridge`) over prose, class, or file spellings. Alternative spellings appear once, in the `Also known as` bullet or the glossary line, never in the body. Technologies carry no vendor prefix: `Claude Code`, `SQS`, `CloudFront`, not `Anthropic Claude Code` or `Amazon SQS`. Several spellings of one thing produce duplicate nodes in the knowledge graph.
13. Components section: every route that names at least one service, component, technology, or integration has a `## Components` section with one line per entity: `- <canonical name> (<kind>): <one-sentence fact>`. Kind is one of `app`, `service`, `mcp-server`, `cli`, `worker`, `script`, `module`, `component`, `class`, `hook`, `tool`, `skill`, `technology`, `integration`, `datastore`. The first six kinds are runnable units; `module`, `component`, `class`, `hook`, `tool`, and `skill` are parts of a unit and name it in the fact (`part of Praxis Local API`). Routes without such entities omit the section. The section is machine-readable input for knowledge graph extraction: runnable units become Service nodes, parts become Component nodes.
14. Relationship verbs: a dependency or interaction between two entities is one line with one verb from this vocabulary, both entities by canonical name: `uses` (a technology or datastore), `depends on` (another unit or part), `calls` (a runtime call to a unit or endpoint; the graph folds it into DEPENDS_ON), `integrates with` (an external system), `implements` (a business rule), `affects` (a decision on an entity), `governs` (a role or rule over a unit), `part of` (a part inside a unit). Example: `GraphBuildIndicator depends on GET /api/graph/status and polls it while extraction runs.` Other wordings are allowed in prose, but a relationship an agent should find has its own line with the verb.
15. Secret-scanner safety: secret scanners and pre-commit hooks match credential patterns in context files. Avoid these shapes in prose, they cause false positives that block commits:
    - `bearer` followed by a letter or digit: write "auth token" or "caller token".
    - `secret` followed by a space, comma, colon, quote, or `=`: write "credential scan" instead of "secret scan", or use the resource name as one word.
    - `password` followed by a space, comma, colon, quote, or `=`: write "credential" or "passphrase".
    - `api-key` or `apiKey` followed by a space, comma, colon, quote, or `=`: write "API credential" or name the config field by its code path.
    - Literal key prefixes (`AKIA`, `sk-`, `ghp_`, `xoxb-`, `xoxp-`): never write them followed by key-like characters, even as examples.
    This rule applies to prose only; code file paths and identifier names that contain these words stay as-is when they are the canonical name of a function or config key.

# Glossary Route

`project-context/glossary/README.md` maps every alias to its canonical name (Rules 11 and 12).

- One line per term: `canonical | aliases | kind | route`.
- `aliases` is a comma-separated list; `kind` is a Rule 13 kind or `concept`, `view`, `file`, or `status`; `route` is the route path without `project-context/` and `/README.md` (the `read_context_route` value).
- Add a line when a task introduces a new canonical term; extend the aliases of an existing line instead of adding a duplicate.
- Create the glossary route when it is missing and the task introduces a canonical term.

# Reference Structure

## Route README.md required sections (in order)

```
# [Route Name] Domain

## TL;DR
- [Single declarative sentence ≤ 25 words with key domain terms]
- [One searchable rule per bullet — no compound sentences]
- [Each bullet independently findable by BM25 keyword search]
- Also known as: [synonyms, abbreviations, business names, code identifiers]
- [Key files: list relevant source files]

[One-sentence domain description]

## Purpose
## Core Concepts
## Components (required when the route names services, components, technologies or integrations; Rule 13)
## Invariants
## Route-Specific Constraints
## Child Routes (optional — only if sub-areas exist)
```

## Directory Path examples

In context-router.md (root router), the path points directly to the README.md file:
```
## Route A
Directory Path: project-context/route-a/README.md
```

In project-context/route-a/README.md (sub-router declaring child routes), the path points to the child route directory:
```
## Child Route 1
Directory Path: project-context/route-a/child-route-1/

## Child Route 2
Directory Path: project-context/route-a/child-route-2/
```

Never use relative paths like `Directory Path: child-route-1/` in a sub-router.
