import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus, ModelRuntime, ModelRegistry, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { getCapabilities, setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
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
  const messages: any[] = [], notifications: any[] = [], statuses: any[] = [], footers: any[] = [], customViews: any[] = [], customOptions: any[] = [];
  const forwarded: string[] = [];
  let editorText = '';
  const baseFactory = () => ({ getText: () => editorText, handleInput: (data: string) => forwarded.push(data) });
  let editorFactory: any = baseFactory, editor = baseFactory();
  let runtime!: SubagentRuntime, persistMessages = true, sequence = 0;
  let interact: (component: any) => void | Promise<void> = () => {};
  const context: any = { cwd, mode: 'tui', hasUI: true, model: faux.models[0], modelRegistry: new ModelRegistry(models),
    scopedModels: [], thinkingLevel: 'off', isProjectTrusted: () => true, sessionManager: manager, isIdle: () => true,
    ui: { setStatus: (key: string, value: unknown) => statuses.push({ key, value }), notify: (text: string) => notifications.push(text),
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: any) => { editorFactory = factory ?? baseFactory; editor = editorFactory({}, {}, {}); },
      custom: async (factory: any, options: any) => {
        let result: any;
        const component = await factory({ terminal: { rows: 32 }, requestRender: () => {} }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, (value: any) => { result = value; });
        await interact(component);
        customViews.push(component.render(120));
        customOptions.push(options);
        component.dispose?.();
        return result;
      },
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
  const tool = async (params: any, persist = true, providedId?: string) => {
    const callId = providedId ?? `call-${++sequence}`;
    const result = await tools.get('subagent').execute(callId, params, undefined, undefined, context);
    if (persist) manager.appendMessage({ role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: result.content,
      isError: result.isError ?? false, timestamp: Date.now(), details: result.details });
    return result;
  };
  return { dir, cwd, agentDir, context, models, faux, messages, notifications, statuses, footers, commands, renderers, tools, shortcuts, customViews, customOptions, emit, tool, forwarded,
    get editor() { return editor; }, text: (value: string) => { editorText = value; }, get runtime() { return runtime; }, pi,
    onCustom: (handler: typeof interact) => { interact = handler; },
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

test('Shift+Left opens the picker with text or an empty editor and survives reload', async () => {
  const h = await harness();
  try {
    expect(h.customViews).toHaveLength(0);
    h.text('some words');
    h.editor.handleInput('\x1b[1;3D');
    await flush();
    expect(h.customViews).toHaveLength(0);
    expect(h.forwarded).toEqual(['\x1b[1;3D']);
    h.editor.handleInput('\x1b[1;2D');
    await flush();
    expect(h.customViews.at(-1).join('\n')).toContain('Subagents');
    expect(h.customViews.at(-1).join('\n')).toContain('Enter chat');
    expect(h.editor.getText()).toBe('some words');
    expect(h.shortcuts.size).toBe(0);
    h.customViews.length = 0;
    await h.reload();
    h.text('');
    h.editor.handleInput('\x1b[1;2D');
    await flush();
    expect(h.customViews.at(-1).join('\n')).toContain('Subagents');
  } finally { await h.cleanup(); }
});

test('the first-line footer can switch back to the ordinary status row', async () => {
  const h = await harness();
  try {
    expect(typeof h.footers.at(-1)).toBe('function');
    h.onCustom(async component => {
      component.handleInput('\r'); component.handleInput('\x1b[B'); component.handleInput('\r');
      await expect.poll(() => h.footers.at(-1)).toBeUndefined(); component.handleInput('\x1b');
    });
    await h.commands.get('agents').handler('config', h.context);
    expect(h.footers.at(-1)).toBeUndefined();
    await h.reload();
    expect(h.footers.filter(Boolean)).toHaveLength(1);
  } finally { await h.cleanup(); }
});

test('task completion leaves the detailed browser hidden until Shift+Left opens it', async () => {
  const h = await harness();
  try {
    h.faux.setResponses([answer('Finished quietly')]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect the task tree' });
    await h.runtime.wait(spawned.details.runs[0].id, 3000); await flush();
    expect(h.customViews).toHaveLength(0);
    h.editor.handleInput('\x1b[1;2D'); await flush();
    expect(h.customViews).toHaveLength(1);
    expect(h.customViews[0].join('\n')).toContain('Completed');
    expect(h.customViews[0].join('\n')).toContain('Inspect the task tree');
  } finally { await h.cleanup(); }
});

test('a saved child chat opens across the full terminal after reload', async () => {
  const h = await harness(true);
  try {
    h.faux.setResponses([answer('Saved child evidence')]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect saved chat' });
    const id = spawned.details.runs[0].id;
    await h.runtime.wait(id, 3000);
    await h.reload();
    h.text('Keep the parent draft');
    await h.commands.get('agents').handler(id, h.context);
    expect(h.customOptions.at(-1)).toEqual({ overlay: true,
      overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
    expect(h.customViews.at(-1)).toHaveLength(32);
    expect(h.customViews.at(-1).join('\n')).toContain('Saved child evidence');
    expect(h.customViews.at(-1).at(-1)).toContain('Esc back');
    expect(h.editor.getText()).toBe('Keep the parent draft');
  } finally { await h.cleanup(); }
});

test('image-capable terminals use an inline child chat instead of covering transcript images', async () => {
  const capabilities = getCapabilities(), h = await harness();
  try {
    h.faux.setResponses([answer('Image terminal reply')]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect image terminal' });
    await h.runtime.wait(spawned.details.runs[0].id, 3000);
    for (const images of ['kitty', 'iterm2'] as const) {
      setCapabilities({ ...capabilities, images });
      await h.commands.get('agents').handler(spawned.details.runs[0].id, h.context);
      expect(h.customOptions.at(-1)).toBeUndefined();
      expect(h.customViews.at(-1)).toHaveLength(26);
      expect(h.customViews.at(-1).join('\n')).toContain('Image terminal reply');
    }
  } finally { setCapabilities(capabilities); await h.cleanup(); }
});

test('non-terminal child inspection keeps the saved transcript available as text', async () => {
  const h = await harness();
  try {
    h.faux.setResponses([answer('RPC child evidence')]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect RPC transcript' });
    await h.runtime.wait(spawned.details.runs[0].id, 3000);
    h.context.mode = 'rpc'; h.context.hasUI = false;
    await h.commands.get('agents').handler(spawned.details.runs[0].id, h.context);
    expect(h.notifications.at(-1)).toContain('"role":"user"');
    expect(h.notifications.at(-1)).toContain('RPC child evidence');
    expect(h.customViews).toHaveLength(0);
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

test('failed startup can be repaired through interactive settings without a JSON editor', async () => {
  const h = await harness();
  try {
    const path = join(h.agentDir, 'subagents', 'settings.json');
    await mkdir(join(h.agentDir, 'subagents'), { recursive: true }); await writeFile(path, '{"maxTurns":0}');
    await expect(h.reload()).rejects.toThrow('maxTurns');
    h.context.ui.editor = () => { throw new Error('Raw JSON editor must not open'); };
    h.onCustom(async component => {
      expect(component.render(120).join('\n')).toContain('Invalid values replaced with defaults');
      component.handleInput('\x1b[A'); component.handleInput('\r');
      await expect.poll(async () => JSON.parse(await readFile(path, 'utf8')).maxTurns).toBe(20);
      component.handleInput('\x1b');
    });
    await h.commands.get('agents').handler('config', h.context);
    expect(JSON.parse(await readFile(path, 'utf8')).maxTurns).toBe(20);
    expect((await h.tool({ action: 'list' })).isError).not.toBe(true);
  } finally { await h.cleanup(); }
});

test('fixing a settings file externally lets the next call retry startup', async () => {
  const h = await harness();
  try {
    await mkdir(join(h.agentDir, 'subagents'), { recursive: true });
    const path = join(h.agentDir, 'subagents', 'settings.json'); await writeFile(path, '{');
    await expect(h.reload()).rejects.toThrow(); await writeFile(path, '{}');
    expect((await h.tool({ action: 'list' })).isError).not.toBe(true);
  } finally { await h.cleanup(); }
});

test('expanded tool and message results strip terminal controls while preserving text layout', async () => {
  const h = await harness();
  try {
    const hostile = 'Before\n\tAfter\x1b]52;c;ZXZpbA==\x07\x1b]0;evil\x07\x1b[2J';
    const theme = { fg: (_name: string, text: string) => text };
    const tool = h.tools.get('subagent').renderResult({ content: [{ type: 'text', text: hostile }], details: { summary: hostile } }, { expanded: true }, theme);
    const message = h.renderers.get(RESULT_MESSAGE)({ content: hostile }, { expanded: true }, theme);
    for (const component of [tool, message]) {
      const output = component.render(100).join('\n');
      expect(output).not.toContain('\x1b'); expect(output).not.toContain('\x07');
      expect(output).toMatch(/Before\s*\n/); expect(output).toContain('After');
    }
  } finally { await h.cleanup(); }
});

test('synchronous admission failures carry a receipt and are not delivered again after reload', async () => {
  const h = await harness(true);
  let release!: () => void;
  try {
    let stopped!: () => void; const stopping = new Promise<void>(resolve => { stopped = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    registerChildHook(h.pi, { name: 'deny', version: '1', permissions: 'read-only', replay: 'safe', project: false,
      onStart: () => { throw new Error('Start denied'); }, onStop: async () => { stopped(); await gate; } });
    const starting = h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect', hooks: ['deny'] });
    await stopping; await flush(); expect(h.messages).toHaveLength(0);
    release(); const result = await starting;
    expect(result.isError).toBe(true); expect(result.details.receipts).toHaveLength(1);
    await flush(); expect(h.messages).toHaveLength(0);
    await h.reload(); await flush(); expect(h.messages).toHaveLength(0);
    expect(await h.runtime.pending()).toEqual([]);
  } finally { release?.(); await h.cleanup(); }
});

test('RPC listings use notifications even with hasUI true and commands accept displayed IDs', async () => {
  const h = await harness();
  try {
    h.faux.setResponses([answer('Saved result')]);
    const result = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
    const id = result.details.runs[0].id; await h.runtime.wait(id, 3000);
    h.context.mode = 'rpc';
    await h.commands.get('agents').handler('', h.context);
    expect(h.notifications.at(-1)).toContain(`#${id}`); expect(h.customViews).toHaveLength(0);
    await h.commands.get('agents').handler(`#${id}`, h.context);
    expect(h.notifications.at(-1)).toContain('Saved result');
  } finally { await h.cleanup(); }
});

test('empty tool-call IDs require explicit request keys and repeated IDs are scoped to parent messages', async () => {
  const h = await harness(true);
  try {
    const params = { action: 'spawn', agent: 'Explore', task: 'Inspect' };
    expect((await h.tool(params, false, '')).isError).toBe(true);
    h.faux.setResponses([answer('One'), answer('Two')]);
    const { fauxToolCall } = await import('@earendil-works/pi-ai/providers/faux');
    const add = () => h.context.sessionManager.appendMessage(answer(fauxToolCall('subagent', params, { id: 'call_0' }), { stopReason: 'toolUse' }));
    add(); const first = await h.tool(params, true, 'call_0'); await h.runtime.wait(first.details.runs[0].id, 3000);
    expect((await h.tool(params, true, 'call_0')).details.runs[0].id).toBe(first.details.runs[0].id);
    add(); const second = await h.tool(params, true, 'call_0');
    expect(second.details.runs[0].id).not.toBe(first.details.runs[0].id);
    await h.runtime.wait(second.details.runs[0].id, 3000);
  } finally { await h.cleanup(); }
});

test('results completed during compaction are delivered once when the parent becomes idle', async () => {
  const h = await harness(true); let idle = false;
  try {
    h.context.isIdle = () => idle;
    h.faux.setResponses([answer('Result during compaction')]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
    await h.runtime.wait(spawned.details.runs[0].id, 3000); await flush(); expect(h.messages).toHaveLength(0);
    idle = true;
    await expect.poll(() => h.messages.length).toBe(1);
    await flush(); expect(h.messages).toHaveLength(1);
  } finally { await h.cleanup(); }
});

test('runtime model and effort overrides leave the named agent permission policy unchanged', async () => {
  const h = await harness();
  try {
    const reasoning = fauxProvider({ provider: 'reasoning-fixture', models: [{ id: 'local', reasoning: true }], tokensPerSecond: Infinity });
    h.models.registerNativeProvider(reasoning.provider);
    await mkdir(join(h.agentDir, 'agents'), { recursive: true });
    await writeFile(join(h.agentDir, 'agents', 'inspect.md'), '---\nname: inspect\ndescription: Inspect assigned files.\npermissions: read-only\ntools: [read]\nmodel: reasoning-fixture/local\nthinking: high\n---\nInspect the assigned files.');
    h.faux.setResponses([answer('Lower effort task')]); reasoning.setResponses([answer('Higher effort task')]);
    const light = await h.tool({ action: 'spawn', agent: 'inspect', task: 'Find a file', model: 'current', thinking: 'off' });
    expect(light.isError).not.toBe(true);
    const lightId = light.details.runs[0].id; await h.runtime.wait(lightId, 3000);
    const deep = await h.tool({ action: 'spawn', agent: 'inspect', task: 'Trace interactions' });
    expect(deep.isError).not.toBe(true);
    const deepId = deep.details.runs[0].id; await h.runtime.wait(deepId, 3000);
    const a = await h.runtime.saved(lightId), b = await h.runtime.saved(deepId);
    expect(a.model).toBe('faux/faux-1'); expect(a.thinking).toBe('off');
    expect(b.model).toBe('reasoning-fixture/local'); expect(b.thinking).toBe('high');
    expect(a.policy).toEqual(b.policy); expect(a.tools).toEqual(['read']);
  } finally { await h.cleanup(); }
});

test('parent result metadata clips child output but the saved child keeps the full result', async () => {
  const h = await harness(true);
  try {
    const output = 'evidence '.repeat(400);
    h.faux.setResponses([answer(output)]);
    const spawned = await h.tool({ action: 'spawn', agent: 'Explore', task: 'Inspect' });
    const id = spawned.details.runs[0].id; await h.runtime.wait(id, 3000); await flush();
    expect(h.messages[0].message.details.runs[0].output.length).toBeLessThan(2200);
    expect((await h.runtime.get(id)).output).toBe(output);
  } finally { await h.cleanup(); }
});
