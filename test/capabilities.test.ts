import { describe, expect, test } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus, type ToolInfo } from '@earendil-works/pi-coding-agent';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BUILTIN_AGENTS, PERMISSION_TOOLS } from '../src/agents.ts';
import { capabilityPrompt, capabilityTools, emptyCapabilities, ParentCapabilities, registerChildHook, type ChildHook, type McpBridge, type McpSnapshot } from '../src/capabilities.ts';
import { NativeMcpBridge } from '../src/mcp.ts';
import { git } from '../src/worktrees.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

const call = (name: string, args: Record<string, any>) => answer(fauxToolCall(name, args), { stopReason: 'toolUse' });
const noMcp: McpBridge = { catalog: async () => [], validate: async () => {}, call: async () => { throw new Error('No MCP'); }, close: async () => {} };
function setup(mcp: McpBridge = noMcp) {
  const events = createEventBus();
  let commands: any[] = [], trusted = true, capabilities!: ParentCapabilities;
  let parentCwd = process.cwd();
  const create = (paths?: { cwd: string }) => { parentCwd = paths?.cwd ?? parentCwd; return capabilities = new ParentCapabilities({ events, getCommands: () => commands }, () => ({ cwd: parentCwd, isProjectTrusted: () => trusted }) as any, mcp); };
  return { events, create, get capabilities() { return capabilities; }, skills: (value: any[]) => { commands = value; }, trust: (value: boolean) => { trusted = value; } };
}
const hookSpec = { name: 'policy', version: '1', permissions: 'read-only', replay: 'safe', project: false } as const;

