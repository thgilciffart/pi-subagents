import { resolveSelection, resolveTools, resolveTrust } from './policy.ts';
import { capabilityPrompt, capabilityTools, ParentCapabilities } from './capabilities.ts';
import { NativeMcpBridge } from './mcp.ts';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { convertToLlm, getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { discoverAgents, THINKING_LEVELS, type Thinking } from './agents.ts';
import { readSubagentSettings, writeSubagentSettings } from './config.ts';
import { parentRuntime, SubagentRuntime, isRunning, type RunSnapshot, type SavedChild } from './runtime.ts';
import { openStore } from './storage.ts';
import { parentReceipts, RESULT_MESSAGE } from './receipts.ts';
import { compactText, formatSubagentStatus, oneLine, runSummary, SubagentInspector } from './ui.ts';

const Params = Type.Object({
  action: Type.Union(['list', 'spawn', 'send', 'steer', 'resume', 'status', 'wait', 'result', 'transcript', 'cancel', 'close'].map(value => Type.Literal(value))),
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 50000, description: 'Self-contained task and context. Children use fresh context unless context fork is selected.' })),
  id: Type.Optional(Type.String({ description: 'Persistent child ID.' })),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Stable key for spawn, send, or steer. Reuse it after an uncertain tool outcome to prevent duplicates.' })),
  model: Type.Optional(Type.String({ description: 'current or configured provider/model-id.' })),
  thinking: Type.Optional(Type.Union(THINKING_LEVELS.map(value => Type.Literal(value)))),
  trust: Type.Optional(Type.Union([Type.Literal('trusted'), Type.Literal('untrusted')], { description: 'trusted inherits permitted capabilities. untrusted starts with no tools or capabilities and requires exact allowlists. Neither exceeds the named profile.' })),
  disabledTools: Type.Optional(Type.Array(Type.String(), { description: 'Built-in tools to exclude within the named profile.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'A narrower subset of the definition tools.' })),
  skills: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Array(Type.String())], { description: 'Default inherit: parent skills available on demand. A list preloads only named skills; [] disables all skills.' })),
  disabledSkills: Type.Optional(Type.Array(Type.String(), { description: 'Parent skill names to exclude from the resolved selection. Overrides the agent definition exclusions.' })),
  mcpTools: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Array(Type.String())], { description: 'Default inherit: permitted parent MCP tools. A list selects exact names; [] disables inheritance.' })),
  disabledMcpTools: Type.Optional(Type.Array(Type.String(), { description: 'Inherited MCP tool names to exclude.' })),
  mcpServers: Type.Optional(Type.Array(Type.String(), { description: 'Select current tools from these parent servers. Read-only and edit profiles select read-only tools.' })),
  hooks: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Array(Type.String())], { description: 'Default inherit: compatible trusted child hook adapters. A list selects names; [] disables all.' })),
  disabledHooks: Type.Optional(Type.Array(Type.String(), { description: 'Inherited child hook names to exclude.' })),
  context: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('fork')], { description: 'Fresh task context or a copy of the parent model-visible conversation with child permissions.' })),
  isolation: Type.Optional(Type.Union([Type.Literal('shared'), Type.Literal('worktree')], { description: 'Use the shared checkout or a dedicated branch at current HEAD.' })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })),
});
type Details = { summary: string; runs?: RunSnapshot[]; receipts?: string[] };
const clip = (text: string, limit = 12000) => text.length <= limit ? text : text.slice(0, limit) + '\n[Truncated. Use subagent transcript or /agents <id>.]';
const fingerprint = (params: Static<typeof Params>) => JSON.stringify([params.action, params.id, params.agent, params.task, params.model, params.thinking, params.tools, params.isolation, params.context, params.skills, params.mcpTools, params.mcpServers, params.hooks, ...(params.disabledSkills === undefined ? [] : [{ disabledSkills: params.disabledSkills }]), ...(params.disabledMcpTools === undefined ? [] : [{ disabledMcpTools: params.disabledMcpTools }]), ...(params.disabledHooks === undefined ? [] : [{ disabledHooks: params.disabledHooks }]), ...(params.trust === undefined ? [] : [{ trust: params.trust }]), ...(params.disabledTools === undefined ? [] : [{ disabledTools: params.disabledTools }])]);

