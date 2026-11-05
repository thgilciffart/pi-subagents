---
name: subagent-orchestration
description: Decide whether and how to delegate work through the subagent tool, then steer, recover, and verify the children. Use when splitting a task across subagents, choosing a child's agent, model, effort, permissions, workspace, or context, or managing children that already exist.
---

# Subagent orchestration

This skill helps you use the `subagent` tool well. It does not authorize delegation. Delegate when the user or the instructions you already follow allow it, and stay inside the scope the user set. The tool enforces permissions, request deduplication, and recovery rules. These notes cover the choices it leaves to you.

The guidance below describes the main parent's API. If you are a child, read **Delegate from a child** for the narrower API before making calls.

## Decide whether to delegate

Do the work yourself when it is small, when it depends on the conversation you already hold, or when each step needs the result of the one before. A child starts without your reasoning, so a short task can cost more to brief than to do.

Delegation helps in these cases:

- The work splits into parts that don't depend on each other and can run at the same time.
- A broad search or long investigation would fill your context with material you need only as a summary.
- A review should come from an agent that doesn't share your assumptions.
- An experimental edit should happen in a separate checkout.

## Choose the agent, model, effort, and permissions

Run `subagent` with `action: "list"` when choosing a custom agent, model, or effort, or when you are unsure what is available. The main parent's list returns agent definitions and permission ceilings, configured models and supported thinking levels, and available skills, MCP tools, and hooks. Choose from that output. Don't assume a provider or model name.

- Pick the named agent by the permissions the task needs. The built-in `Explore` and `Plan` agents are read-only. `general-purpose` has full permissions, including `bash`. Custom definitions in the `list` output can fall between them.
- Use the model or effort the user specified. Otherwise, choose `model` and `thinking` for each launch based on the task's difficulty. Finding a configuration entry point suits `thinking: "low"`. Tracing a race condition or reviewing a subtle change suits `"high"`. `model: "current"` uses your model. Omit both fields to use the definition or settings defaults. An explicit thinking level that the selected model doesn't support fails the spawn.
- Give the child the least access that lets it finish. Pass `tools` for a narrower built-in tool list, or `disabledTools` to remove one, such as `bash` for an edit that needs no commands. Pass `trust: "untrusted"` with exact `tools`, `skills`, `mcpTools`, and `hooks` lists when the child should start with nothing.
- Trusted children see parent skills by name and load them on demand. Pass `disabledSkills` to remove named skills, or `skills: []` to remove them all, when the task doesn't need them.

Each child saves its resolved model, thinking level, and permissions. `send`, `steer`, and recovery reuse them, and settings changes affect only new children. To run the same work with a different model or effort, spawn a new child.

## Write a self-contained task

A fresh child knows its role instructions, the project instruction files, and the `task` text. It doesn't see your conversation. Put these in the task:

- The goal, with the facts you already found: file paths, symbols, error text, and decisions the user made.
- What the child owns: the files or directories it may change and what it must leave alone. For read-only work, state the question to answer.
- The expected result: its format, the evidence to include, such as file references, commands run, and test output, and when to stop.
- The user's constraints, such as no commits or no new dependencies.

Children don't talk to the user. They return questions and blockers in their answer. Say what the child should do when a decision is missing: stop and report, or proceed on an assumption you state.

## Run independent work in parallel

Spawn independent children one after another in the same turn, then continue your own work. Their results arrive automatically as follow-up messages. Call `wait` only when your next step needs a result now. One `wait` call lasts at most 60 seconds, and ending a wait doesn't cancel the child.

In a shared checkout, give parallel children separate files to own. If two tasks must change the same file, run them in sequence, or move one into a worktree.

If parallel parts depend on a shared interface, settle it first, yourself or with one owner. Give the other children that interface as fixed input.

The `maxConcurrent` setting caps running tasks across the whole tree, including nested children. The limit is one pool for the whole tree. A child's own task and its running ancestors already use slots from it. A `spawn` or `send` over the limit fails instead of queuing. When that happens, wait for a child to finish or do the work yourself.

## Fit the pattern to the task

For larger changes, a common sequence is explore, plan, implement, review, and verify. Use only the steps that earn their cost:

- For a small fix, do it yourself, or give one `general-purpose` child the fix and the checks to run.
- For an unfamiliar area, start with one or more `Explore` children, each answering a separate question.
- For a change with real design choices, ask `Plan` for a plan and read it. Resolve questions from the user's instructions and existing context. Ask the user about material decisions those sources don't settle.
- For a broad change, split the implementation by file ownership. Then ask a fresh read-only child to review it. Put the diff, or the changed files and base commit, in its task. Read-only agents have no `bash` to generate a Git diff. Keep the task within its 50,000-character limit.