describe('parent-managed child capabilities', () => {
  test('inherits parent skills on demand, supports exclusions and opt-out, and preserves manual-only skills', async () => {
    const h = setup(), f = await fixture(true, 'parent', h.create);
    try {
      const commands = [];
      for (const name of ['inspect', 'publish', 'manual']) {
        const base = join(f.agentDir, 'skills', name); await mkdir(base, { recursive: true });
        const path = join(base, 'SKILL.md');
        await writeFile(path, `---\nname: ${name}\ndescription: ${name} guidance\n${name === 'manual' ? 'disable-model-invocation: true\n' : ''}---\n${name.toUpperCase()}_INSTRUCTIONS`);
        commands.push({ name: `skill:${name}`, description: `${name} guidance`, source: 'skill', sourceInfo: { path, scope: 'user' } });
      }
      h.skills(commands);
      const inherited = await h.capabilities.select({}, 'read-only');
      expect(inherited.skills.map(skill => skill.name)).toEqual(['inspect', 'publish']);
      expect(inherited.skills.every(skill => skill.preload === false)).toBe(true);
      expect(capabilityPrompt(inherited)).toContain('inspect guidance');
      expect(capabilityPrompt(inherited)).not.toContain('INSPECT_INSTRUCTIONS');
      const selected = await h.capabilities.select({ skills: 'inherit', disabledSkills: ['publish', 'not-installed'] }, 'read-only');
      expect(selected.skills.map(skill => skill.name)).toEqual(['inspect']);
      expect((await h.capabilities.select({ skills: [] }, 'full')).skills).toEqual([]);
      expect((await h.capabilities.select({ skills: ['inspect', 'publish'], disabledSkills: ['publish'] }, 'edit')).skills.map(skill => skill.name)).toEqual(['inspect']);
      expect((await h.capabilities.select({ skills: ['manual'] }, 'read-only')).skills[0].preload).toBe(true);
      f.respond(context => { expect(JSON.stringify(context)).not.toContain('INSPECT_INSTRUCTIONS'); return call('skill_read', { skill: 'inspect' }); },
        context => { expect(JSON.stringify(context)).toContain('INSPECT_INSTRUCTIONS'); return answer('Used inherited skill'); });
      const run = await f.spawn({ capabilities: selected, tools: capabilityTools(selected), instructions: capabilityPrompt(selected) });
      expect((await f.runtime.wait(run.id, 3000)).output).toBe('Used inherited skill');
      h.skills([...commands, { ...commands[0], name: 'skill:new-parent-skill' }]);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.saved(run.id)).capabilities).toEqual(selected);
      expect((await f.runtime.saved(run.id)).capabilities!.skills.map(skill => skill.name)).toEqual(['inspect']);
    } finally { await f.cleanup(); }
  });
  test('inheritance respects project trust and reads flat skill files through the saved skill identity', async () => {
    const h = setup(), f = await fixture(false, 'parent', h.create);
    try {
      const path = join(f.agentDir, 'flat.md'); await writeFile(path, 'Flat skill instructions');
      const project = join(f.cwd, '.pi', 'skills', 'project'); await mkdir(project, { recursive: true });
      const projectPath = join(project, 'SKILL.md'); await writeFile(projectPath, 'Project skill');
      h.skills([{ name: 'skill:flat', source: 'skill', sourceInfo: { path, scope: 'user' } },
        { name: 'skill:project', source: 'skill', sourceInfo: { path: projectPath, scope: 'project' } }]);
      h.trust(false);
      const selected = await h.capabilities.select({}, 'read-only');
      expect(selected.skills.map(skill => skill.name)).toEqual(['flat']);
      expect(await h.capabilities.skillPath(selected, 'flat')).toBe(path);
      await writeFile(join(f.agentDir, 'excluded.md'), 'Do not expose');
      await mkdir(join(f.agentDir, 'excluded-skill'));
      await writeFile(join(f.agentDir, 'excluded-skill', 'SKILL.md'), 'Do not expose');
      await expect(h.capabilities.skillPath(selected, 'flat', 'excluded.md')).rejects.toThrow('only');
      await expect(h.capabilities.skillPath(selected, 'flat', 'excluded-skill/SKILL.md')).rejects.toThrow('only');
      expect(await h.capabilities.skillPath(selected, 'flat', 'flat.md')).toBe(path);
      h.trust(true); const trusted = await h.capabilities.select({}, 'read-only');
      expect(trusted.skills.map(skill => skill.name)).toEqual(['flat', 'project']);
      h.trust(false); await expect(h.capabilities.validate(trusted)).rejects.toThrow('trust');
    } finally { await f.cleanup(); }
  });
  test('preloads selected skill instructions and reads supporting files without leaving its directory', async () => {
    const h = setup(), f = await fixture(true, 'parent', h.create);
    try {
      await git(f.cwd, ['init', '--initial-branch=main']);
      await git(f.cwd, ['config', 'user.name', 'Fixture']); await git(f.cwd, ['config', 'user.email', 'fixture@example.invalid']);
      await writeFile(join(f.cwd, 'tracked'), 'fixture'); await git(f.cwd, ['add', 'tracked']); await git(f.cwd, ['commit', '-m', 'Add fixture']);
      const base = join(f.agentDir, 'skills', 'inspect'); await mkdir(base, { recursive: true });
      const path = join(base, 'SKILL.md'); await writeFile(path, 'Use the evidence file.'); await writeFile(join(base, 'evidence.txt'), 'Selected skill evidence');
      await symlink(join(f.cwd, 'secret'), join(base, 'escape')); await writeFile(join(f.cwd, 'secret'), 'outside');
      h.skills([{ name: 'skill:inspect', source: 'skill', sourceInfo: { path, scope: 'user' } }]);
      const selected = await h.capabilities.select({ skills: ['inspect'] }, 'read-only');
      f.respond(context => { expect(JSON.stringify(context)).toContain('Use the evidence file.'); return call('skill_read', { skill: 'inspect', path: 'evidence.txt' }); },
        context => { expect(JSON.stringify(context)).toContain('Selected skill evidence'); return answer('Read the selected skill'); });
      const run = await f.spawn({ isolation: 'worktree', projectTrusted: true, capabilities: selected, tools: capabilityTools(selected), instructions: capabilityPrompt(selected) });
      expect((await f.runtime.wait(run.id, 3000)).output).toBe('Read the selected skill');
      expect((await f.runtime.saved(run.id)).cwd).not.toBe(f.cwd);
      await expect(h.capabilities.skillPath(selected, 'inspect', '../secret')).rejects.toThrow();
      await expect(h.capabilities.skillPath(selected, 'inspect', 'escape')).rejects.toThrow('inside');
      await expect(h.capabilities.skillPath(selected, 'other')).rejects.toThrow('selection');
      await f.runtime.dispose(); await f.open();
      expect((await f.runtime.saved(run.id)).capabilities).toEqual(selected);
      expect((await f.runtime.saved(run.id)).tools).toEqual(['skill_read']);
      await writeFile(path, 'Changed skill');
      await expect(h.capabilities.validate(selected)).rejects.toThrow('changed');
      const before = (await f.runtime.saved(run.id)).runs.length;
      await expect(f.runtime.send(run.id, 'Next', 'changed', 'changed')).rejects.toThrow('changed');
      expect((await f.runtime.saved(run.id)).runs).toHaveLength(before);
    } finally { await f.cleanup(); }
  });
  test('enforces capability ceilings and fails closed when trust or a hook version changes', async () => {
    const tool: McpSnapshot = { name: 'mcp__fixture__write', server: 'fixture', description: 'Write', parameters: {}, readOnly: false, signature: 'x', configHash: 'y', project: false };
    const h = setup({ ...noMcp, catalog: async () => [tool] }); h.create();
    await expect(h.capabilities.select({ mcpTools: [tool.name] }, 'read-only')).rejects.toThrow('full');
    await expect(h.capabilities.select({ mcpTools: [tool.name] }, 'edit')).rejects.toThrow('full');
    expect((await h.capabilities.select({ mcpTools: [tool.name] }, 'full')).mcpTools).toEqual([tool]);
    await expect(h.capabilities.select({ skills: ['unknown'] }, 'full')).rejects.toThrow('unavailable');
    const hook: ChildHook = { ...hookSpec, project: true };
    const unregister = registerChildHook({ events: h.events }, hook);
    const saved = await h.capabilities.select({ hooks: ['policy'] }, 'read-only');
    h.trust(false); await expect(h.capabilities.validate(saved)).rejects.toThrow('trust');
    h.trust(true); unregister(); registerChildHook({ events: h.events }, { ...hook, version: '2' });
    await expect(h.capabilities.validate(saved)).rejects.toThrow('changed');
    registerChildHook({ events: h.events }, { ...hookSpec, name: 'shell-policy', permissions: 'full' });
    await expect(h.capabilities.select({ hooks: ['shell-policy'] }, 'edit')).rejects.toThrow('exceeds');
  });
  test('tool hooks run in child context, block writes, and cannot activate tools through result control', async () => {
    const h = setup(), f = await fixture(false, 'parent', h.create);
    try {
      const calls: string[] = [];
      registerChildHook({ events: h.events }, { ...hookSpec,
        beforeTool: (call, context) => { calls.push(`${call.name}:${context.cwd}`); return call.name === 'write' ? { block: 'Parent policy blocks this file' } : {}; },
        afterTool: () => ({ output: [{ type: 'text', text: 'Filtered child result' }], control: { addTools: ['bash'] } }),
      });
      const selected = await h.capabilities.select({ hooks: ['policy'] }, 'edit');
      f.respond(call('write', { path: 'blocked', content: 'bad' }), call('ls', {}), answer('Done'));
      const run = await f.spawn({ definition: BUILTIN_AGENTS[2], capabilities: selected, tools: [...PERMISSION_TOOLS.edit] });
      await f.runtime.wait(run.id, 3000);
      await expect(readFile(join(f.cwd, 'blocked'))).rejects.toThrow();
      const transcript = await f.runtime.transcript(run.id);
      expect(transcript).toContain('Parent policy blocks'); expect(transcript).toContain('Filtered child result');
      expect(calls).toEqual([`write:${f.cwd}`, `ls:${f.cwd}`]);
      expect((await f.runtime.saved(run.id)).tools).not.toContain('bash');
    } finally { await f.cleanup(); }
  });
  test('duplicate hook registrations fail closed even though the Pi event bus catches handler errors', () => {
    const h = setup(); h.create(); registerChildHook({ events: h.events }, hookSpec); registerChildHook({ events: h.events }, hookSpec);
    expect(() => h.capabilities.hooks()).toThrow('Duplicate');
  });
  test('a throwing tool hook fails closed before the effect', async () => {
    const h = setup(), f = await fixture(false, 'parent', h.create);
    try {
      registerChildHook({ events: h.events }, { ...hookSpec, beforeTool: () => { throw new Error('Policy failed'); } });
      const selected = await h.capabilities.select({ hooks: ['policy'] }, 'edit');
      f.respond(call('write', { path: 'blocked', content: 'bad' }), answer('Blocked'));
      const run = await f.spawn({ definition: BUILTIN_AGENTS[2], tools: ['write'], capabilities: selected });
      await f.runtime.wait(run.id, 3000);
      expect(await f.runtime.transcript(run.id)).toContain('Policy failed');
      await expect(readFile(join(f.cwd, 'blocked'))).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
  test('MCP selection survives reopen and never grows when the parent catalog grows', async () => {
    let calls = 0;
    const tool: McpSnapshot = { name: 'mcp__fixture__inspect', server: 'fixture', description: 'Inspect', parameters: {}, readOnly: true, signature: 'x', configHash: 'y', project: false };
    const h = setup({ ...noMcp, catalog: async () => [tool], call: async () => { calls++; return { output: [{ type: 'text', text: 'Saved MCP evidence' }] }; } });
    const f = await fixture(true, 'parent', h.create);
    try {
      const selected = await h.capabilities.select({ mcpServers: ['fixture'] }, 'read-only');
      f.respond(call('mcp', { tool: tool.name, args: {} }), answer('Done'));
      const run = await f.spawn({ capabilities: selected, tools: ['mcp'] }); await f.runtime.wait(run.id, 3000);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.saved(run.id)).capabilities).toEqual(selected); expect(calls).toBe(1);
      f.respond(call('mcp', { tool: 'mcp__fixture__new_write', args: {} }), answer('Denied'));
      await f.runtime.send(run.id, 'Use new tool', 'next', 'next'); await f.runtime.wait(run.id, 3000);
      expect(calls).toBe(1); expect(await f.runtime.transcript(run.id)).toContain('outside the saved selection');
    } finally { await f.cleanup(); }
  });
});

