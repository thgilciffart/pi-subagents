import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus, ModelRuntime, ModelRegistry, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { visibleWidth } from '@earendil-works/pi-tui';
import subagents from '../src/index.ts';
import type { SubagentRuntime } from '../src/runtime.ts';
import { RESULT_MESSAGE } from '../src/receipts.ts';
import { registerChildHook } from '../src/capabilities.ts';
import { formatSubagentStatus, SubagentInspector } from '../src/ui.ts';

initTheme('dark');
const flush = () => new Promise(resolve => setTimeout(resolve, 100));
async function harness(persistent = false) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-extension-'));
  const cwd = join(dir, 'project'), agentDir = join(dir, 'agent'); await mkdir(cwd); await mkdir(agentDir);
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond: Infinity }); models.registerNativeProvider(faux.provider);
  let manager = persistent ? SessionManager.create(cwd, join(dir, 'sessions')) : SessionManager.inMemory(cwd);
  const handlers = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>(), renderers = new Map<string, any>(), shortcuts = new Map<string, any>();
  const messages: any[] = [], notifications: any[] = [], statuses: any[] = [], footers: any[] = [];
  let runtime!: SubagentRuntime, persistMessages = true, sequence = 0;
  const context: any = { cwd, mode: 'tui', hasUI: true, model: faux.models[0], modelRegistry: new ModelRegistry(models),
    scopedModels: [], thinkingLevel: 'off', isProjectTrusted: () => true, sessionManager: manager, isIdle: () => true,
    ui: { setStatus: (key: string, value: unknown) => statuses.push({ key, value }), notify: (text: string) => notifications.push(text),
      setFooter: (factory: any) => footers.push(factory), select: async () => undefined, editor: async () => undefined } };
  const pi: any = {
    events: createEventBus(), getCommands: () => [], getAllTools: () => [], getMcpServers: () => [], getActiveTools: () => [],
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut), getSettings: () => ({}),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer), getThinkingLevel: () => 'off',
    sendMessage: (message: any, options: any) => {
      messages.push({ message, options });
      if (persistMessages) manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
  const install = () => subagents(pi, { agentDir, onRuntime: value => { runtime = value; } });
  install();
  const emit = async (name: string, event = {}) => handlers.get(name)?.({ type: name, ...event }, context);
  await emit('session_start');
  const tool = async (params: any, persist = true) => {
    const callId = `call-${++sequence}`;
    const result = await tools.get('subagent').execute(callId, params, undefined, undefined, context);
    if (persist) manager.appendMessage({ role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: result.content,
      isError: result.isError ?? false, timestamp: Date.now(), details: result.details });
    return result;
  };
  return { dir, cwd, agentDir, context, models, faux, messages, notifications, statuses, footers, commands, renderers, shortcuts, emit, tool, get runtime() { return runtime; }, pi,
    persist: (value: boolean) => { persistMessages = value; },
    reload: async () => {
      await emit('session_shutdown');
      // Recreate extension closure as /reload does, retaining the native parent transcript.
      install(); await emit('session_start');
    },
    switchSession: async () => { await emit('session_shutdown'); manager = SessionManager.inMemory(cwd); context.sessionManager = manager; await emit('session_start'); },
    cleanup: async () => { await emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); } };
}