export default function subagents(pi: ExtensionAPI, options: {
  agentDir?: string; configPath?: string;
  openStore?: typeof openStore;
  onRuntime?: (runtime: SubagentRuntime) => void;
} = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const configPath = options.configPath ?? join(agentDir, 'subagents', 'settings.json');
  let ctx: ExtensionContext | undefined;
  let runtime: SubagentRuntime | undefined;
  let capabilities: ParentCapabilities | undefined;
  let sessionId: string | undefined;
  let ready: Promise<void> = Promise.resolve();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const queued = new Set<string>();
  const reading = new Set<string>();
  let generation = 0;

  function report(error: unknown): void { ctx?.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
  function changed(): void {
    if (!runtime || !ctx) return;
    const owner = runtime;
    void owner.list().then(runs => { if (runtime === owner) ctx?.ui.setStatus('pi-subagents', formatSubagentStatus(runs)); }).catch(report);
    noticeTimer ??= setTimeout(() => { noticeTimer = undefined; void flush().catch(report); }, 50);
    noticeTimer.unref();
  }
  async function flush(): Promise<void> {
    const owner = runtime, context = ctx, epoch = generation;
    if (!owner || !context || stopped) return;
    await owner.acknowledge(parentReceipts(context));
    if (!context.isIdle()) return;
    const pending = (await owner.pending()).filter(run => !queued.has(run.receipt) && !reading.has(run.receipt));
    if (owner !== runtime || epoch !== generation || stopped || context.signal?.aborted || !pending.length) return;
    for (const run of pending) queued.add(run.receipt);
    pi.sendMessage({ customType: RESULT_MESSAGE, display: true,
      content: pending.map(run => `${runSummary(run)}\n${clip(run.output || run.error || '')}`).join('\n\n'),
      details: { summary: pending.map(run => `${run.agent} ${run.status}`).join(', '), runs: pending, receipts: pending.map(run => run.receipt) } satisfies Details,
    }, { triggerTurn: true, deliverAs: 'followUp' });
    // The outbox stays pending until the receipt appears in the parent's saved transcript.
  }
  async function reset(context?: ExtensionContext): Promise<void> {
    generation++; stopped = true;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = undefined; queued.clear(); reading.clear();
    const old = runtime; runtime = undefined;
    ctx?.ui.setStatus('pi-subagents', undefined);
    await old?.dispose();
    ctx = context; sessionId = context?.sessionManager.getSessionId();
    if (!context) return;
    const models = parentRuntime(context);
    const store = await (options.openStore ?? openStore)(agentDir, context.sessionManager.getSessionFile(), sessionId!, context.cwd);
    capabilities = new ParentCapabilities(pi, () => ctx!, new NativeMcpBridge(pi, () => ctx!, agentDir));
    runtime = await SubagentRuntime.open(store, { capabilities, parentId: sessionId!, cwd: context.cwd, models,
      allow: child => allow(child, ctx!), changed, error: report });
    options.onRuntime?.(runtime);
    await runtime.acknowledge(parentReceipts(context));
    stopped = (await runtime.state()).notificationsPaused;
    await runtime.resume();
    changed();
  }
  async function use(context: ExtensionContext): Promise<SubagentRuntime> {
    await ready;
    if (sessionId !== context.sessionManager.getSessionId() || !runtime) { ready = reset(context); await ready; }
    ctx = context;
    if (!runtime) throw new Error('Subagent runtime unavailable.');
    return runtime;
  }
  function allow(child: SavedChild, context: ExtensionContext): void {
    if (child.projectTrusted && !context.isProjectTrusted()) throw new Error('Project trust is required to resume this child.');
    if (context.scopedModels.length && !context.scopedModels.some(item => `${item.model.provider}/${item.model.id}` === child.model)) throw new Error('The saved model is outside the parent session model scope.');
    const split = child.model.indexOf('/');
    const model = context.modelRegistry.find(child.model.slice(0, split), child.model.slice(split + 1));
    if (!model) throw new Error(`Configured model unavailable: ${child.model}.`);
    if (!getSupportedThinkingLevels(model).includes(child.thinking)) throw new Error('The saved thinking level is no longer supported.');
  }
  const definitions = (context: ExtensionContext) => discoverAgents(join(agentDir, 'agents'), context.isProjectTrusted() ? join(context.cwd, '.pi', 'agents') : undefined);

  async function spawn(owner: SubagentRuntime, params: Static<typeof Params>, context: ExtensionContext, requestId: string): Promise<RunSnapshot> {
    if (!params.agent || !params.task?.trim()) throw new Error('spawn requires agent and task.');
    const prior = await owner.request(requestId, fingerprint(params));
    if (prior) return prior;
    const [{ agents, errors }, settings] = await Promise.all([definitions(context), readSubagentSettings(configPath)]);
    const definition = agents.find(agent => agent.name === params.agent);
    if (!definition) throw new Error(`Unknown or invalid agent: ${params.agent}. ${errors.join('\n')}`);
    const selected = params.model ?? definition.model ?? settings.model;
    const split = selected.indexOf('/');
    const model = selected === 'current' ? context.model : context.modelRegistry.find(selected.slice(0, split), selected.slice(split + 1));
    if (!model) throw new Error(`Configured model unavailable: ${selected}.`);
    if (context.scopedModels.length && !context.scopedModels.some(item => item.model.provider === model.provider && item.model.id === model.id)) throw new Error('The selected model is outside the parent session model scope.');
    const explicit = params.thinking ?? definition.thinking ?? (settings.thinking === 'current' ? undefined : settings.thinking);
    const levels = getSupportedThinkingLevels(model);
    if (explicit && !levels.includes(explicit)) throw new Error(`Thinking level ${explicit} is not supported by ${model.provider}/${model.id}.`);
    const inherited = context.thinkingLevel ?? pi.getThinkingLevel();
    const thinking: Thinking = explicit ?? (levels.includes(inherited) ? inherited : levels[0] ?? 'off');
    const trust = resolveTrust(params.trust ?? definition.trust);
    const tools = resolveTools(definition, trust, params.tools, params.disabledTools ?? definition.disabledTools);
    const selection = resolveSelection(trust, definition, params);
    const selectedCapabilities = await capabilities!.select(selection, definition.permissions);
    tools.push(...capabilityTools(selectedCapabilities));
    const contextFiles = context.isProjectTrusted() ? loadProjectContextFiles({ cwd: context.cwd, agentDir }) : [];
    const isolation = params.isolation ?? definition.isolation ?? settings.isolation;
    if (isolation === 'worktree' && !context.isProjectTrusted()) throw new Error('Project trust is required to create a child worktree.');
    const instructions = `You are the ${definition.name} subagent. Your parent owns the user conversation.
Work only on the assigned task. Return questions and blockers to the parent in your answer.
Other agents may share this checkout. Preserve their edits. Never repeat an interrupted write or command without checking its effects.
Your trust policy is ${trust}. Your permission profile is ${definition.permissions}. Available tools: ${tools.join(', ') || 'none'}.
\n${definition.prompt}\n\n${contextFiles.map(file => `Project instructions from ${file.path}:\n${file.content}`).join('\n\n')}\n\n${capabilityPrompt(selectedCapabilities)}`;
    const contextMode = params.context ?? definition.context ?? settings.context;
    const history = contextMode === 'fork' ? convertToLlm(context.sessionManager.buildSessionProjection().messages) : undefined;
    return owner.spawn({ definition, trust, capabilities: selectedCapabilities, task: params.task, tools, settings, model: `${model.provider}/${model.id}`, thinking,
      instructions, isolation, context: contextMode, history, forkParentLeaf: contextMode === 'fork' ? context.sessionManager.getLeafId() ?? undefined : undefined, projectTrusted: [...selectedCapabilities.skills, ...selectedCapabilities.mcpTools, ...selectedCapabilities.hooks].some(item => item.project) || isolation === 'worktree' || contextFiles.length > 0 || definition.source.startsWith(join(context.cwd, '.pi')) }, requestId, fingerprint(params));
  }

  pi.on('session_start', (_event, context) => { ready = ready.catch(() => {}).then(() => reset(context)); return ready; });
  pi.on('session_shutdown', () => { ready = ready.catch(() => {}).then(() => reset()); return ready; });
  pi.on('agent_start', async (_event, context) => {
    const owner = await use(context); stopped = false; await owner.pauseNotifications(false); changed();
    const epoch = generation;
    context.signal?.addEventListener('abort', () => {
      if (epoch !== generation) return;
      stopped = true; queued.clear(); reading.clear();
      void owner.pauseNotifications(true).then(() => owner.cancelAll()).catch(report);
    }, { once: true });
  });
  pi.on('agent_settled', async event => {
    if (!runtime) return;
    if (event.aborted) { stopped = true; queued.clear(); reading.clear(); await runtime.pauseNotifications(true); await runtime.cancelAll(); }
    else { reading.clear(); await runtime.acknowledge(ctx ? parentReceipts(ctx) : []); changed(); }
  });

  pi.registerTool<typeof Params, Details>({ name: 'subagent', label: 'Subagent', parameters: Params, executionMode: 'sequential',
    description: 'Manage named subagents with fresh or forked conversations, saved progress, and enforced tool permissions. list shows definitions, configured models, skills, MCP tools, and trusted child hook adapters. Set trust untrusted for deny-by-default delegation and specify exact tools, skills, MCP tools, and hooks. Trusted children inherit permitted capabilities by default; disabledSkills excludes names, skills [] disables all, and an explicit skills list preloads a subset. Permitted parent MCP tools and registered child hooks are inherited too; use disabledMcpTools or disabledHooks for exclusions, or an empty mcpTools or hooks list to opt out. spawn starts parallel work with fresh context or context fork; send gives an idle child another task in the same conversation; steer adds direction to an active task at its next safe boundary. spawn isolation worktree uses a dedicated branch at current HEAD. resume recovers unfinished work, without restarting completed, cancelled, or closed tasks. status, wait, result, transcript, cancel, and close inspect or control children. Results return automatically. Reuse requestId after an uncertain spawn, send, or steer. Children share files unless isolated in a worktree, cannot delegate, and return user questions to you. Tool permissions are not an OS sandbox.',
    promptSnippet: 'Delegate self-contained tasks to named agents and recover saved children.',
    promptGuidelines: [
      'Delegate only when the user or applicable instructions authorize it. Use list to check permissions and configured models. Choose trust untrusted for children that need an explicit minimal allowlist; trust never expands the named permission profile.',
      'Give children context, file ownership, and the expected result. Use isolation worktree for separate checkouts; parent uncommitted changes are not copied.',
      'Continue independent work after spawn. Results arrive automatically. Use wait only when the result is required now.',
      'For uncertain writes or commands after recovery, inspect their effects before issuing another operation.',
    ],
    async execute(callId, params, signal, _update, context) {
      try {
        const owner = await use(context);
        signal?.throwIfAborted();
        let runs: RunSnapshot[] = [], text = '', receipts: string[] = [];
        const id = () => { if (!params.id) throw new Error('A child id is required.'); return params.id; };
        switch (params.action) {
          case 'list': {
            const found = await definitions(context);
            text = found.agents.map(agent => `${agent.name}: ${agent.description}\nTrust: ${agent.trust ?? 'trusted'}; permissions: ${agent.permissions}; tools: ${resolveTools(agent, resolveTrust(agent.trust)).join(', ') || 'none'}; tool ceiling: ${(agent.toolCeiling ?? agent.tools).join(', ') || 'none'}; disabled tools: ${(agent.disabledTools ?? []).join(', ')}; model: ${agent.model ?? 'current'}; context: ${agent.context ?? 'default'}; isolation: ${agent.isolation ?? 'default'}; skills: ${Array.isArray(agent.skills) ? agent.skills.join(', ') || 'none' : agent.skills ?? 'inherit'}; disabled skills: ${(agent.disabledSkills ?? []).join(', ')}; MCP servers: ${(agent.mcpServers ?? []).join(', ')}; MCP tools: ${Array.isArray(agent.mcpTools) ? agent.mcpTools.join(', ') || 'none' : agent.mcpTools ?? 'inherit'}; hooks: ${Array.isArray(agent.hooks) ? agent.hooks.join(', ') || 'none' : agent.hooks ?? 'inherit'}; source: ${agent.source}`).join('\n\n');
            text += '\n\nParent capabilities:\n' + JSON.stringify(await capabilities!.catalog(), (_key, value) => _key === 'configHash' || _key === 'signature' ? undefined : value, 2);
            text += '\n\nConfigured models:\n' + context.modelRegistry.getAvailable().filter(model => !context.scopedModels.length || context.scopedModels.some(item => item.model.provider === model.provider && item.model.id === model.id)).map(model => `${model.provider}/${model.id} (${getSupportedThinkingLevels(model).join(', ')})`).join('\n');
            if (found.errors.length) text += '\n\nInvalid definitions:\n' + found.errors.join('\n');
            return { content: [{ type: 'text', text }], details: { summary: `${found.agents.length} agent definitions` } };
          }
          case 'spawn': runs = [await spawn(owner, params, context, params.requestId ?? callId)]; break;
          case 'send': runs = [await owner.send(id(), params.task ?? '', params.requestId ?? callId, fingerprint(params))]; break;
          case 'steer': runs = [await owner.steer(id(), params.task ?? '', params.requestId ?? callId, fingerprint(params))]; break;
          case 'resume': runs = await owner.resume(params.id, true); break;
          case 'status': runs = params.id ? [await owner.get(params.id)] : await owner.list(); break;
          case 'wait': runs = [await owner.wait(id(), params.timeoutMs ?? 30000, signal)]; break;
          case 'result': await owner.refresh(); runs = [await owner.get(id())]; break;
          case 'transcript': text = clip(await owner.transcript(id()), 50000); break;
          case 'cancel': runs = [await owner.stop(id())]; break;
          case 'close': await owner.close(id()); text = `Closed ${params.id}. The saved conversation is preserved.`; break;
        }
        if (['wait', 'result'].includes(params.action)) {
          receipts = runs.filter(run => !isRunning(run)).map(run => run.receipt);
          for (const receipt of receipts) reading.add(receipt);
        }
        const summary = text ? params.action === 'transcript' ? `Transcript ${params.id}` : text : runs.length === 1 ? runSummary(runs[0]) : `${runs.length} subagents, ${runs.filter(isRunning).length} active`;
        text ||= runs.map(run => `${runSummary(run)}\nRun: ${run.run}; receipt: ${run.receipt}\nTrust: ${run.trust ?? 'trusted'}; model: ${run.model}; thinking: ${run.thinking}; tools: ${run.tools.join(', ') || 'none'}${run.capabilities ? `\nCapabilities: ${JSON.stringify(run.capabilities)}` : ''}${run.lifecycleErrors?.length ? `\nLifecycle hook errors: ${run.lifecycleErrors.join('; ')}` : ''}${run.cwd ? `\nWorking directory: ${run.cwd}` : ''}${run.worktree ? `\nBranch: ${run.worktree.branch}; base: ${run.worktree.baseCommit}` : ''}${run.sessionFile ? `\nStorage: ${run.sessionFile}` : ''}${['result', 'wait'].includes(params.action) && !isRunning(run) ? '\n' + clip(run.output || run.error || '') : ''}`).join('\n\n') || summary;
        changed();
        return { content: [{ type: 'text', text }], details: { summary: oneLine(summary), runs, receipts },
          isError: params.action === 'result' && runs.some(run => run.status === 'failed' || run.status === 'cancelled') };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: message }], details: { summary: oneLine(message) }, isError: true };
      }
    },
    renderCall: (params, theme) => compactText(theme.fg('toolTitle', `subagent ${params.action}${params.agent ? ' ' + oneLine(params.agent) : ''}${params.id ? ' ' + oneLine(params.id) : ''}`)),
    renderResult: (result, { expanded }, theme) => expanded ? new Text(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'), 0, 0) : compactText(theme.fg('dim', result.details?.summary ?? 'Subagent')),
  });
  pi.registerMessageRenderer<Details>(RESULT_MESSAGE, (message, { expanded }, theme) => expanded ?
    new Text(typeof message.content === 'string' ? message.content : JSON.stringify(message.content), 0, 0) : compactText(theme.fg('dim', message.details?.summary ?? 'Subagents finished')));

  async function inspect(context: ExtensionCommandContext, title: string, content: string): Promise<void> {
    if (context.mode !== 'tui') { context.ui.notify(clip(content, 6000), 'info'); return; }
    await context.ui.custom<void>((tui, _theme, _keys, done) => new SubagentInspector(title, () => content, done, () => tui.requestRender(), tui.terminal.rows));
  }
  async function command(args: string, context: ExtensionCommandContext): Promise<void> {
    try {
      const owner = await use(context);
      const [action, id] = args.trim().split(/\s+/);
      if (action === 'config') {
        const settings = await readSubagentSettings(configPath);
        if (!context.hasUI) { context.ui.notify(`${configPath}\n${JSON.stringify(settings, null, 2)}`, 'info'); return; }
        const value = await context.ui.editor('Subagent settings', JSON.stringify(settings, null, 2));
        if (value !== undefined) await writeSubagentSettings(configPath, JSON.parse(value));
      } else if (action === 'stop') {
        if (id) await owner.stop(id);
        else { stopped = true; await owner.pauseNotifications(true); await owner.cancelAll(); }
      } else if (action === 'resume') {
        await owner.resume(id, true); changed();
      } else if (action === 'list') {
        const found = await definitions(context);
        await inspect(context, 'Agent definitions', found.agents.map(agent => `${agent.name} · ${agent.permissions}\n${agent.description}\n${agent.source}\n${agent.prompt}`).join('\n\n') + '\n' + found.errors.join('\n'));
      } else if (action) {
        const run = await owner.get(action);
        await inspect(context, `Subagent ${action}`, `${runSummary(run)}\n${run.model} · ${run.thinking}\nTask: ${run.task}\n\n${await owner.transcript(action)}`);
      } else if (!context.hasUI) context.ui.notify((await owner.list()).map(runSummary).join('\n') || 'No subagents.', 'info');
      else {
        const items = new Map((await owner.list()).map(run => [runSummary(run), run.id]));
        items.set('Browse agent definitions', 'list'); items.set('Edit settings', 'config'); items.set('Resume unfinished tasks', 'resume');
        const selected = await context.ui.select('Subagents', [...items.keys()]);
        if (selected) await command(items.get(selected)!, context);
      }
    } catch (error) { report(error); }
  }
  pi.registerCommand('agents', { description: 'Inspect subagents, transcripts, recovery, and settings', handler: command });
}