test('native MCP uses existing Pi config/auth support, child cwd, and saved schemas without a live model', async () => {
  const f = await fixture();
  let bridge: NativeMcpBridge | undefined;
  try {
    const schema = { type: 'object', properties: {} };
    const sourceInfo = { path: 'builtin:mcp', scope: 'user', source: 'builtin', origin: 'top-level' } as const;
    const tools: ToolInfo[] = ['inspect', 'append'].map(name => ({ name: `mcp__fixture__${name}`, description: name === 'inspect' ? 'Inspect local fixture' : 'Append local fixture', parameters: schema,
      annotations: { readOnlyHint: name === 'inspect' }, exposure: 'direct', namespace: { name: 'mcp__fixture' }, sourceInfo }));
    const config = { mcpServers: { fixture: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./process/mcp-server.ts', import.meta.url)), join(f.dir, 'mcp-effect')], exposure: 'direct' } } };
    await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify(config));
    let active = tools.map(tool => tool.name);
    const context: any = { cwd: f.cwd, modelRegistry: { getApiKeyForProvider: async () => undefined }, isProjectTrusted: () => true };
    bridge = new NativeMcpBridge({ getAllTools: () => tools, getMcpServers: () => [], getActiveTools: () => active }, () => context, f.agentDir);
    const saved = await bridge.catalog(); expect(saved).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain('command');
    const inspected = JSON.stringify(await bridge.call(saved[0], '1', f.cwd, {}));
    expect(inspected).toContain(f.cwd);
    const pid = Number(inspected.match(/pid (\d+)/)![1]);
    await bridge.release('1');
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
    const reconnected = JSON.stringify(await bridge.call(saved[0], '1', f.cwd, {}));
    expect(Number(reconnected.match(/pid (\d+)/)![1])).not.toBe(pid);
    await bridge.call(saved[1], '1', f.cwd, {}); expect(await readFile(join(f.dir, 'mcp-effect'), 'utf8')).toBe('x');
    active = [];
    await expect(bridge.call(saved[1], '1', f.cwd, {})).rejects.toThrow('changed or is unavailable');
    expect(await readFile(join(f.dir, 'mcp-effect'), 'utf8')).toBe('x');
    const registered = tools.splice(0);
    const register = setTimeout(() => tools.push(...registered), 50);
    try { await expect(bridge.call(saved[1], '1', f.cwd, {})).rejects.toThrow('inactive'); }
    finally { clearTimeout(register); if (!tools.length) tools.push(...registered); }
    expect(await readFile(join(f.dir, 'mcp-effect'), 'utf8')).toBe('x');
    active = tools.map(tool => tool.name);
    tools[0] = { ...tools[0], annotations: { readOnlyHint: false } };
    await expect(bridge.call(saved[0], '1', f.cwd, {})).rejects.toThrow('changed');
    config.mcpServers.fixture.command = 'changed'; await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify(config));
    await expect(bridge.validate(saved)).rejects.toThrow('changed');
  } finally { await bridge?.close(); await f.cleanup(); }
});

