# Pi subagents

Named subagents for Pi, with parallel execution, saved conversations, and crash recovery. The parent handles user questions. Children share one status line, return collapsed results, and expose transcripts on demand.

This is a standalone package, separate from pi-qol. It targets Pi 1.4.x and Node.js 22.19 or later. It has not been published to npm.

## Install

```bash
pi install git:github.com/thgilciffart/pi-subagents
```

Reload Pi, then ask the parent to delegate a task. `/agents` or Ctrl+Alt+A opens the child picker. `/agents <id>` opens a transcript.

## Built-in agents

The built-in roles follow [Claude Code's subagent roles](https://code.claude.com/docs/en/sub-agents#built-in-subagents):

- `Explore` finds files, traces code paths, and reports evidence. It cannot edit files or run commands.
- `Plan` researches requirements and returns an implementation plan. It cannot edit files or run commands.
- `general-purpose` handles research, implementation, commands, and verification.

All three can delegate within their saved permissions and depth limit. They inherit the parent model and thinking level unless a launch, definition, or setting overrides them. Their instructions are written for Pi; Claude Code's private prompts and helper agents are not included.

These names replace `scout`, `reviewer`, and `worker` for new launches. Saved children retain their original names, instructions, and permissions. Custom definitions can still use those names.

## Delegate a task

The parent calls the `subagent` tool:

```json
{
	"action": "spawn",
	"agent": "general-purpose",
	"trust": "trusted",
	"task": "Update the login form. Own src/login.ts and preserve other edits.",
	"context": "fork",
	"isolation": "worktree",
	"requestId": "login-form"
}
```

Children start with fresh context unless `context: "fork"` copies the parent's model-visible chat. Forks retain the child's own instructions and permissions. Imported tool calls provide context and never execute again. Automatic context compaction is enabled, and the full transcript remains available.

Steering uses `action: "steer"`, the child `id`, and a `task` message. It reaches the child after the current model request or tool round. `send` adds a new task to an idle child in the same conversation. Steering and follow-ups retain the child's saved model, trust policy, and capabilities.

Use a stable `requestId` for `spawn`, `send`, and `steer`. Retrying the same request returns its original run. Reusing a key with different arguments fails.

## Delegate from a child

A child with the `subagent` tool can create and manage its own direct children. The main parent can inspect and control the whole tree. Child calls support `list`, `spawn`, `send`, `steer`, `status`, `wait`, `result`, `transcript`, `cancel`, and `close`.

Nested `spawn` accepts `agent`, `task`, `requestId`, `model`, `thinking`, `trust`, `tools`, `skills`, `mcpTools`, `hooks`, and `context`. Capability fields accept exact name lists. Omitted selections inherit permitted capabilities from the immediate parent for trusted children. Untrusted children default to empty allowlists. Definitions can narrow those selections further.

Descendants cannot gain tools, capabilities, trust, or a permission profile that their immediate parent lacks. A read-only Explore agent can delegate to general-purpose, but that descendant remains read-only. All generations share one concurrency limit. Running ancestors occupy slots too; a spawn over the limit fails instead of waiting for capacity.

`maxDepth` defaults to three child layers below the main parent. Set it to `1` to disable nested delegation. The `subagent` tool is absent at the depth limit and can also be removed with `disabledTools: [subagent]`.

Each nested child has a saved ID, owner ID, owner task number, and depth. Stable request keys prevent duplicate creation after tool replay. Results return through the spawning child's tool calls; they do not create a second automatic notification in the main chat. Wait for needed results before finishing. Completion, failure, cancellation, or closure cancels unfinished descendants, and recovery preserves that intent.

Nested children use their immediate parent's working directory and worktree. They cannot choose another checkout. `context: "fork"` copies that parent's model-visible history while retaining the descendant's own instructions and narrower tools. Questions pass back through the spawning agent to the main parent.

## Choose trust and permissions

The parent chooses `trust` at launch. Agent definitions can provide a default. Omission means `trusted`.

- `trusted` inherits the named agent's tools and permitted parent capabilities. Exclusion lists can narrow them.
- `untrusted` starts with no tools, skills, MCP tools, or hooks. The parent supplies exact allowlists. An explicitly untrusted agent definition can provide those lists.

For read-only delegation with an explicit tool list:

```json
{
	"action": "spawn",
	"agent": "Explore",
	"trust": "untrusted",
	"tools": ["read", "grep", "find", "ls"],
	"task": "Trace the login flow and return file references.",
	"requestId": "login-trace"
}
```

Untrusted children reject `inherit` capability selectors and broad `mcpServers` selection. Named exclusions alone grant no access. Switching a trusted definition to untrusted at launch does not reuse its inherited defaults.

Both modes resolve to a saved allowlist. The plugin checks that list before model requests, tool execution, lifecycle hooks, and recovery. Parent configuration changes do not widen an existing child. Older saved children retain their existing tool set as a trusted policy.

Trust never expands the named agent's permission ceiling:

| Profile | Built-in tools | Built-in agents |
| --- | --- | --- |
| `read-only` | `read`, `grep`, `find`, `ls`, `subagent` | `Explore`, `Plan` |
| `edit` | Read tools, `edit`, `write` | Custom definitions |
| `full` | Edit tools and `bash` | `general-purpose` |

A trusted Explore agent remains read-only. An untrusted child can use only explicitly allowed tools within its profile. Tool profiles and trust policies are not operating-system sandboxes. File reads can access paths allowed by their tools, and shell commands run with the Pi process's permissions.

## Select capabilities

`subagent list` shows definitions, configured models, parent skills, available MCP tools, and registered child hooks.

| Field | Behavior |
| --- | --- |
| `tools` | Exact built-in tool list within the definition's ceiling. Untrusted launches default to none. |
| `disabledTools` | Built-in tool names to exclude. |
| `skills` | Trusted default: `inherit`, loaded on demand. A list preloads named skills. `[]` disables all. |
| `disabledSkills` | Skill names to exclude. |
| `mcpTools` | Trusted default: `inherit` permitted parent tools. A list selects exact names. `[]` disables all. |
| `disabledMcpTools` | MCP tool names to exclude. |
| `mcpServers` | Trusted children only. Selects current tools from named parent servers when `mcpTools` is omitted. |
| `hooks` | Trusted default: inherit compatible registered child adapters. A list selects names. `[]` disables all. |
| `disabledHooks` | Child hook names to exclude. |

For untrusted children, `skills`, `mcpTools`, and `hooks` accept explicit lists only and default to `[]`. Explicit capability selections add the restricted `skill_read` or `mcp` bridge as needed. An empty built-in `tools` list does not disable separately selected capabilities.

Launch values replace corresponding definition defaults. Exclusions apply after selection. An explicit `mcpTools` value takes precedence over server selection. An explicit launch `mcpServers` list replaces the definition's MCP selection. Unknown explicit capability names fail; exclusion names may cover capabilities not currently installed.

Inherited skills appear as names and descriptions. The child loads instructions and supporting files through `skill_read`. That reader rejects paths and symbolic links outside the selected skill directory, including in a worktree. Skills marked `disable-model-invocation: true` require an explicit list. Skill text cannot grant tools, and skill scripts require existing shell permission.

MCP calls use exact saved tool names and validated arguments. Read-only annotations are required for `read-only` and `edit` profiles. Mutating or unclassified tools require `full`. Each child opens its own connection using Pi's existing server configuration, environment expansion, OAuth store, and provider authentication. Stdio servers start in the child working directory. New logins return an error to the parent instead of opening a child prompt.

## Define an agent

Definitions are Markdown files with YAML frontmatter. The plugin loads built-ins, then user definitions in `~/.pi/agent/agents/`, then trusted project definitions in `.pi/agents/`. Higher scopes replace names. Invalid or duplicate definitions block that name instead of falling back to broader permissions.

```yaml
---
name: limited-reviewer
description: Review assigned files without commands or inherited capabilities.
trust: untrusted
permissions: read-only
tools: [read, grep, find, ls]
model: current
thinking: high
---
Review the assigned files. Return actionable findings with file references.
```

`name`, `description`, and body instructions identify the agent. The filename supplies `name` when omitted. Names use one to 64 letters, digits, underscores, or hyphens and begin with a letter or digit.

Definitions also accept the capability fields above, `context: fresh|fork`, `isolation: shared|worktree`, and supported Pi `thinking` levels. `tools` accepts a YAML list or comma-separated names. When `permissions` is omitted, tools determine the profile, otherwise it defaults to `read-only`. Omitting `tools` on an untrusted definition defaults to no tools; the parent can supply a list within its profile. An explicit definition list sets the maximum built-in tool set, and `tools: []` sets that maximum to none. External runners, arbitrary child extensions, symbolic-link definitions, and `.chain.md` files are excluded.

Model selection follows the launch value, definition, global subagent settings, then parent model. `current` resolves to the parent model. Thinking follows the same order, using a supported parent level when inherited. Unsupported explicit settings fail. The resolved model must remain in the parent's configured scope. Configured providers, authentication, and virtual-model routing use the parent Pi runtime.

Examples: [implementer](examples/agents/implementer.md), [command runner](examples/agents/runner.md), and [untrusted reviewer](examples/agents/limited-reviewer.md).

## Use hooks

Trusted parent extensions register child adapters with `registerChildHook`, exported from this extension's `index.ts`. Trusted children inherit compatible adapters. Untrusted children need an explicit `hooks` list. Native parent event handlers are not loaded unchanged into Durable children.

An adapter declares `name`, `version`, `permissions`, `project`, and `replay`. Its declared minimum profile must fit the child. Project adapters require project trust. Change `version` when callback behavior changes; recovery rejects mismatched versions.

| Callback | Trigger | Failure behavior |
| --- | --- | --- |
| `beforeTool` | Before a child tool call | Returning `{ block: reason }` or throwing blocks execution. |
| `afterTool` | After a child tool call | Can replace visible `output` and `isError`, without adding tools or changing run control. |
| `onStart` | Before each task's first submission | Blocks the task before model dispatch. |
| `onResume` | Recovery of an admitted unfinished task | Blocks recovery before model or tool dispatch. |
| `onStop` | Completion, failure, or cancellation | Retains the result and records errors. |
| `onClose` | Deliberate child closure | Retains closure and records errors. |

Callbacks receive the child ID, working directory, profile, and abort signal. Lifecycle callbacks also receive the run, task, status, output, and error. Each lifecycle event has a ten-second deadline. Callbacks must honor their signal. Terminal status can appear while stop hooks run; a follow-up waits for them.

Hook checkpoints record starts and completed decisions. `replay: safe` permits recovery of an interrupted callback. `unsafe` records an interruption instead of repeating an uncertain effect. Completed lifecycle callbacks do not repeat after reload. An interrupted safe resume checkpoint counts as that restart's resume event. Unsubmitted tasks recover their start hook without a resume event. Terminal tasks never receive resume events.

Examples: [block environment-file edits](examples/hooks/protect-env.ts) and [check the checkout before start or recovery](examples/hooks/lifecycle.ts).

## Isolate files in a worktree

`isolation: "worktree"` requires a trusted Git project with a commit at `HEAD`. It creates a dedicated branch and checkout under `.pi/subagents/worktrees/`. Git's local exclude file keeps that directory out of the parent index. The child keeps the parent's relative working directory inside the repository.

Worktrees contain committed files; parent modifications and untracked files are absent. Follow-ups and recovery reuse the saved branch, checkout, and changes. File tools reject paths outside that checkout. Shell commands start inside it, but have no operating-system sandbox.

A missing checkout, changed branch, unexpected pending checkout contents, or external lock fails without replacement or reset. Cancellation and closure keep the branch and files. Merging, committing, and cleanup are explicit parent operations. Plugin-managed Git operations disable checkout hooks.

## Recover saved work

Recovery starts when Pi opens the same saved parent chat, including after `/reload`. The parent can call `subagent` with `action: "resume"`, or you can run `/agents resume`. Starting another chat does not run the original chat's children. There is no independent worker while Pi is closed.

Children retain their IDs, conversations, tasks, models, settings, allowlists, ownership, and pending results. Completed, failed, cancelled, and closed tasks do not automatically restart. A cancelled or failed child needs an explicit `send` for a new task; a closed child rejects new work.

Saved-parent runtime data lives at `<Pi agent directory>/subagents/sessions/<parent hash>/`, outside the repository. SQLite stores task checkpoints and conversations. A separate SQLite lock prevents two processes from owning the same parent. Ephemeral parents keep child runtime data in memory and lose it on extension reload or process exit.

Starting Pi from your home directory uses `~/.pi/agent` normally. The storage check rejects runtime data inside a Git checkout, including when Pi starts in a subdirectory of that checkout.

Safe file reads can replay after interruption. Writes, edits, commands, and all MCP calls return interruption results when their outcome is uncertain. Effects may already exist, so inspect them before another operation. Recovery checks saved ownership, permission ceilings, allowlists, project trust, worktree identity, and current capability availability before dispatch.

Result receipts remain pending until the native parent transcript records them. A restart reuses saved receipts to prevent duplicate automatic delivery. Explicit `result` calls can still read an earlier result. Request deduplication and receipts do not guarantee exactly-once external effects, model billing, or parent reasoning.

## Tools and commands

| `subagent` action | Required fields | Behavior |
| --- | --- | --- |
| `list` | None | Definitions, models, and capability catalog. |
| `spawn` | `agent`, `task` | Start a child and return its persistent ID. |
| `send` | `id`, `task` | New task in an idle child's conversation. |
| `steer` | `id`, `task` | Direction at the active task's next boundary. |
| `resume` | Optional `id` | Recover eligible work; retry parked active tasks. |
| `status` | Optional `id` | Current run, trust, tools, capabilities, and workspace. |
| `wait` | `id` | Bounded wait, with optional `timeoutMs`. |
| `result` | `id` | Read a result; its receipt is acknowledged when persisted by the parent. |
| `transcript` | `id` | Up to 50,000 characters of saved transcript entries. |
| `cancel` | `id` | Save cancellation intent and abort. |
| `close` | `id` | Save closure, abort active work, and retain history. |

Tasks contain one to 50,000 characters. `wait` defaults to 30 seconds and accepts one to 60,000 milliseconds. Aborting a wait does not cancel the child. Token and cost totals cover the child conversation.

`/agents` or Ctrl+Alt+A opens the picker. `/agents <id>` opens the transcript. `/agents list` inspects definitions, `/agents config` edits settings, `/agents resume [id]` recovers work, and `/agents stop [id]` cancels one or all active children. Numbers prefixed with `#` are persistent child IDs, not list positions. IDs can have gaps because Pi Durable shares its record counter with other records. Nested entries show their parent ID. Outside the terminal UI, inspection uses text notifications.

## Status indicator

While children run, `Subagents N · Ctrl+Alt+A` appears on the right of the first footer line. The count includes nested children. The footer retains the working directory, branch, session name, token usage, cost, context usage, model, and other extension statuses. Narrow terminals shorten text to fit.

This placement uses Pi's custom-footer slot. If another extension supplies your footer, set `indicatorPosition` to `"status"` to use the ordinary extension-status row instead. Change settings with `/agents config`. Ctrl+Alt+A opens the picker in either mode. Alt+Left retains Pi's word-navigation binding.

## Settings

Global defaults live at `<Pi agent directory>/subagents/settings.json`:

```json
{
	"maxConcurrent": 4,
	"maxDepth": 3,
	"indicatorPosition": "footer-right",
	"maxTurns": 20,
	"timeoutSeconds": 300,
	"model": "current",
	"thinking": "current",
	"context": "fresh",
	"isolation": "shared"
}
```

`maxConcurrent` accepts 1 to 16 active tasks across the whole tree. `maxDepth` accepts 1 to 8 child layers. `indicatorPosition` accepts `footer-right` or `status`. `maxTurns` accepts 1 to 100 model-request attempts, including compaction and recovery. `timeoutSeconds` accepts 1 to 3,600 and includes downtime. New tasks use current settings; existing tasks retain their saved settings. Automatic provider retries are disabled.

## Compatibility and development

The extension uses Pi Durable and Chord 1.4.0. Durable supplies saved conversations, task checkpoints, ownership, cancellation, and replay policies. The plugin adds parent identity, allowlists, request keys, lifecycle records, and delivery receipts. This avoids a separate recovery engine around SDK child sessions.

Pi coding-agent extensions and Durable extensions have different APIs. Built-in tools and registered child adapters bridge that boundary. The parent model runtime preserves configured providers and authentication. MCP connections reuse the installed host's configuration, transport, OAuth, and result-conversion code. These compatibility bridges are specific to Pi 1.4 and require testing before an upgrade. No live OAuth login or paid model request is part of the test suite.

The evaluation started with the [Pi Durable article](https://earendil.com/posts/pi-durable/) and inspected the [upstream README and source](https://github.com/earendil-works/pi/tree/9ee7586a95f5e653ae279c3b8f20938faf3639a1/packages/durable), its recovery and background-subagent examples, and the article's coding and vacation demos. The implementation reuses agent discovery, configuration, UI, and tests from the earlier prototype. Runtime paths and imports remain separate from pi-qol.

```bash
npm ci
npm run check
npm test
npm pack
```

Tests use local model fixtures, a local MCP server, a real SDK parent, and processes killed at recovery checkpoints. The Pi 1.4 dependency tree has known npm audit advisories; inspect `npm audit` before distribution.
