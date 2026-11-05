import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as C, withAbortSignal } from '@earendil-works/chord/context';
import {
  AssistantEntry, configure, createRegistry, defineDoc, defineExtension, defineTask, Harness,
  hook, InboxDoc, LiveDoc, ProviderDoc, ToolTask, UsageDoc,
  type Conversation, type ConversationId, type Cursor, type EntryRecord, type SubmissionId, type TaskId, type TaskState, type TaskRecord, type Tx,
} from '@earendil-works/pi-durable';
import type { Models as PiModels, Model, Api, Context, ModelsSimpleStreamOptions, Message } from '@earendil-works/pi-ai';
import type { ExtensionContext, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BUILTIN_AGENTS, PERMISSION_TOOLS, type AgentDefinition, type Thinking, type Isolation, type ContextMode } from './agents.ts';
import { validateSubagentSettings, type SubagentSettings } from './config.ts';
import { guardedModels } from './models.ts';
import { childTools } from './tools.ts';
import { checkPolicy, createPolicy, resolveTrust, type Trust, type ToolPolicy } from './policy.ts';
import { runLifecycleHook, type LifecycleEvent, type LifecycleRecord } from './lifecycle.ts';
import { capabilityTools, checkCapabilityPermissions, emptyCapabilities, type Capabilities, type ParentCapabilities } from './capabilities.ts';
import { forkMessages } from './fork.ts';
import { ensureWorktree, planWorktree, verifyWorktree, type Worktree } from './worktrees.ts';
import type { Store } from './storage.ts';
import { nestedOperation, type NestedParams } from './nested.ts';

export type RunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunSnapshot = {
  id: string; agent: string; task: string; run: number; status: RunStatus; model: string; thinking: Thinking;
  tools: string[]; startedAt: number; finishedAt?: number; turns: number; toolCalls: number; activity?: string;
  output: string; error?: string; sessionFile?: string; tokens: number; cost: number;
  recoveryError?: string;
  trust?: Trust;
  parentChildId?: string; parentRun?: number; depth?: number;
  lifecycleErrors?: string[];
  context?: ContextMode;
  capabilities?: { skills: string[]; mcpTools: string[]; hooks: string[] };
  cwd?: string; worktree?: { path: string; branch: string; baseCommit: string };
  steering?: { id: SubmissionId; task: string; source?: 'parent' | 'user' }[];
  receipt: string; delivered: boolean; submissionId?: SubmissionId;
};
export type ChildChatSnapshot = { run: RunSnapshot; entries: EntryRecord[] };
export const isRunning = (run: Pick<RunSnapshot, 'status'>): boolean => run.status === 'starting' || run.status === 'running';
export type SavedChild = {
  id: ConversationId; anchor: TaskId; parentId: string; definition: AgentDefinition; tools: string[];
  settings: SubagentSettings; model: string; thinking: Thinking; cwd: string; parentCwd?: string; worktree?: Worktree; instructions: string;
  capabilities?: Capabilities; context?: ContextMode; forkParentLeaf?: string; projectTrusted: boolean; closed: boolean; runs: RunSnapshot[];
  trust?: Trust; policy?: ToolPolicy;
  delegation?: { ownerId: string; ownerRun: number; depth: number }; sharedInstructions?: string;
  lifecycle?: Record<string, LifecycleRecord>;
  recovery?: { message: string; tasks: { id: TaskId; state: JsonValue }[] };
  routing?: { state?: JsonValue; decisions: Record<string, { provider: string; id: string; thinking: Thinking }> };
};
type State = { notificationsPaused: boolean; parentId: string; children: Record<string, SavedChild>; requests: Record<string, { id: string; run: number; input: string }> };
export const Children = defineDoc<State>({ kind: 'pi-subagents.children', version: 1, scope: 'session',
  initial: () => ({ notificationsPaused: false, parentId: '', children: {}, requests: {} }), checkpointWhen: () => true });