describe('parent extension delivery and lifecycle', () => {
  test('completion is collapsed, uses one status key, and is not delivered again after reload', async () => {
    const h = await harness(true);
    try {
      h.faux.setResponses([answer('Evidence from the child')]);
      const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
      expect(spawned.isError).not.toBe(true);
      const id = spawned.details.runs[0].id;
      await h.runtime.wait(id, 3000); await flush();
      expect(h.messages).toHaveLength(1);
      const theme = { fg: (_name: string, text: string) => text };
      expect(h.renderers.get(RESULT_MESSAGE)(h.messages[0].message, { expanded: false }, theme).render(80)).toHaveLength(1);
      expect(h.renderers.get(RESULT_MESSAGE)(h.messages[0].message, { expanded: true }, theme).render(80).join('\n')).toContain('Evidence');
      expect(new Set(h.statuses.map(item => item.key))).toEqual(new Set(['pi-subagents']));
      await h.reload(); await flush();
      expect(h.messages).toHaveLength(1); expect(h.faux.state.callCount).toBe(1);
      expect(await h.runtime.pending()).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  test('a result queued only in memory is recovered and delivered once', async () => {
    const h = await harness(true);
    try {
      h.persist(false); h.faux.setResponses([answer('Pending result')]);
      const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
      await h.runtime.wait(spawned.details.runs[0].id, 3000); await flush();
      expect(h.messages).toHaveLength(1); expect(await h.runtime.pending()).toHaveLength(1);
      h.persist(true); await h.reload(); await flush();
      expect(h.messages).toHaveLength(2);
      expect(h.messages[1].message.details.receipts).toEqual(h.messages[0].message.details.receipts);
      await h.reload(); await flush(); expect(h.messages).toHaveLength(2);
    } finally { await h.cleanup(); }
  });
  test('a persisted wait result acknowledges the outbox without an automatic duplicate', async () => {
    const h = await harness(true);
    try {
      h.faux.setResponses([answer('Waited result')]);
      const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
      await h.tool({ action: 'wait', id: spawned.details.runs[0].id });
      await h.emit('agent_settled', { aborted: false }); await flush();
      expect(h.messages).toHaveLength(0);
      await h.reload(); await flush(); expect(h.messages).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  test('an unpersisted tool result stays pending across reload', async () => {
    const h = await harness(true);
    try {
      h.faux.setResponses([answer('Unacknowledged tool result')]);
      const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
      await h.tool({ action: 'wait', id: spawned.details.runs[0].id }, false);
      await h.reload(); await flush(); expect(h.messages).toHaveLength(1);
      expect(h.messages[0].message.content).toContain('Unacknowledged tool result');
    } finally { await h.cleanup(); }
  });
  test('explicit request IDs survive reload and reject conflicting requests', async () => {
    const h = await harness(true);
    try {
      h.faux.setResponses([answer('Done')]);
      const params = { action: 'spawn', agent: 'Explore', task: 'Inspect', requestId: 'stable-key' };
      const first = await h.tool(params); await h.runtime.wait(first.details.runs[0].id, 3000);
      await h.reload();
      const second = await h.tool(params);
      expect(second.details.runs[0].id).toBe(first.details.runs[0].id);
      expect((await h.tool({ ...params, task: 'different' })).isError).toBe(true);
      expect(await h.runtime.list()).toHaveLength(1); expect(h.faux.state.callCount).toBe(1);
    } finally { await h.cleanup(); }
  });
  test('rejects model, thinking, tool, and untrusted project overrides before launch', async () => {
    const h = await harness();
    try {
      for (const extra of [{ model: 'unknown/missing' }, { thinking: 'max' }, { tools: ['bash'] }]) {
        expect((await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', ...extra })).isError).toBe(true);
      }
      await mkdir(join(h.cwd, '.pi', 'agents'), { recursive: true });
      await writeFile(join(h.cwd, '.pi', 'agents', 'local.md'), '---\nname: local\ndescription: Local\n---\nInspect');
      h.context.isProjectTrusted = () => false;
      expect((await h.tool({ action: 'list' })).content[0].text).not.toContain('local:');
      expect(await h.runtime.list()).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  test('the parent selects capabilities through spawn and an empty override clears definition defaults', async () => {
    const h = await harness(true);
    try {
      const base = join(h.agentDir, 'skills', 'evidence'); await mkdir(base, { recursive: true });
      const path = join(base, 'SKILL.md'); await writeFile(path, 'PARENT_SELECTED_SKILL');
      h.pi.getCommands = () => [{ name: 'skill:evidence', source: 'skill', sourceInfo: { path, scope: 'user' } }];
      registerChildHook(h.pi, { name: 'policy', version: '1', permissions: 'read-only', replay: 'safe', project: false });
      h.faux.setResponses([context => { expect(JSON.stringify(context)).toContain('PARENT_SELECTED_SKILL'); return answer('Selected'); },
        context => { expect(JSON.stringify(context)).not.toContain('PARENT_SELECTED_SKILL'); return answer('Cleared'); }]);
      const first = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', skills: ['evidence'], hooks: ['policy'], requestId: 'selected' });
      expect(first.isError).not.toBe(true); await h.runtime.wait(first.details.runs[0].id, 3000);
      expect(first.details.runs[0].capabilities).toEqual({ skills: ['evidence'], hooks: ['policy'], mcpTools: [] });
      expect((await h.tool({ action: 'list' })).content[0].text).toContain('evidence');
      expect((await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', skills: [], hooks: [], requestId: 'selected' })).isError).toBe(true);
      await mkdir(join(h.agentDir, 'agents'), { recursive: true });
      await writeFile(join(h.agentDir, 'agents', 'selected.md'), '---\nname: selected\ndescription: Selected\nskills: [evidence]\nhooks: [policy]\n---\nInspect');
      const second = await h.tool({ action: 'spawn', agent: 'selected', task: 'Inspect', skills: [], hooks: [] });
      await h.runtime.wait(second.details.runs[0].id, 3000);
      expect((await h.runtime.saved(second.details.runs[0].id)).capabilities).toEqual({ skills: [], hooks: [], mcpTools: [] });
    } finally { await h.cleanup(); }
  });
  test('skill inheritance and exclusions resolve through launch and definition settings without widening saved children', async () => {
    const h = await harness(true);
    try {
      const commands: any[] = [];
      for (const name of ['inspect', 'publish']) {
        const base = join(h.agentDir, 'skills', name); await mkdir(base, { recursive: true });
        const path = join(base, 'SKILL.md'); await writeFile(path, `${name.toUpperCase()}_PRIVATE_BODY`);
        commands.push({ name: `skill:${name}`, description: `${name} skill`, source: 'skill', sourceInfo: { path, scope: 'user' } });
      }
      h.pi.getCommands = () => commands;
      await mkdir(join(h.agentDir, 'agents'), { recursive: true });
      await writeFile(join(h.agentDir, 'agents', 'filtered.md'), '---\nname: filtered\ndescription: Filtered\ndisabledSkills: [publish]\n---\nInspect');
      await writeFile(join(h.agentDir, 'agents', 'narrow.md'), '---\nname: narrow\ndescription: Narrow\nskills: [inspect]\n---\nInspect');
      const cases = [
        { params: { agent: 'Explore' }, skills: ['inspect', 'publish'] },
        { params: { agent: 'Explore', disabledSkills: ['publish'] }, skills: ['inspect'] },
        { params: { agent: 'Explore', skills: [] }, skills: [] },
        { params: { agent: 'filtered' }, skills: ['inspect'] },
        { params: { agent: 'filtered', disabledSkills: [] }, skills: ['inspect', 'publish'] },
        { params: { agent: 'narrow', skills: 'inherit' }, skills: ['inspect', 'publish'] },
      ];
      h.faux.setResponses(cases.map(() => context => {
        expect(JSON.stringify(context)).not.toContain('_PRIVATE_BODY'); return answer('Inherited on demand');
      }));
      const ids: string[] = [];
      for (const entry of cases) {
        const result = await h.tool({ action: 'spawn', task: 'Inspect', ...entry.params });
        expect(result.isError, result.content[0].text).not.toBe(true);
        const run = result.details.runs[0]; ids.push(run.id);
        expect(run.capabilities.skills).toEqual(entry.skills);
        await h.runtime.wait(run.id, 3000);
      }
      const conflict = { action: 'spawn', agent: 'Explore', task: 'Inspect', requestId: 'exclusions', disabledSkills: ['publish'] };
      h.faux.setResponses([answer('Stable exclusions')]);
      const original = await h.tool(conflict); await h.runtime.wait(original.details.runs[0].id, 3000);
      expect((await h.tool({ ...conflict, disabledSkills: [] })).isError).toBe(true);
      commands.push({ ...commands[0], name: 'skill:newly-added' });
      await h.reload();
      expect((await h.runtime.saved(ids[1])).capabilities?.skills.map(skill => skill.name)).toEqual(['inspect']);
      expect((await h.runtime.saved(ids[2])).capabilities?.skills).toEqual([]);
      expect((await h.tool(conflict)).details.runs[0].id).toBe(original.details.runs[0].id);
      expect((await h.tool({ action: 'list' })).content[0].text).toContain('skills: inherit');
    } finally { await h.cleanup(); }
  });
  test('parent-selected untrusted children start empty and accept only explicit allowlists', async () => {
    const h = await harness(true); let starts = 0;
    try {
      const base = join(h.agentDir, 'skills', 'inspect'); await mkdir(base, { recursive: true });
      const path = join(base, 'SKILL.md'); await writeFile(path, 'EXPLICIT_SKILL');
      h.pi.getCommands = () => [{ name: 'skill:inspect', source: 'skill', sourceInfo: { path, scope: 'user' } }];
      registerChildHook(h.pi, { name: 'audit', version: '1', permissions: 'read-only', replay: 'safe', project: false, onStart: () => { starts++; } });
      h.faux.setResponses([context => { expect(JSON.stringify(context)).not.toContain('EXPLICIT_SKILL'); return answer('Empty'); }, answer('Explicit')]);
      const none = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', trust: 'untrusted', requestId: 'empty' });
      expect(none.isError).not.toBe(true); const id = none.details.runs[0].id; await h.runtime.wait(id, 3000);
      expect(none.details.runs[0].tools).toEqual([]); expect(none.details.runs[0].capabilities).toEqual({ skills: [], mcpTools: [], hooks: [] }); expect(starts).toBe(0);
      const explicit = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', trust: 'untrusted', tools: ['read'], skills: ['inspect'], hooks: ['audit'] });
      await h.runtime.wait(explicit.details.runs[0].id, 3000); expect(starts).toBe(1);
      expect(explicit.details.runs[0].tools).toEqual(['read', 'skill_read']);
      for (const override of [{ skills: 'inherit' }, { mcpTools: 'inherit' }, { hooks: 'inherit' }, { mcpServers: ['docs'] }, { tools: ['bash'] }]) {
        expect((await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', trust: 'untrusted', ...override })).isError).toBe(true);
      }
      await h.reload(); expect((await h.runtime.get(id)).trust).toBe('untrusted'); expect((await h.runtime.get(id)).tools).toEqual([]);
      expect((await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', trust: 'trusted', requestId: 'empty' })).isError).toBe(true);
    } finally { await h.cleanup(); }
  });
  test('omitted untrusted tool defaults allow a parent list within the declared ceiling and list respects model scope', async () => {
    const h = await harness();
    try {
      await mkdir(join(h.agentDir, 'agents'), { recursive: true });
      await writeFile(join(h.agentDir, 'agents', 'limited.md'), '---\nname: limited\ndescription: Limited\ntrust: untrusted\npermissions: read-only\n---\nInspect');
      await writeFile(join(h.agentDir, 'agents', 'filtered.md'), '---\nname: filtered\ndescription: Filtered\npermissions: edit\ndisabledTools: [write]\n---\nInspect');
      h.faux.setResponses([answer('Read allowed')]);
      const launched = await h.tool({ action: 'spawn', agent: 'limited', task: 'Inspect', tools: ['read'] });
      expect(launched.isError).not.toBe(true); await h.runtime.wait(launched.details.runs[0].id, 3000);
      expect(launched.details.runs[0].tools).toEqual(['read']);
      expect((await h.tool({ action: 'list' })).content[0].text).toContain('disabled tools: write');
      h.context.scopedModels = [{ model: { ...h.faux.models[0], id: 'only-other-model' } }];
      expect((await h.tool({ action: 'list' })).content[0].text).not.toContain('faux/faux-1');
      const excluded = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', isolation: 'worktree' });
      expect(excluded.isError).toBe(true); expect(excluded.content[0].text).toContain('outside the parent session model scope');
      expect(await h.runtime.list()).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  test('parent cancellation remains final after reload and does not wake the parent', async () => {
    const h = await harness(true);
    try {
      let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
      h.faux.setResponses([async (_context, options) => {
        started(); await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return answer('', { stopReason: 'aborted' });
      }]);
      const controller = new AbortController(); h.context.signal = controller.signal;
      await h.emit('agent_start');
      const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' }); await begun;
      controller.abort(); await h.emit('agent_settled', { aborted: true }); await flush();
      expect((await h.runtime.get(spawned.details.runs[0].id)).status).toBe('cancelled');
      h.context.signal = undefined;
      await h.reload(); await flush();
      expect(h.messages).toHaveLength(0); expect(h.faux.state.callCount).toBe(1);
    } finally { await h.cleanup(); }
  });
});

test('the shared status and transcript inspector stay within the terminal width', () => {
  const runs = Array.from({ length: 16 }, (_, i) => ({ id: String(i), agent: `worker${i}`, status: 'running', activity: 'read' })) as any;
  expect(formatSubagentStatus(runs)).toContain('Subagents 16');
  expect(formatSubagentStatus(runs)!.length).toBeLessThan(120);
  const inspector = new SubagentInspector('Transcript', () => 'content\n'.repeat(1000), () => {}, () => {}, 20);
  try { for (const width of [1, 10, 80]) expect(inspector.render(width).every(row => visibleWidth(row) <= width)).toBe(true); }
  finally { inspector.dispose(); }
});

test('Ctrl+Alt+A opens the subagent picker', async () => {
  const h = await harness();
  try {
    let title = '';
    h.context.ui.select = async (value: string) => { title = value; return undefined; };
    await h.shortcuts.get('ctrl+alt+a').handler(h.context);
    expect(title).toContain('Subagents');
    expect(title).toContain('persistent child ID');
  } finally { await h.cleanup(); }
});

test('the first-line footer can switch back to the ordinary status row', async () => {
  const h = await harness();
  try {
    expect(typeof h.footers.at(-1)).toBe('function');
    h.context.ui.editor = async (_title: string, value: string) => JSON.stringify({ ...JSON.parse(value), indicatorPosition: 'status' });
    await h.commands.get('agents').handler('config', h.context);
    expect(h.footers.at(-1)).toBeUndefined();
    await h.reload();
    expect(h.footers.filter(Boolean)).toHaveLength(1);
  } finally { await h.cleanup(); }
});

test('the parent tool accepts steering and forked context', async () => {
  const h = await harness(true);
  let release!: () => void;
  try {
    const manager = h.context.sessionManager as SessionManager;
    manager.appendMessage({ role: 'user', content: 'PARENT_FORK_MARKER', timestamp: Date.now() });
    let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let copied = false;
    h.faux.setResponses([async context => { copied = JSON.stringify(context).includes('PARENT_FORK_MARKER'); started(); await gate; return answer('First'); }, answer('Steered result')]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Fork this conversation', context: 'fork' });
    expect(spawned.isError).not.toBe(true); await begun;
    const id = spawned.details.runs[0].id;
    const steered = await h.tool({ action: 'steer', id, task: 'Change focus', requestId: 'focus' });
    expect(steered.isError).not.toBe(true); expect(steered.details.runs[0].steering).toHaveLength(1);
    release(); await h.runtime.wait(id, 3000); await flush();
    expect(copied).toBe(true); expect(h.messages).toHaveLength(1);
    expect(h.messages[0].message.content).toContain('Steered result');
  } finally { release?.(); await h.cleanup(); }
});