Pass the findings that matter from one step to the next, not whole transcripts.

## Choose a shared checkout or a worktree

`isolation: "shared"` is the default. The child works in your checkout, sees your uncommitted edits, and its edits appear there at once. Use it for read-only work and for edits with clear ownership. Name the files other agents own so editing children can avoid conflicts.

`isolation: "worktree"` creates a dedicated branch and checkout at the current `HEAD` under `.pi/subagents/worktrees/`. It requires a trusted Git project with at least one commit. The checkout has committed files only. Your uncommitted changes and untracked files are absent, so a child that needs them must use the shared checkout. Use a worktree for experimental edits or edits that would conflict with other work.

The plugin doesn't merge, commit, or delete worktrees, and cancellation or closure keeps the branch and files. When a worktree child finishes, `status` shows its branch and base commit. Review that diff and bring the wanted changes into your checkout without overwriting edits that are already there. Remove the branch and checkout as a separate, explicit step, and only when the user's instructions allow it.

## Choose fresh or forked context

`context: "fresh"` is the default. Use it when the task text can carry what the child needs. A fresh child reads less input and doesn't inherit your assumptions, which matters for reviews.

Use `context: "fork"` when the child needs the conversation itself, such as requirements the user gave across many turns. A fork copies your model-visible conversation. The child keeps its own instructions and permissions, and imported tool calls never run again. Still state the child's job and ownership in `task`, because the copied history doesn't say which part belongs to the child.

## Track children by ID and request key

`spawn` returns a persistent child ID. Use that ID for `send`, `steer`, `status`, `wait`, `result`, `transcript`, `cancel`, and `close`. IDs can have gaps and are not positions in a list.

Give each `spawn`, `send`, and `steer` a stable `requestId` that names the work, such as `auth-trace` or `auth-review-2`. If the outcome of a call is uncertain, repeat it with the same `requestId` and the same arguments. The tool returns the original run instead of starting a duplicate. A new key starts new work, and reusing a key with different arguments fails.

- `steer` adds direction to a running task. The child reads it after its current model request or tool round. Use it to narrow scope or add a fact.
- `send` gives an idle child a new task in the same conversation. Use it for follow-ups that build on what the child already learned, or for a new attempt after a failure or cancellation.
- `resume` recovers unfinished work after a reload or a paused recovery. It doesn't restart completed, failed, cancelled, or closed tasks.
- `cancel` stops the active task. `close` ends the child permanently and keeps its history.

## Recover without repeating uncertain writes

After a crash or reload of the same parent chat, children keep their IDs, conversations, settings, and pending results. Call `status` before acting. A task paused on model scope, model availability, project trust, or capabilities continues after you restore that access and call `resume`.

Interrupted reads replay. An interrupted write, edit, command, or MCP call returns an interruption result instead, because its effects may already exist. Read the child's `transcript` to find the interrupted call. If the child hasn't already checked its effect, inspect the files, the Git state, or the external system. Then `steer` a running child or `send` to a finished one with what you found. Don't repeat the operation yourself until you know its effect.

## Delegate from a child

A child with the `subagent` tool can manage its own direct children with every action except `resume`. Nested `list` shows agent definitions and your children, but no model, thinking-level, or capability catalog.

Nested `spawn` accepts only `agent`, `task`, `requestId`, `model`, `thinking`, `trust`, `context`, `tools`, `skills`, `mcpTools`, and `hooks`. There are no `disabled*` fields, `mcpServers`, or `isolation`. Nested children always use their immediate parent's checkout. Omitted `model` and `thinking` use the definition's values or your own saved values.

The `tools`, `skills`, `mcpTools`, and `hooks` fields take explicit lists. Omitted selections inherit permitted capabilities from the immediate parent for trusted children. Untrusted children default to empty allowlists. To exclude skills, pass an explicit `skills` list, including `[]` to exclude all of them, or choose a definition with `disabledSkills`. A descendant never receives tools, trust, or a permission profile that its parent lacks. The `maxDepth` setting limits nesting, and the tool is absent at that depth.

Nested results don't arrive automatically. They return only through the parent's `wait` and `result` calls. Collect the results you need before you finish, because finishing cancels unfinished descendants.

## Handle questions and check results

The main parent owns the user conversation. When a child reports a question, answer it from the user's instructions or existing context when those settle it. Ask the user only about material decisions that remain unresolved. Pass the answer with `send` to a finished child or `steer` to a running one. If you are a child, return unresolved questions to your parent.

Treat a child's report as a claim. Before you call the work done, check it in proportion to the risk: read the diff, run the relevant tests, or open the cited code. Read the `transcript` when a result is surprising or incomplete. Report what you verified and what you didn't.
