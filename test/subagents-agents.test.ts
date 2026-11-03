import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgents, parseAgent } from '../src/agents.ts';
import { DEFAULT_SUBAGENT_SETTINGS, readSubagentSettings, writeSubagentSettings } from '../src/config.ts';

const definition = (header: string) => `---\nname: custom\ndescription: Test agent\n${header}\n---\nWork on the assigned task.`;

describe('agent permissions and discovery', () => {
  test('default agent is read-only and explicit tools determine the profile', () => {
    expect(parseAgent(definition(''), 'agent.md').tools).toEqual(['read', 'grep', 'find', 'ls', 'subagent']);
    expect(parseAgent(definition('tools: [read, edit]'), 'agent.md').permissions).toBe('edit');
    expect(parseAgent(definition('tools: read, bash'), 'agent.md').permissions).toBe('full');
    expect(parseAgent(definition('permissions: full\ntools: []'), 'agent.md').tools).toEqual([]);
    expect(parseAgent(definition('skills: inherit\ndisabledSkills: [publish]\nmcpTools: inherit\nhooks: inherit\ndisabledMcpTools: [mcp__docs__write]\ndisabledHooks: [shell]'), 'agent.md')).toMatchObject({ skills: 'inherit', disabledSkills: ['publish'], mcpTools: 'inherit', hooks: 'inherit', disabledMcpTools: ['mcp__docs__write'], disabledHooks: ['shell'] });
    expect(parseAgent(definition('skills: [inspect]\nmcpServers: [docs]\nmcpTools: [mcp__docs__read]\nhooks: [policy]'), 'agent.md')).toMatchObject({ skills: ['inspect'], mcpServers: ['docs'], mcpTools: ['mcp__docs__read'], hooks: ['policy'] });
    expect(parseAgent(definition('context: fork\nisolation: worktree'), 'agent.md')).toMatchObject({ context: 'fork', isolation: 'worktree' });
  });

  test('refuses broader tools, extension capabilities, malformed models, and unknown tools', () => {
    for (const header of ['permissions: read-only\ntools: [read, bash]', 'permissions: edit\ntools: [write, bash]',
      'tools: [read, contact_supervisor]', 'tools: [+read]', 'model: ambiguous', 'thinking: impossible',
      'context: invalid', 'isolation: invalid', 'hooks: {}', 'mcpServers: {}', 'disabledMcpTools: {}', 'disabledHooks: {}', 'skills: everything', 'disabledSkills: {}', 'permissions: root', 'extensions: [unsafe.ts]', 'runner: {type: external-cli}']) {
      expect(() => parseAgent(definition(header), 'test.md')).toThrow();
    }
    expect(parseAgent(definition('model: google-cloud-deepseek/deepseek-ai/deepseek-v4.1-flash-maas'), 'agent.md').model)
      .toBe('google-cloud-deepseek/deepseek-ai/deepseek-v4.1-flash-maas');
  });

  test('project overrides user and builtins, while invalid definitions never widen permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-agents-'));
    try {
      const user = join(dir, 'user'), project = join(dir, 'project');
      await mkdir(user); await mkdir(project);
      await writeFile(join(user, 'general-purpose.md'), definition('permissions: read-only').replace('name: custom', 'name: general-purpose'));
      let found = await discoverAgents(user, project);
      expect(found.agents.find(agent => agent.name === 'general-purpose')?.permissions).toBe('read-only');
      await writeFile(join(project, 'different-file.md'), definition('permissions: read-only\ntools: bash').replace('name: custom', 'name: general-purpose'));
      found = await discoverAgents(user, project);
      expect(found.errors).toHaveLength(1);
      expect(found.agents.some(agent => agent.name === 'general-purpose')).toBe(false);
      // Declining project trust is implemented by omitting the project root.
      expect((await discoverAgents(user)).agents.find(agent => agent.name === 'general-purpose')?.permissions).toBe('read-only');
      await writeFile(join(project, 'different-file.md'), definition('permissions: full').replace('name: custom', 'name: general-purpose'));
      expect((await discoverAgents(user, project)).agents.find(agent => agent.name === 'general-purpose')?.permissions).toBe('full');
      await writeFile(join(project, 'duplicate.md'), definition('').replace('name: custom', 'name: general-purpose'));
      expect((await discoverAgents(user, project)).agents.some(agent => agent.name === 'general-purpose')).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test('subagent config has bounded defaults and rejects malformed files before saving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-agents-config-'));
  const path = join(dir, 'pi-subagents', 'subagents.json');
  try {
    expect(await readSubagentSettings(path)).toEqual(DEFAULT_SUBAGENT_SETTINGS);
    await writeSubagentSettings(path, { maxConcurrent: 2, model: 'test/one' });
    const saved = await readFile(path, 'utf8');
    expect(await readSubagentSettings(path)).toMatchObject({ maxConcurrent: 2, model: 'test/one' });
    for (const invalid of [{ maxDepth: 0 }, { maxDepth: 9 }, { indicatorPosition: 'somewhere' }, { maxConcurrent: 0 }, { maxConcurrent: 17 }, { maxTurns: 200 }, { timeoutSeconds: 0 }, { model: 'wrong' }, { thinking: 'turbo' }]) {
      await expect(writeSubagentSettings(path, invalid)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(saved);
    }
    await writeFile(path, '{');
    await expect(readSubagentSettings(path)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