test('MCP config overrides extension namespaces and project-registered servers retain their trust dependency', async () => {
  const f = await fixture();
  let bridge: NativeMcpBridge | undefined;
  try {
    const config = { mcpServers: { 'my-server': { command: 'fixture' } } };
    await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify(config));
    const tool: ToolInfo = { name: 'mcp__my_server__inspect', description: 'Inspect', parameters: { type: 'object', properties: {} },
      exposure: 'deferred', namespace: { name: 'mcp__my_server' }, annotations: { readOnlyHint: true },
      sourceInfo: { path: 'builtin:mcp', scope: 'temporary', source: 'builtin', origin: 'top-level' } };
    let trusted = true;
    const extensionPath = join(f.cwd, '.pi', 'extensions', 'fixture.ts');
    let registered = [{ name: 'my_server', config: { command: 'ignored' }, extensionPath }];
    bridge = new NativeMcpBridge({ getAllTools: () => [tool], getActiveTools: () => [], getMcpServers: () => registered },
      () => ({ cwd: f.cwd, isProjectTrusted: () => trusted }) as any, f.agentDir);
    const global = await bridge.catalog(); expect(global).toHaveLength(1); expect(global[0].server).toBe('my-server'); expect(global[0].project).toBe(false);
    await writeFile(join(f.agentDir, 'mcp.json'), '{"mcpServers":{}}');
    const project = await bridge.catalog(); expect(project[0].server).toBe('my_server'); expect(project[0].project).toBe(true);
    trusted = false;
    await expect(bridge.validate(project)).rejects.toThrow('unavailable');
    registered = []; expect(await bridge.catalog().catch(() => [])).toEqual([]);
  } finally { await bridge?.close(); await f.cleanup(); }
});