const Anchor = defineTask<null, { phase: 'done' }, null>({ name: 'pi-subagents.owner', version: 1,
  initial: () => ({ phase: 'done' }), phases: { done: (_task, runtime, context) => runtime.commit(() =>
    ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});
export type SpawnOptions = {
  definition: AgentDefinition; trust?: Trust; task: string; tools: string[]; settings: SubagentSettings;
  model: string; thinking: Thinking; instructions: string; capabilities?: Capabilities; projectTrusted: boolean; isolation?: Isolation; context?: ContextMode; history?: Message[]; forkParentLeaf?: string; forkCallId?: string;
  delegation?: SavedChild['delegation']; sharedInstructions?: string;
};

export function parentRuntime(ctx: Pick<ExtensionContext, 'modelRegistry'>): ModelRuntime {
  // Pi 1.4's extension facade has no public Models getter. Fail closed if this bridge changes.
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime || typeof runtime.streamSimple !== 'function' || typeof runtime.getModel !== 'function') {
    throw new Error('Pi subagents requires the shared Pi 1.4 model runtime.');
  }
  return runtime;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const latest = (child: SavedChild) => child.runs[child.runs.length - 1];
// Pi Durable 1.4 exposes no per-conversation pause. Preserve task records through its
// transaction implementation, alongside the saved recovery intent in the same commit.
function replaceTask(tx: Tx, record: TaskRecord<JsonValue, JsonValue, JsonValue>): void {
  const writer = tx as Tx & { setTask?: (record: TaskRecord<JsonValue, JsonValue, JsonValue>) => void };
  if (typeof writer.setTask !== 'function') throw new Error('Pi Durable task recovery bridge is unavailable.');
  writer.setTask(record);
}

export class SubagentRuntime {
  private constructor(readonly harness: Harness, private root: Conversation, private store: Store,
    private extension: ReturnType<typeof defineExtension>, private options: { capabilities?: ParentCapabilities; definitions?: () => Promise<AgentDefinition[]>; worktreeRoot?: string; parentId: string; cwd: string; models: PiModels; allow: (child: SavedChild) => void; changed: () => void; error: (error: unknown) => void }) {}
  private ended = false;
  private epoch = randomUUID();
  private operations = new Map<string, Promise<void>>();
  private recovering = new Map<string, number>();
  private lifecycleJobs = new Map<string, Promise<void>>();
  private lifecycleSignals = new Map<string, AbortController>();
  private refreshing = false;
  private dirty = false;
  private unsubscribe?: () => void;
  private workspaces = new Map<string, Promise<void>>();
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private browserCache = new Map<string, { key: string; run: RunSnapshot }>();

  static async open(store: Store, options: SubagentRuntime['options']): Promise<SubagentRuntime> {
    const registry = createRegistry();
    let runtime: SubagentRuntime | undefined;
    const guards = defineExtension({ name: 'pi-subagents', tools: childTools(options.cwd, (id, name) => runtime!.authorizeTool(id, name), options.capabilities,
      (child, args, callId, signal, taskKey) => runtime!.delegate(String(child.id), args, callId, signal, taskKey)), tasks: [Anchor], hooks: [
      hook(ToolTask, { beforeTool: async (call, api) => {
        try {
          const child = await runtime!.saved(api.conversationId);
          runtime!.check(child);
          await runtime!.ensureLifecycle(child);
          if (!child.tools.includes(call.name)) return { block: `Tool ${call.name} is outside the saved permission profile.` };
          return undefined;
        } catch (error) { return { block: error instanceof Error ? error.message : String(error) }; }
      } }),
    ] });
    registry.install(guards);
    try {
      const harness = await Harness.open(store.storage, { models: guardedModels(options.models, (model, context, streamOptions) => runtime!.admitModel(model, context, streamOptions), (model, handle) => runtime!.admitDeferred(model, handle)), registry,
        settings: { extensions: [guards], retry: { enabled: false, maxRetries: 0 }, afterFailedRun: 'withdraw', compaction: { enabled: true }, toolExecution: 'sequential',
          stream: { timeoutMs: 120000 }, restartLimit: 5 }, onReport: options.error }, C);
      const root = await harness.root(C);
      runtime = new SubagentRuntime(harness, root, store, guards, options);
      await harness.commit(async tx => {
        const state = await tx.doc(Children);
        if (state.parentId && state.parentId !== options.parentId) throw new Error('Subagent ownership does not match the parent session.');
        state.parentId = options.parentId;
        for (const saved of Object.values(state.children)) {
          if (!saved.policy) { saved.trust = resolveTrust(saved.trust); saved.policy = createPolicy(saved as SavedChild); }
        }
      }, C);
      for (const child of Object.values((await runtime.state()).children)) if (isRunning(latest(child)) && !child.closed) runtime.recovering.set(String(child.id), latest(child).run);
      // Park before anything can enable Durable scheduling, including aborting a terminal sibling.
      for (const child of Object.values((await runtime.state()).children)) if (isRunning(latest(child)) && !child.closed) await runtime.park(child, child.recovery?.message ?? 'Recovery checks pending.');
      runtime.unsubscribe = harness.subscribeCommits(() => runtime!.scheduleRefresh());
      return runtime;
    } catch (error) { await store.storage.close(C); store.release(); throw error; }
  }

  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.operations.set(id, pending);
    await previous;
    try { if (this.ended) throw new Error('The child runtime is closed.'); return await operation(); }
    finally { release(); if (this.operations.get(id) === pending) this.operations.delete(id); }
  }

  private async lifecycleFailure(child: SavedChild, event: LifecycleEvent, run: RunSnapshot, error: unknown): Promise<void> {
    if (this.ended || event === 'start' || event === 'resume') throw error;
    const message = `${event} hook: ${error instanceof Error ? error.message : String(error)}`;
    let added = false;
    await this.harness.commit(async tx => {
      const current = (await tx.doc(Children)).children[child.id].runs[run.run - 1];
      current.lifecycleErrors ??= [];
      if (!current.lifecycleErrors.includes(message)) { current.lifecycleErrors.push(message); added = true; }
    }, C);
    if (added) this.options.error(error);
  }

  private async lifecycle(child: SavedChild, event: LifecycleEvent, run = latest(child)): Promise<void> {
    const selected = child.capabilities ?? emptyCapabilities();
    if (!selected.hooks.length || !this.options.capabilities) return;
    const jobKey = `${child.id}:${run.run}:${event}`;
    const existing = this.lifecycleJobs.get(jobKey);
    if (existing) return existing;
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    this.lifecycleSignals.set(jobKey, controller);
    const job = (async () => {
      try {
        const hooks = this.options.capabilities!.hooks();
        for (const spec of selected.hooks) {
          try {
            const hook = hooks.get(spec.name);
            if (!hook) throw new Error(`Saved child hook unavailable: ${spec.name}.`);
            const callback = event === 'start' ? hook.onStart : event === 'resume' ? hook.onResume : event === 'stop' ? hook.onStop : hook.onClose;
            if (!callback) continue;
            const store = {
              read: async (key: string) => (await this.saved(child.id)).lifecycle?.[key],
              write: async (key: string, value: LifecycleRecord) => {
                // Reload interrupts a callback without turning it into a deliberate failure.
                if (this.ended && value.status === 'failed') return;
                await this.harness.commit(async tx => {
                  const current = (await tx.doc(Children)).children[child.id];
                  current.lifecycle ??= {};
                  current.lifecycle[key] = value;
                }, C);
              },
            };
            const invoke = async () => {
              if (this.ended) throw new Error('Child lifecycle was interrupted by shutdown.');
              signal.throwIfAborted();
              if (event === 'start' || event === 'resume') {
                const current = await this.saved(child.id);
                if (latest(current).run !== run.run) throw new Error('The lifecycle task was replaced.');
                this.check(current);
              }
              checkPolicy(child);
              checkCapabilityPermissions(selected, child.definition.permissions);
              this.options.allow(child);
              if (child.parentId !== this.options.parentId || (child.parentCwd ?? child.cwd) !== this.options.cwd) throw new Error('Child lifecycle ownership changed.');
              await this.options.capabilities!.validate(selected);
              await this.validateWorkspace(child);
              const context = { childId: String(child.id), cwd: child.cwd, permissions: child.definition.permissions,
                run: run.run, task: run.task, status: run.status, output: run.output, error: run.error, signal };
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(signal.reason ?? new Error('Child lifecycle callback aborted.'));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) { abort(); return; }
                Promise.resolve().then(() => callback(context)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
              });
            };
            // Finish a prior interrupted resume checkpoint before creating this restart's event.
            let recoveredResume = false;
            if (event === 'resume') for (const [oldKey, record] of Object.entries((await this.saved(child.id)).lifecycle ?? {})) {
              const [oldRun, oldEvent, , oldHook] = JSON.parse(oldKey) as [number, string, string, string];
              if (oldRun === run.run && oldEvent === event && oldHook === spec.name && record.status !== 'done') {
                await runLifecycleHook(store, oldKey, spec.replay, invoke);
                recoveredResume = true;
              }
            }
            const key = JSON.stringify([run.run, event, event === 'resume' ? this.epoch : '', spec.name]);
            if (recoveredResume) await store.write(key, { status: 'done' });
            else await runLifecycleHook(store, key, spec.replay, invoke);
          } catch (error) { await this.lifecycleFailure(child, event, run, error); }
        }
      } catch (error) { await this.lifecycleFailure(child, event, run, error); }
    })();
    this.lifecycleJobs.set(jobKey, job);
    try { await job; } finally { this.lifecycleSignals.delete(jobKey); if (this.lifecycleJobs.get(jobKey) === job) this.lifecycleJobs.delete(jobKey); }
  }

  private async ensureLifecycle(child: SavedChild): Promise<void> {
    this.check(await this.saved(child.id));
    if (child.delegation) this.checkDelegation(child, await this.state());
    await this.lifecycle(child, 'start');
    if (this.recovering.get(String(child.id)) === latest(child).run) {
      await this.recoverAdmissions();
      const recovered = await this.saved(child.id);
      if (latest(recovered).submissionId) await this.lifecycle(recovered, 'resume');
      this.recovering.delete(String(child.id));
    }
    this.check(await this.saved(child.id));
  }
  private async finishTerminal(child: SavedChild, run = latest(child)): Promise<void> {
    if (isRunning(run)) return;
    for (const event of ['start', 'resume']) this.lifecycleSignals.get(`${child.id}:${run.run}:${event}`)?.abort(new Error('Child task stopped.'));
    await Promise.allSettled(['start', 'resume'].flatMap(event => {
      const job = this.lifecycleJobs.get(`${child.id}:${run.run}:${event}`); return job ? [job] : [];
    }));
    if (this.recovering.get(String(child.id)) === run.run) this.recovering.delete(String(child.id));
    try {
      await this.lifecycle(child, 'stop', run);
      if (child.closed && latest(child).run === run.run) await this.lifecycle(child, 'close', run);
    } finally {
      const current = await this.saved(child.id);
      if (latest(current).run === run.run && !isRunning(latest(current))) await this.options.capabilities?.mcp.release?.(String(child.id));
    }
  }

  private async admitModel(model: Model<Api>, context: Context, streamOptions: ModelsSimpleStreamOptions | undefined): Promise<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> {
    const sessionId = streamOptions?.sessionId;
    if (this.ended) throw new Error('The child runtime is closed.');
    for (const child of Object.values((await this.state()).children)) {
      const provider = await this.harness.snapshot(ProviderDoc, child.id, C);
      if (!sessionId || provider?.sessionId !== sessionId) continue;
      this.check(child);
      await this.ensureLifecycle(child);
      await this.validateWorkspace(child);
      await this.options.capabilities?.validate(child.capabilities ?? emptyCapabilities());
      await this.harness.commit(async tx => {
        const current = (await tx.doc(Children)).children[child.id];
        this.check(clone(current));
        if (latest(current).turns >= current.settings.maxTurns) throw new Error(`Stopped at the ${current.settings.maxTurns}-request limit.`);
        latest(current).turns++;
      }, C);
      if (model.api !== 'pi-virtual') return { model, options: streamOptions };
      const key = createHash('sha256').update(JSON.stringify([model.provider, model.id, context.messages, streamOptions?.reasoning])).digest('hex');
      let choice = child.routing?.decisions[key];
      if (!choice) {
        const shared = this.options.models as ModelRuntime;
        if (typeof shared.resolveModel !== 'function') throw new Error('The configured runtime cannot route virtual models.');
        const route = await shared.resolveModel(model, context.messages, {
          reason: latest(child).turns === 0 ? 'user' : 'continuation', thinkingLevel: child.thinking,
          state: child.routing?.state, signal: streamOptions?.signal,
        });
        choice = { provider: route.model.provider, id: route.model.id, thinking: route.thinkingLevel };
        await this.harness.commit(async tx => {
          const current = (await tx.doc(Children)).children[child.id];
          this.check(clone(current));
          current.routing ??= { decisions: {} };
          current.routing.decisions[key] = choice!;
          if (route.state !== undefined) current.routing.state = clone(route.state) as JsonValue;
        }, C);
      }
      const physical = this.options.models.getModel(choice.provider, choice.id);
      if (!physical || physical.api === 'pi-virtual') throw new Error('The saved virtual-model route is unavailable.');
      return { model: physical, options: { ...streamOptions, reasoning: choice.thinking === 'off' ? undefined : choice.thinking } };
    }
    throw new Error('No saved child owns this model request.');
  }
  private async authorizeTool(id: ConversationId, name: string): Promise<SavedChild> {
    const child = await this.saved(id);
    this.check(child);
    await this.ensureLifecycle(child);
    if (!child.tools.includes(name)) throw new Error(`Tool ${name} is outside the saved permission profile.`);
    await this.validateWorkspace(child);
    await this.options.capabilities?.validate(child.capabilities ?? emptyCapabilities());
    return child;
  }
  private async admitDeferred(model: Model<Api>, handle: import('@earendil-works/pi-ai').DeferredHandle): Promise<void> {
    if (this.ended) throw new Error('The child runtime is closed.');
    const candidates = (await this.harness.inspect(C)).tasks.filter(task => {
      const checkpoint = task.record.state.status === 'terminal' || task.record.state.status === 'completing' ? undefined : task.record.state.checkpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
      const ref = checkpoint.model as { provider?: string; modelId?: string } | undefined;
      const saved = checkpoint.handle && typeof checkpoint.handle === 'object' && !Array.isArray(checkpoint.handle) ? checkpoint.handle : undefined;
      return task.record.kind === 'pi.generation' && checkpoint.phase === 'poll' && ref?.provider === model.provider && ref?.modelId === model.id &&
        saved?.provider === handle.provider && saved?.modelId === handle.modelId && saved?.api === handle.api && saved?.id === handle.id;
    });
    if (candidates.length !== 1) throw new Error('No unique child owns this deferred model response.');
    const child = await this.saved(candidates[0].record.conversationId);
    this.check(child); await this.ensureLifecycle(child); await this.validateWorkspace(child);
    await this.options.capabilities?.validate(child.capabilities ?? emptyCapabilities());
  }
  private check(child: SavedChild, environment = true): void {
    if (child.closed || !isRunning(latest(child))) throw new Error('This task is no longer active.');
    if (child.parentId !== this.options.parentId || (child.parentCwd ?? child.cwd) !== this.options.cwd) throw new Error('Child ownership or working directory changed.');
    checkPolicy(child);
    validateSubagentSettings(child.settings);
    const selected = child.capabilities ?? emptyCapabilities();
    checkCapabilityPermissions(selected, child.definition.permissions);
    const extra = capabilityTools(selected);
    if ((extra.length || selected.hooks.length) && !this.options.capabilities) throw new Error('Saved child capabilities are unavailable.');
    const allowed = PERMISSION_TOOLS[child.definition.permissions] as readonly string[];
    if (!allowed || child.tools.some(tool => !extra.includes(tool) && (!allowed.includes(tool) || !(child.definition.toolCeiling ?? child.definition.tools).includes(tool)))) throw new Error('Invalid saved tool permissions.');
    if (Date.now() >= latest(child).startedAt + child.settings.timeoutSeconds * 1000) throw new Error('The saved task deadline has passed.');
    if (environment) {
      if (child.recovery) throw new Error(child.recovery.message);
      this.checkEnvironment(child);
    }
  }
  private checkEnvironment(child: SavedChild): void {
    this.options.allow(child);
    const split = child.model.indexOf('/');
    if (!this.options.models.getModel(child.model.slice(0, split), child.model.slice(split + 1))) throw new Error(`Saved model unavailable: ${child.model}`);
  }
  private checkDelegation(child: SavedChild, state: Readonly<State>, environment = true): void {
    const seen = new Set<string>([String(child.id)]);
    for (let current = child; current.delegation;) {
      const relation = current.delegation;
      const owner = state.children[relation.ownerId];
      if (!owner || seen.has(relation.ownerId)) throw new Error('Invalid nested child ownership.');
      seen.add(relation.ownerId);
      this.check(clone(owner), environment);
      if (latest(owner).run !== relation.ownerRun || relation.depth !== (owner.delegation?.depth ?? 1) + 1 || relation.depth > validateSubagentSettings(owner.settings).maxDepth) throw new Error('The delegating task is no longer active or its depth limit changed.');
      if (current.cwd !== owner.cwd || JSON.stringify(current.worktree) !== JSON.stringify(owner.worktree)) throw new Error('Nested children must keep their owner working directory.');
      if (!owner.tools.includes('subagent') || current.tools.some(tool => !owner.tools.includes(tool))) throw new Error('Nested tools exceed the delegating agent allowlist.');
      const rank = { 'read-only': 0, edit: 1, full: 2 };
      if (rank[current.definition.permissions] > rank[owner.definition.permissions] || (owner.trust === 'untrusted' && current.trust !== 'untrusted')) throw new Error('Nested child trust or permissions exceed the owner policy.');
      for (const field of ['skills', 'mcpTools', 'hooks'] as const) {
        if (current.capabilities?.[field].some(item => !owner.capabilities?.[field].some(parent => JSON.stringify({ ...parent, preload: undefined }) === JSON.stringify({ ...item, preload: undefined })))) throw new Error(`Nested ${field} exceed the owner allowlist.`);
      }
      if (current.settings.maxConcurrent > owner.settings.maxConcurrent || current.settings.maxDepth > owner.settings.maxDepth || current.settings.maxTurns > owner.settings.maxTurns || current.settings.timeoutSeconds > owner.settings.timeoutSeconds) throw new Error('Nested task limits exceed the owner limits.');
      current = owner;
    }
  }
  async delegate(callerId: string, params: NestedParams, callId: string, signal?: AbortSignal, taskKey?: string) {
    const caller = await this.authorizeTool(Number(callerId) as ConversationId, 'subagent');
    const definitions = await (this.options.definitions?.() ?? Promise.resolve(BUILTIN_AGENTS));
    return nestedOperation(this, caller, definitions, params, callId, signal, taskKey);
  }
  configuredModel(name: string): Model<Api> | undefined {
    const split = name.indexOf('/');
    return this.options.models.getModel(name.slice(0, split), name.slice(split + 1));
  }
  private cancelDescendants(state: State, id: string, run: number, seen = new Set<string>()): void {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of Object.values(state.children)) {
      if (child.delegation?.ownerId !== id || child.delegation.ownerRun !== run) continue;
      if (isRunning(latest(child))) Object.assign(latest(child), { status: 'cancelled', error: 'The delegating task ended.', finishedAt: Date.now() });
      delete child.recovery; delete latest(child).recoveryError;
      this.cancelDescendants(state, String(child.id), latest(child).run, seen);
    }
  }
  private async abortDescendants(id: string, run: number, seen = new Set<string>()): Promise<void> {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of Object.values((await this.state()).children)) {
      if (child.delegation?.ownerId !== id || child.delegation.ownerRun !== run) continue;
      await this.abortDescendants(String(child.id), latest(child).run, seen);
      if (latest(child).status !== 'cancelled') continue;
      clearTimeout(this.deadlines.get(String(child.id))); this.deadlines.delete(String(child.id));
      await (await this.harness.conversation(child.id, C))!.abort(C);
      await this.finishTerminal(child);
    }
  }
  async state(): Promise<Readonly<State>> { return (await this.harness.snapshot(Children, C))!; }
  async saved(id: string | ConversationId): Promise<SavedChild> {
    if (!/^[1-9][0-9]*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid child ID.');
    const child = (await this.state()).children[id];
    if (!child) throw new Error(`Unknown child: ${id}.`);
    return clone(child);
  }
  async list(): Promise<RunSnapshot[]> {
    const state = await this.state();
    return Object.values(state.children).filter(child => !child.closed).map(child => clone(latest(child)));
  }
  /** Read current activity without scanning conversation transcripts. */
  async indicatorRuns(): Promise<RunSnapshot[]> {
    return Promise.all((await this.list()).map(async run => {
      if (!isRunning(run) || run.recoveryError) return run;
      const live = await this.harness.snapshot(LiveDoc, Number(run.id) as ConversationId, C);
      const tool = live?.tools?.find(tool => tool.status === 'running') ?? live?.tools?.find(tool => tool.status === 'pending');
      run.activity = live?.compactions?.some(item => item.blocking) ? 'compacting' : tool ? `tool:${tool.name}` : live?.generation?.deferred ? 'waiting' : live?.generation ? 'thinking' : 'starting';
      return run;
    }));
  }
  /** Read live details only while the on-demand browser is open. */
  async browserRuns(): Promise<RunSnapshot[]> {
    const state = await this.state();
    return Promise.all((await this.list()).map(async run => {
      run.parentRun = state.children[run.id]?.delegation?.ownerRun;
      const conversation = (await this.harness.conversation(Number(run.id) as ConversationId, C))!;
      const tail = (await conversation.entries({ order: 'descending' }, 1, undefined, C)).items[0];
      const key = JSON.stringify([run, tail?.id]);
      const cached = this.browserCache.get(run.id);
      if (cached?.key === key) return clone(cached.run);
      const details = (await this.readChat(run)).run;
      this.browserCache.set(run.id, { key, run: clone(details) });
      return details;
    }));
  }
  async chatSnapshot(id: string): Promise<ChildChatSnapshot> { return this.readChat(await this.get(id)); }
  async modelHistory(id: string): Promise<Message[]> {
    const child = await this.saved(id);
    return [...(await (await this.harness.conversation(child.id, C))!.context(C)).messages];
  }
  private async readChat(run: RunSnapshot): Promise<ChildChatSnapshot> {
    const [entries, usage] = await Promise.all([this.entries(run.id), this.harness.snapshot(UsageDoc, Number(run.id) as ConversationId, C)]);
    const messages = entries.filter(entry => entry.kind !== 'pi-subagents.fork').flatMap(entry => entry.model ?? []);
    run.toolCalls = messages.filter(message => message.role === 'toolResult').length;
    run.tokens = Object.values(usage?.models ?? {}).reduce((sum, item) => sum + item.totalTokens, 0);
    run.cost = Object.values(usage?.models ?? {}).reduce((sum, item) => sum + item.cost.total, 0);
    if (isRunning(run)) {
      const index = messages.findLastIndex(message => message.role === 'assistant');
      const assistant = messages[index];
      const results = messages.slice(index + 1).filter(message => message.role === 'toolResult');
      const pending = assistant?.role === 'assistant' ? assistant.content.find(part => part.type === 'toolCall' &&
        !results.some(message => message.role === 'toolResult' && message.toolCallId === part.id)) : undefined;
      if (pending?.type === 'toolCall') run.activity = `${pending.name} ${(JSON.stringify(pending.arguments) ?? String(pending.arguments)).slice(0, 300)}`;
    }
    return { run, entries };
  }
  async get(id: string): Promise<RunSnapshot> { return clone(latest(await this.saved(id))); }
  async request(key: string, input: string): Promise<RunSnapshot | undefined> {
    const state = await this.state();
    const request = state.requests[`r:${key}`];
    if (!request) return;
    if (request.input !== input) throw new Error('requestId already belongs to a different operation.');
    return clone(state.children[request.id].runs[request.run - 1]);
  }

  async spawn(options: SpawnOptions, requestId: string, input: string): Promise<RunSnapshot> {
    const prior = await this.request(requestId, input);
    if (prior) return prior;
    if (!options.task.trim()) throw new Error('A nonempty task is required.');
    const settings = validateSubagentSettings(options.settings);
    const isolation = options.isolation ?? options.definition.isolation ?? settings.isolation;
    if (isolation !== 'shared' && isolation !== 'worktree') throw new Error('Unknown isolation mode.');
    const delegator = options.delegation ? await this.saved(options.delegation.ownerId) : undefined;
    const worktree = delegator ? delegator.worktree : isolation === 'worktree' ? await planWorktree(this.options.cwd,
      this.options.worktreeRoot) : undefined;
    const contextMode = options.context ?? options.definition.context ?? settings.context;
    const history = contextMode === 'fork' ? forkMessages(options.history ?? [], options.forkCallId) : [];
    const { history: _history, forkCallId: _forkCallId, ...spec } = options;
    const id = await this.root.commit(async tx => {
      const state = await tx.doc(Children);
      if (state.requests[`r:${requestId}`]) {
        if (state.requests[`r:${requestId}`].input !== input) throw new Error('requestId already belongs to a different operation.');
        return state.requests[`r:${requestId}`].id;
      }
      if (Object.values(state.children).filter(child => isRunning(latest(child))).length >= settings.maxConcurrent) throw new Error(`At most ${settings.maxConcurrent} subagents can run at once.`);
      const anchor = await tx.createTask(Anchor, null, { ownership: { kind: 'conversation' }, background: true });
      const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
      const child: SavedChild = clone({ id: conversation.id, anchor, parentId: this.options.parentId,
        ...spec, settings, tools: options.tools.filter(name => name !== 'subagent' || (options.delegation?.depth ?? 1) < settings.maxDepth),
        trust: resolveTrust(options.trust ?? options.definition.trust), context: contextMode, cwd: delegator?.cwd ?? (worktree ? join(worktree.path, worktree.relativeCwd) : this.options.cwd),
        parentCwd: this.options.cwd, ...(worktree ? { worktree } : {}), closed: false, runs: [] });
      child.instructions += worktree ? `\n\nYour isolated working directory is ${child.cwd}. Your branch is ${worktree.branch}, based on ${worktree.baseCommit}. Parent uncommitted changes are absent. Use paths inside this worktree. Do not modify another checkout or change branches.` : '';
      child.instructions += `\n\nYour delegation depth is ${child.delegation?.depth ?? 1} of ${settings.maxDepth}. ${child.tools.includes('subagent') ? 'Use subagent to delegate independent tasks. Descendants cannot gain your missing tools or capabilities. Wait for all needed results before finishing. Unfinished descendants are cancelled when this task ends.' : 'Delegation is unavailable. Complete this task yourself.'}`;
      child.policy = createPolicy(child);
      child.runs.push(this.newRun(child, options.task));
      this.check(child);
      if (child.delegation) this.checkDelegation(child, state);
      const split = child.model.indexOf('/');
      await configure(tx, conversation.id, { model: { provider: child.model.slice(0, split), modelId: child.model.slice(split + 1) },
        thinkingLevel: child.thinking, extensions: [this.extension], tools: this.extension.tools!.filter(tool => child.tools.includes(tool.name)),
        instructions: child.instructions, cwd: child.cwd });
      for (const message of history) await tx.appendEntry(conversation.id, { kind: 'pi-subagents.fork', model: [message] });
      state.children[conversation.id] = child;
      state.requests[`r:${requestId}`] = { id: String(conversation.id), run: 1, input };
      return String(conversation.id);
    }, C);
    const child = await this.saved(id);
    if (isRunning(latest(child))) {
      try { await this.prepareWorkspace(child); await this.admit(await this.saved(id)); }
      catch (error) { if (!this.ended) await this.stop(id, false, error instanceof Error ? error.message : String(error)); throw error; }
    }
    return this.get(String(id));
  }
  private newRun(child: Pick<SavedChild, 'id' | 'definition' | 'model' | 'thinking' | 'tools' | 'runs' | 'cwd' | 'worktree' | 'context' | 'capabilities' | 'trust' | 'delegation'>, task: string): RunSnapshot {
    const run = child.runs.length + 1;
    return { id: String(child.id), trust: resolveTrust(child.trust), agent: child.definition.name, task, run, status: 'starting', model: child.model,
      thinking: child.thinking, tools: [...child.tools], startedAt: Date.now(), turns: 0, toolCalls: 0, output: '', tokens: 0, cost: 0,
      depth: child.delegation?.depth ?? 1, ...(child.delegation ? { parentChildId: child.delegation.ownerId } : {}),
      capabilities: { skills: child.capabilities?.skills.map(skill => skill.name) ?? [], mcpTools: child.capabilities?.mcpTools.map(tool => tool.name) ?? [], hooks: child.capabilities?.hooks.map(hook => hook.name) ?? [] },
      context: child.context ?? 'fresh', cwd: child.cwd, ...(child.worktree ? { worktree: { path: child.worktree.path, branch: child.worktree.branch, baseCommit: child.worktree.baseCommit } } : {}),
      receipt: `${this.options.parentId}:${child.id}:${run}`, delivered: false, ...(this.store.path ? { sessionFile: this.store.path } : {}) };
  }
  async send(id: string, task: string, requestId: string, input: string): Promise<RunSnapshot> {
    const prior = await this.request(requestId, input);
    if (prior) return prior;
    if (!task.trim()) throw new Error('A nonempty task is required.');
    const before = await this.saved(id);
    await this.validateWorkspace(before);
    await this.options.capabilities?.validate(before.capabilities ?? emptyCapabilities());
    if (!isRunning(latest(before))) await this.finishTerminal(before);
    await this.exclusive(id, async () => {
      if ((await this.harness.snapshot(LiveDoc, before.id, C))?.run) throw new Error('This child is still working or stopping.');
      await this.harness.commit(async tx => {
        const state = await tx.doc(Children);
        if (state.requests[`r:${requestId}`]) {
          if (state.requests[`r:${requestId}`].input !== input) throw new Error('requestId already belongs to a different operation.');
          return;
        }
        const child = state.children[id];
        if (!child || child.closed) throw new Error('Unknown or closed child.');
        if (isRunning(latest(child))) throw new Error('This child is still working. Wait before sending another task.');
        if (Object.values(state.children).filter(item => isRunning(latest(item))).length >= child.settings.maxConcurrent) throw new Error('Subagent concurrency limit reached.');
        child.runs.push(this.newRun(child, task));
        this.check(clone(child));
        if (child.delegation) this.checkDelegation(clone(child), state);
        state.requests[`r:${requestId}`] = { id, run: child.runs.length, input };
      }, C);
    });
    try { await this.admit(await this.saved(id)); }
    catch (error) { if (!this.ended) await this.stop(id, false, error instanceof Error ? error.message : String(error)); throw error; }
    return this.get(id);
  }
  /** Steering joins the active task and retains its deadline, budget, and single result receipt. */
  async steer(id: string, task: string, requestId: string, input: string, expectedRun?: number, source: 'parent' | 'user' = 'parent'): Promise<RunSnapshot> {
    const prior = await this.request(requestId, input);
    if (prior) return prior;
    if (!task.trim() || task.length > 50000) throw new Error('Steering requires 1 to 50,000 characters.');
    const before = await this.saved(id);
    await this.validateWorkspace(before);
    await this.options.capabilities?.validate(before.capabilities ?? emptyCapabilities());
    await this.harness.commit(async tx => {
      const state = await tx.doc(Children);
      const existing = state.requests[`r:${requestId}`];
      if (existing) {
        if (existing.input !== input) throw new Error('requestId already belongs to a different operation.');
        return;
      }
      const child = state.children[id];
      if (expectedRun !== undefined && latest(child).run !== expectedRun) throw new Error('This child has moved to another task. Reopen it before steering.');
      this.check(clone(child));
      const live = await tx.doc(LiveDoc, child.id);
      if (!live.run) throw new Error(source === 'user' ? 'The child is not ready for steering yet. Wait until it is running and try again.' : 'This child is idle. Use send for another task.');
      const inbox = await tx.doc(InboxDoc, child.id);
      // Pi Durable 1.4 has no active-only submit API. Admit the queued input and its
      // request mapping together while the same transaction verifies the live run.
      const submission = await tx.createSubmission({ type: 'input', conversationId: child.id,
        requestId: `steer:${this.options.parentId}:${requestId}`, status: 'queued' });
      inbox.items.push({ id: submission.id, mode: 'steer', content: `${source === 'user' ? 'User' : 'Parent'} steering:\n\n${task}` });
      const run = latest(child);
      run.steering ??= [];
      run.steering.push({ id: submission.id, task, ...(source === 'user' ? { source } : {}) });
      state.requests[`r:${requestId}`] = { id, run: run.run, input };
    }, C);
    this.harness.resume(); this.scheduleRefresh();
    return this.get(id);
  }

  private async validateWorkspace(child: SavedChild): Promise<void> {
    if (!child.worktree) return;
    if (!child.worktree.ready || child.cwd !== join(child.worktree.path, child.worktree.relativeCwd)) throw new Error('Child worktree is not ready or its saved working directory changed.');
    await verifyWorktree(child.worktree);
  }
  private async prepareWorkspace(child: SavedChild): Promise<void> {
    if (!child.worktree) return;
    const key = String(child.id);
    let preparing = this.workspaces.get(key);
    if (!preparing) {
      preparing = (async () => {
        await ensureWorktree(child.worktree!);
        await this.harness.commit(async tx => {
          const current = (await tx.doc(Children)).children[key];
          this.check(clone(current), false);
          current.worktree!.ready = true;
        }, C);
      })();
      this.workspaces.set(key, preparing);
    }
    try { await preparing; } finally { if (this.workspaces.get(key) === preparing) this.workspaces.delete(key); }
  }

  private async admit(child: SavedChild): Promise<void> {
    if (this.ended) throw new Error('The child runtime is closed.');
    this.check(child);
    await this.validateWorkspace(child);
    await this.options.capabilities?.validate(child.capabilities ?? emptyCapabilities());
    const run = latest(child);
    await this.lifecycle(child, 'start');
    await this.exclusive(String(child.id), async () => {
      const currentChild = await this.saved(child.id);
      if (latest(currentChild).run !== run.run) return;
      this.check(currentChild);
      const conversation = (await this.harness.conversation(child.id, C))!;
      const submission = await conversation.submit({ type: 'input', content: `Assigned task:\n\n${run.task}`,
        requestId: `task:${run.receipt}` }, C);
      const active = await this.harness.commit(async tx => {
        const current = latest((await tx.doc(Children)).children[child.id]);
        if (current.run === run.run && isRunning(current)) { current.submissionId = submission.id; current.status = 'running'; return true; }
        return false;
      }, C);
      if (!active) { await conversation.abort(C); return; }
      this.armDeadline(child);
      this.scheduleRefresh();
    });
  }

  private armDeadline(child: SavedChild): void {
    const run = latest(child);
    clearTimeout(this.deadlines.get(String(child.id)));
    const timer = setTimeout(() => void this.stop(String(child.id), false, 'Task deadline exceeded.').catch(this.options.error),
      Math.max(1, run.startedAt + child.settings.timeoutSeconds * 1000 - Date.now()));
    timer.unref(); this.deadlines.set(String(child.id), timer);
  }

  /** Restore admission records, reconcile results, and resume eligible work. */
  async resume(id?: string, retryBlocked = false): Promise<RunSnapshot[]> {
    await this.recoverAdmissions();
    await this.refresh();
    if (id) await this.saved(id);
    const children = Object.values((await this.state()).children).filter(child => !id || String(child.id) === id);
    for (const child of children) {
      if (!isRunning(latest(child)) || child.closed) {
        // An intent to cancel or close may have committed just before a crash.
        if (child.closed || latest(child).status === 'cancelled' || latest(child).status === 'failed') {
          if (this.recovering.get(String(child.id)) === latest(child).run) this.recovering.delete(String(child.id));
        }
        continue;
      }
      try {
        this.check(child, false);
        if (child.delegation) this.checkDelegation(child, await this.state(), false);
      }
      catch (error) {
        if (this.ended) throw error;
        await this.stop(String(child.id), false, error instanceof Error ? error.message : String(error));
        continue;
      }
      try {
        this.checkEnvironment(child);
        if (child.delegation) this.checkDelegation(child, await this.state());
        await this.options.capabilities?.validate(child.capabilities ?? emptyCapabilities());
      } catch (error) {
        await this.park(child, error instanceof Error ? error.message : String(error));
        this.armDeadline(child); continue;
      }
      try {
        await this.prepareWorkspace(child);
        await this.unpark(child);
        const current = await this.saved(child.id);
        await this.ensureLifecycle(current);
        if (!latest(current).submissionId) await this.admit(await this.saved(child.id));
        else this.armDeadline(current);
      } catch (error) {
        if (this.ended) throw error;
        await this.stop(String(child.id), false, error instanceof Error ? error.message : String(error));
      }
    }
    if (retryBlocked) {
      for (const task of (await this.harness.inspect(C)).tasks) {
        const child = (await this.state()).children[String(task.record.conversationId)];
        if (task.state.kind === 'blocked' && task.state.reason === 'restart_limit' && child &&
          !child.closed && !child.recovery && isRunning(latest(child)) && (!id || String(child.id) === id)) {
          this.check(child);
          await this.harness.retryTask(task.record.id, C);
        }
      }
    }
    this.harness.resume();
    await this.refresh();
    return id ? [await this.get(id)] : this.list();
  }

  private async park(child: SavedChild, message: string): Promise<void> {
    const tasks = (await this.harness.inspect(C)).tasks.filter(task => task.record.conversationId === child.id);
    if (tasks.some(task => task.state.kind === 'running')) throw new Error('This child still has live work. Reload before retrying recovery checks.');
    await this.harness.commit(async tx => {
      const current = (await tx.doc(Children)).children[child.id];
      if (!isRunning(latest(current)) || current.closed) return;
      if (!current.recovery) {
        const saved: NonNullable<SavedChild['recovery']>['tasks'] = [];
        const records = await Promise.all(tasks.map(task => tx.task(task.record.id)));
        for (const record of records) {
          if (!record || record.state.status === 'terminal' || record.state.status === 'completing') continue;
          const state = record.state.status === 'running' ? { ...record.state, status: 'pending' as const } : record.state;
          saved.push({ id: record.id, state: clone(state) as unknown as JsonValue });
          // Keep the checkpoint unchanged. No phase, model request, or unsafe tool runs while parked.
          replaceTask(tx, { ...record, state: { status: 'sleeping', checkpoint: record.state.checkpoint, until: Number.MAX_SAFE_INTEGER } });
        }
        current.recovery = { message, tasks: saved };
      } else current.recovery.message = message;
      latest(current).recoveryError = message;
    }, C);
  }
  private async unpark(child: SavedChild): Promise<void> {
    if (!child.recovery) return;
    await this.harness.commit(async tx => {
      const current = (await tx.doc(Children)).children[child.id];
      if (!isRunning(latest(current)) || current.closed || !current.recovery) return;
      this.check(clone(current), false); this.checkEnvironment(clone(current));
      const records = await Promise.all(current.recovery.tasks.map(saved => tx.task(saved.id)));
      for (const [index, saved] of current.recovery.tasks.entries()) {
        const record = records[index];
        if (record?.state.status === 'sleeping') replaceTask(tx, { ...record, state: clone(saved.state) as unknown as TaskState<JsonValue, JsonValue> } as typeof record);
      }
      delete current.recovery; delete latest(current).recoveryError;
    }, C);
  }

  private async recoverAdmissions(): Promise<void> {
    for (const child of Object.values((await this.state()).children)) {
      const run = latest(child);
      if (!isRunning(run) || run.submissionId) continue;
      await this.harness.commit(async tx => {
        const admitted = await tx.submissionByRequest(child.id, `task:${run.receipt}`);
        if (!admitted) return;
        const current = latest((await tx.doc(Children)).children[child.id]);
        if (current.run === run.run && isRunning(current)) { current.submissionId = admitted.id; current.status = 'running'; }
      }, C);
    }
  }

  private scheduleRefresh(): void {
    if (this.ended) return;
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(async () => {
      try { do { this.dirty = false; await this.refresh(); } while (this.dirty && !this.ended); }
      catch (error) { if (!this.ended) this.options.error(error); }
      finally { this.refreshing = false; }
    });
  }
  async refresh(): Promise<void> {
    if (this.ended) return;
    for (const child of Object.values((await this.state()).children)) {
      const run = latest(child);
      if (!isRunning(run)) {
        await this.exclusive(String(child.id), async () => {
          const current = await this.saved(child.id);
          if (!isRunning(latest(current)) && (current.closed || latest(current).status === 'cancelled' || latest(current).status === 'failed')) {
            await (await this.harness.conversation(current.id, C))!.abort(C);
          }
        });
        for (const finished of child.runs) if (!isRunning(finished)) await this.finishTerminal(child, finished);
        continue;
      }
      if (!run.submissionId) continue;
      const statuses = await Promise.all([run.submissionId, ...(run.steering ?? []).map(item => item.id)].map(async id =>
        (await this.harness.submission(id, C))?.status(C)));
      if (statuses.some(status => !status || (status.status !== 'done' && status.status !== 'unanswered'))) continue;
      const status = statuses.find(status => status?.status === 'unanswered') ?? statuses.at(-1);
      if (!status || (status.status !== 'done' && status.status !== 'unanswered')) continue;
      const text = status.status === 'done' && status.type === 'input' ? await this.harness.commit(async tx => {
        const entry = await tx.entry(AssistantEntry, status.answer);
        return entry?.model?.flatMap(message => message.role === 'assistant' ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n') ?? '';
      }, C) : '';
      const usage = await this.harness.snapshot(UsageDoc, child.id, C);
      const entries = await this.entries(String(child.id));
      const settled = await this.harness.commit(async tx => {
        const state = await tx.doc(Children);
        const current = latest(state.children[child.id]);
        if (current.run !== run.run || !isRunning(current) || (current.steering?.length ?? 0) !== (run.steering?.length ?? 0)) return false;
        current.status = status.status === 'done' ? 'completed' : status.reason === 'aborted' ? 'cancelled' : 'failed';
        current.output = text; current.finishedAt = Date.now();
        if (status.status === 'unanswered') current.error = `${status.reason}${status.detail ? ': ' + JSON.stringify(status.detail) : ''}`;
        current.toolCalls = entries.filter(entry => entry.kind !== 'pi-subagents.fork').reduce((sum, entry) => sum + (entry.model?.filter(message => message.role === 'toolResult').length ?? 0), 0);
        delete current.recoveryError; delete state.children[child.id].recovery;
        current.tokens = Object.values(usage?.models ?? {}).reduce((sum, item) => sum + item.totalTokens, 0);
        current.cost = Object.values(usage?.models ?? {}).reduce((sum, item) => sum + item.cost.total, 0);
        this.cancelDescendants(state, String(child.id), current.run);
        return true;
      }, C);
      if (settled) {
        await this.abortDescendants(String(child.id), run.run);
        const currentChild = await this.saved(child.id);
        await this.finishTerminal(currentChild, currentChild.runs[run.run - 1]);
        if (latest(currentChild).run === run.run) { clearTimeout(this.deadlines.get(String(child.id))); this.deadlines.delete(String(child.id)); }
      }
    }
    this.options.changed();
  }
  async stop(id: string, cancelled = true, reason = 'Cancelled by the parent.'): Promise<RunSnapshot> {
    return this.exclusive(id, () => this.stopTask(id, cancelled, reason));
  }
  private async stopTask(id: string, cancelled: boolean, reason: string): Promise<RunSnapshot> {
    // Save the terminal intent before asking Durable to abort. Recovery enforces this intent.
    await this.harness.commit(async tx => {
      const state = await tx.doc(Children);
      const child = state.children[id];
      if (!child) throw new Error(`Unknown child: ${id}.`);
      if (isRunning(latest(child))) Object.assign(latest(child), { status: cancelled ? 'cancelled' : 'failed', error: reason, finishedAt: Date.now() });
      delete child.recovery; delete latest(child).recoveryError;
      this.cancelDescendants(state, id, latest(child).run);
    }, C);
    await this.abortDescendants(id, (await this.get(id)).run);
    for (const event of ['start', 'resume']) this.lifecycleSignals.get(`${id}:${(await this.get(id)).run}:${event}`)?.abort(new Error('Child task cancelled.'));
    clearTimeout(this.deadlines.get(id)); this.deadlines.delete(id);
    await (await this.harness.conversation(Number(id) as ConversationId, C))!.abort(C);
    await this.finishTerminal(await this.saved(id));
    this.options.changed();
    return this.get(id);
  }
  async cancelAll(): Promise<void> { for (const run of await this.list()) if (isRunning(run)) await this.stop(run.id); }
  async close(id: string): Promise<void> { return this.exclusive(id, () => this.closeChild(id)); }
  private async closeChild(id: string): Promise<void> {
    await this.harness.commit(async tx => {
      const state = await tx.doc(Children);
      const child = state.children[id];
      if (!child) throw new Error(`Unknown child: ${id}.`);
      child.closed = true;
      if (isRunning(latest(child))) Object.assign(latest(child), { status: 'cancelled', error: 'Closed by the parent.', finishedAt: Date.now() });
      delete child.recovery; delete latest(child).recoveryError;
      this.cancelDescendants(state, id, latest(child).run);
    }, C);
    await this.abortDescendants(id, (await this.get(id)).run);
    for (const event of ['start', 'resume']) this.lifecycleSignals.get(`${id}:${(await this.get(id)).run}:${event}`)?.abort(new Error('Child closed.'));
    await (await this.harness.conversation(Number(id) as ConversationId, C))!.abort(C);
    await this.finishTerminal(await this.saved(id));
    clearTimeout(this.deadlines.get(id)); this.deadlines.delete(id); this.options.changed();
  }
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<RunSnapshot> {
    const timer = AbortSignal.timeout(Math.min(60000, Math.max(1, timeoutMs)));
    const waitSignal = signal ? AbortSignal.any([signal, timer]) : timer;
    while (!waitSignal.aborted) {
      const run = await this.get(id);
      if (!isRunning(run) || !run.submissionId) return run;
      const submissionId = run.steering?.at(-1)?.id ?? run.submissionId;
      try { await (await this.harness.submission(submissionId, C))!.wait(withAbortSignal(waitSignal, C)); }
      catch (error) { if (!waitSignal.aborted) throw error; }
      await this.refresh();
    }
    return this.get(id);
  }
  async pending(): Promise<RunSnapshot[]> {
    return Object.values((await this.state()).children).flatMap(child => child.closed || child.delegation ? [] : child.runs.filter(run =>
      !isRunning(run) && run.status !== 'cancelled' && !run.delivered).map(clone));
  }
  async pauseNotifications(paused: boolean): Promise<void> {
    await this.harness.commit(async tx => { (await tx.doc(Children)).notificationsPaused = paused; }, C);
  }
  async acknowledge(receipts: string[]): Promise<void> {
    if (!receipts.length || !Object.values((await this.state()).children).some(child => child.runs.some(run => !run.delivered && receipts.includes(run.receipt)))) return;
    await this.harness.commit(async tx => {
      for (const child of Object.values((await tx.doc(Children)).children)) for (const run of child.runs) {
        if (receipts.includes(run.receipt)) run.delivered = true;
      }
    }, C);
  }
  async entries(id: string): Promise<EntryRecord[]> {
    const conversation = await this.harness.conversation(Number(id) as ConversationId, C);
    if (!conversation) throw new Error(`Unknown child: ${id}.`);
    const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await conversation.entries({ order: 'ascending' }, 200, cursor, C); entries.push(...page.items); cursor = page.next; } while (cursor);
    return entries;
  }
  async transcript(id: string): Promise<string> {
    return (await this.entries(id)).map(entry => JSON.stringify(entry)).join('\n');
  }
  async dispose(): Promise<void> {
    if (this.ended) return;
    this.ended = true; this.unsubscribe?.();
    for (const controller of this.lifecycleSignals.values()) controller.abort(new Error('Child lifecycle interrupted by reload or shutdown.'));
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    try { await Promise.allSettled(this.lifecycleJobs.values()); await Promise.allSettled(this.workspaces.values()); await Promise.allSettled(this.operations.values()); await this.harness.close(C); } finally { try { await this.options.capabilities?.close(); } finally { this.store.release(); } }
  }
}
