---
name: subagent-orchestration
description: Decide whether and how to delegate through the subagent tool, then steer, recover, and verify children. Use when splitting work across subagents, choosing a child's agent, model, effort, permissions, workspace, or context, or managing existing children.
---

# Subagent orchestration

This skill does not authorize delegation. Delegate only when the user or your current instructions allow it, and stay within the user's scope. The tool enforces permissions, deduplication, and recovery. This skill covers the choices it leaves to you. If you are a child, read "Delegate from a child" before making calls.

## Decide whether to delegate

Do small tasks, dependent steps, and work that needs your conversation yourself. Delegate when parts can run in parallel, when a broad search would fill your context, when a review needs an agent without your assumptions, or when an experiment needs its own checkout.

## Choose agent, model, effort, and permissions

Call `list` when choosing a custom agent, model, or effort, or when unsure what is available. The main parent's list shows agents and their permission ceilings, configured models and their thinking levels, and available skills, MCP tools, and hooks. Pick from that output, and don't assume a provider or model name.

- `Explore` and `Plan` are read-only. `general-purpose` has full access, including `bash`. Custom agents can fall between them.
- Use the model and effort the user asked for. Otherwise, choose them per launch by task difficulty, such as `thinking: "low"` to find a file and `"high"` to trace a race. `model: "current"` uses your model. Omit both for the defaults. An unsupported explicit thinking level fails the spawn.
- Grant the least access that works. `tools` narrows the built-in tools and `disabledTools` removes some. `trust: "untrusted"` starts with nothing, so pass exact `tools`, `skills`, `mcpTools`, and `hooks` lists.
- Trusted children see parent skills by name and load them on demand. Use `disabledSkills` or `skills: []` to remove skills the task doesn't need.

A child keeps its resolved model, effort, and permissions for `send`, `steer`, and recovery. Settings changes affect only new children. Spawn a new child to change the model or effort.

## Write a self-contained task

A fresh child sees its role instructions, the project instruction files, and `task`, but not your conversation. Include the goal and known facts, the files it owns and must leave alone, the result format and evidence to return, and the user's constraints. Children can't ask the user, so say whether to stop and report or proceed on a stated assumption when a decision is missing.

## Run work in parallel

Spawn independent children in one turn and keep working. Results arrive as follow-up messages. Call `wait` only when you need a result now. Each `wait` lasts at most 60 seconds and doesn't cancel the child.

In a shared checkout, give each child separate files. Run tasks that change the same file in sequence, or put one in a worktree. Settle a shared interface before the children start.

`maxConcurrent` is one pool for the whole tree, and running ancestors use slots too. A `spawn` or `send` over the limit fails instead of queuing.

## Fit the pattern to the task

Explore, plan, implement, review, and verify is a common order for large changes. Use only the steps that pay off. Do a small fix yourself or give it to one child. Send `Explore` children with one question each into an unfamiliar area.

Get a plan from `Plan` when the design has real choices. Ask the user only about material decisions that the instructions and context leave open.

For a broad change, split implementation by file ownership, then ask a fresh read-only child to review. Read-only agents have no `bash`, so put the diff, or the changed files and base commit, in its task. A task holds at most 50,000 characters. Pass on findings, not transcripts.

## Choose a shared checkout or a worktree

`isolation: "shared"` is the default. The child sees your uncommitted edits, and its edits appear in your checkout at once. Use it for reads and for edits with clear ownership.

`isolation: "worktree"` creates a branch and checkout at `HEAD` under `.pi/subagents/worktrees/`. It needs a trusted Git project with a commit. The checkout has committed files only, so a child that needs your uncommitted or untracked files must share your checkout.

The plugin never merges, commits, or deletes a worktree, even after `cancel` or `close`. When the child finishes, `status` shows its branch and base commit. Review that diff and apply the wanted changes without overwriting edits in your checkout. Remove the branch and checkout only as a separate step that the user's instructions allow.

## Choose fresh or forked context

Use the default `context: "fresh"` when the task text carries enough. It costs less and keeps a review free of your assumptions. Use `context: "fork"` when the child needs the conversation itself. A fork copies your model-visible conversation. The child keeps its own instructions and permissions, and imported tool calls never run again. Still state its job and ownership in `task`.

## Track children by ID and request key

`spawn` returns a persistent child ID for all later actions. IDs can have gaps and aren't list positions.

Give each `spawn`, `send`, and `steer` a stable `requestId` that names the work, such as `auth-review-2`. After an uncertain outcome, repeat the call with the same key and arguments to get the original run. A new key starts new work, and the same key with different arguments fails.

- `steer` adds direction to a running task after its current model request or tool round.
- `send` gives an idle child a new task in the same conversation, including after a failure or cancellation.
- `resume` recovers unfinished work after a reload or pause. It doesn't restart completed, failed, cancelled, or closed tasks.
- `cancel` stops the active task. `close` ends the child for good and keeps its history.

## Recover without repeating uncertain writes

After a crash or reload of the same parent chat, children keep their IDs, conversations, settings, and pending results. Call `status` first. A task paused on model scope, model availability, project trust, or capabilities continues after you restore access and call `resume`.

Interrupted reads replay. An interrupted write, edit, command, or MCP call returns an interruption result instead, because its effect may already exist. Find the call in the `transcript`. If the child hasn't checked its effect, inspect the files, Git, or the external system. Pass what you found with `steer` or `send`. Don't repeat the operation until you know its effect.

## Delegate from a child

A child with the `subagent` tool manages only its direct children and has every action except `resume`. Its `list` shows agents and its children, with no model, thinking-level, or capability catalog.

Nested `spawn` accepts only `agent`, `task`, `requestId`, `model`, `thinking`, `trust`, `context`, `tools`, `skills`, `mcpTools`, and `hooks`. There are no `disabled*` fields, `mcpServers`, or `isolation`. Omitted `model` and `thinking` use the definition or your saved values. Nested children always use your checkout.

Capability fields take explicit lists. Omitted selections inherit permitted capabilities for trusted children. Untrusted children default to empty allowlists. To exclude skills, pass an explicit `skills` list, including `[]` for none, or use a definition with `disabledSkills`. A descendant never gets tools, trust, or permissions its parent lacks. The tool is absent at `maxDepth`.

Nested results arrive only through your `wait` and `result` calls. Collect them before you finish, because finishing cancels unfinished descendants.

## Handle questions and check results

The main parent owns the user conversation. Answer a child's question from the user's instructions or context when they settle it, and ask the user only about material decisions left open. Reply with `steer` to a running child or `send` to a finished one. A child returns open questions to its parent.

Treat a child's report as a claim. Check it in proportion to the risk before you call the work done: read the diff, run the tests, or open the cited code. Read the `transcript` when a result looks wrong. Report what you verified and what you didn't.