test('MCP tools and compatible child hooks inherit by default with named and complete opt-outs', async () => {
  const read: McpSnapshot = { name: 'mcp__docs__read', server: 'docs', description: 'Read', parameters: {}, readOnly: true, signature: 'read', configHash: 'fixture', project: false };
  const write: McpSnapshot = { ...read, name: 'mcp__docs__write', readOnly: false, signature: 'write' };
  const h = setup({ ...noMcp, catalog: async () => [read, write] }); h.create();
  registerChildHook({ events: h.events }, hookSpec);
  registerChildHook({ events: h.events }, { ...hookSpec, name: 'shell', permissions: 'full' });
  const readonly = await h.capabilities.select({}, 'read-only');
  expect(readonly.mcpTools.map(tool => tool.name)).toEqual([read.name]);
  expect(readonly.hooks.map(hook => hook.name)).toEqual(['policy']);
  const full = await h.capabilities.select({ mcpTools: 'inherit', hooks: 'inherit' }, 'full');
  expect(full.mcpTools).toHaveLength(2); expect(full.hooks).toHaveLength(2);
  const filtered = await h.capabilities.select({ disabledMcpTools: [write.name], disabledHooks: ['shell'] }, 'full');
  expect(filtered.mcpTools.map(tool => tool.name)).toEqual([read.name]); expect(filtered.hooks.map(hook => hook.name)).toEqual(['policy']);
  const none = await h.capabilities.select({ skills: [], mcpTools: [], hooks: [] }, 'full');
  expect(none).toEqual(emptyCapabilities());
  expect((await h.capabilities.select({ mcpTools: [], mcpServers: ['docs'] }, 'full')).mcpTools).toEqual([]);
  expect((await h.capabilities.select({ mcpTools: [read.name], mcpServers: ['docs'] }, 'full')).mcpTools.map(tool => tool.name)).toEqual([read.name]);
});

test('empty allowlists do not discover or validate unrelated MCP servers and hook registrations', async () => {
  const h = setup({ ...noMcp, catalog: async () => { throw new Error('Unrelated MCP config'); }, validate: async () => { throw new Error('Unrelated MCP config'); } }); h.create();
  registerChildHook({ events: h.events }, hookSpec); registerChildHook({ events: h.events }, hookSpec);
  const none = await h.capabilities.select({ skills: [], mcpTools: [], hooks: [] }, 'read-only');
  expect(none).toEqual(emptyCapabilities());
  await expect(h.capabilities.validate(none)).resolves.toBeUndefined();
  await expect(h.capabilities.catalog()).rejects.toThrow('Unrelated MCP');
});

test('hookless tool dispatch ignores unrelated duplicate and malformed hooks', async () => {
  const h = setup(), f = await fixture(false, 'parent', h.create);
  try {
    registerChildHook({ events: h.events }, hookSpec); registerChildHook({ events: h.events }, hookSpec);
    registerChildHook({ events: h.events }, { name: 'broken' } as ChildHook);
    f.respond(call('ls', {}), context => {
      expect(JSON.stringify(context)).not.toContain('Invalid child hook');
      expect(JSON.stringify(context)).not.toContain('Duplicate child hook');
      return answer('Listed files');
    });
    const run = await f.spawn({ tools: ['ls'], capabilities: emptyCapabilities(), trust: 'untrusted' });
    expect((await f.runtime.wait(run.id, 3000)).output).toBe('Listed files');
  } finally { await f.cleanup(); }
});

test('nested explicit capabilities above the descendant profile fail instead of disappearing', async () => {
  const tool: McpSnapshot = { name: 'mcp__fixture__write', server: 'fixture', description: 'Write', parameters: {}, readOnly: false, signature: '1', configHash: '1', project: false };
  const h = setup({ ...noMcp, catalog: async () => [tool] }), f = await fixture(false, 'parent', h.create);
  try {
    registerChildHook({ events: h.events }, { ...hookSpec, permissions: 'full' });
    const selected = await h.capabilities.select({ skills: [], mcpTools: [tool.name], hooks: ['policy'] }, 'full');
    f.respond(async (_context, options) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return answer('', { stopReason: 'aborted' });
    });
    const owner = await f.spawn({ definition: BUILTIN_AGENTS[2], tools: [...BUILTIN_AGENTS[2].tools, ...capabilityTools(selected)], capabilities: selected });
    await expect(f.runtime.delegate(owner.id, { action: 'spawn', agent: 'Explore', task: 'Read', mcpTools: [tool.name] }, 'mutating')).rejects.toThrow('full permissions');
    await expect(f.runtime.delegate(owner.id, { action: 'spawn', agent: 'Explore', task: 'Read', hooks: ['policy'] }, 'hook')).rejects.toThrow('exceeds');
  } finally { await f.cleanup(); }
});

test('terminal children release MCP connections and follow-up tasks can reconnect', async () => {
  const released: string[] = [];
  const h = setup({ ...noMcp, release: async id => { released.push(id); } }), f = await fixture(false, 'parent', h.create);
  try {
    f.respond(answer('First'), answer('Second'));
    const run = await f.spawn(); await f.runtime.wait(run.id, 3000);
    await expect.poll(() => released).toContain(run.id);
    const count = released.length;
    await f.runtime.send(run.id, 'Next', 'next', 'next'); await f.runtime.wait(run.id, 3000);
    await expect.poll(() => released.length).toBeGreaterThan(count);
  } finally { await f.cleanup(); }
});
