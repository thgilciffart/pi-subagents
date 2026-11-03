import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolveTrust, type Trust } from './policy.ts';
import type { Selection } from './capabilities.ts';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Thinking = typeof THINKING_LEVELS[number];
export const PERMISSION_TOOLS = {
  'read-only': ['read', 'grep', 'find', 'ls', 'subagent'],
  edit: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'subagent'],
  full: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'subagent'],
} as const;
export type ContextMode = 'fresh' | 'fork';
export type Isolation = 'shared' | 'worktree';
export type Permissions = keyof typeof PERMISSION_TOOLS;
export type AgentDefinition = Selection & {
  name: string;
  description: string;
  prompt: string;
  permissions: Permissions;
  tools: string[];
  toolCeiling?: string[];
  trust?: Trust;
  disabledTools?: string[];
  model?: string;
  thinking?: Thinking;
  isolation?: Isolation;
  context?: ContextMode;
  source: string;
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  { name: 'Explore', description: 'Find files, trace code paths, and explain how the codebase works without changing files.',
    prompt: 'Explore the assigned codebase question. Return relevant files, symbols, and evidence. Do not modify files or run shell commands. Delegate independent read-only investigations when useful.',
    permissions: 'read-only', tools: [...PERMISSION_TOOLS['read-only']], source: 'builtin' },
  { name: 'Plan', description: 'Research the codebase and propose an implementation plan without changing files.',
    prompt: 'Research the requirements and existing implementation. Return a concrete plan, affected files, tradeoffs, and verification steps. Do not implement the plan. Delegate focused read-only research when useful.',
    permissions: 'read-only', tools: [...PERMISSION_TOOLS['read-only']], source: 'builtin' },
  { name: 'general-purpose', description: 'Handle complex research, implementation, commands, tests, and multi-step tasks.',
    prompt: 'Complete the assigned task using the available tools. Preserve other agents\' changes. Delegate independent work when useful, give each child clear scope and ownership, and wait for its result before finishing. Verify changes with appropriate checks and report the evidence.',
    permissions: 'full', tools: [...PERMISSION_TOOLS.full], source: 'builtin' },
];

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value.trim();
}

export function parseAgent(content: string, source: string): AgentDefinition {
  const { frontmatter: data, body } = parseFrontmatter(content);
  const name = text(data.name ?? basename(source, '.md'), 'name');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Agent names must use 1 to 64 letters, numbers, underscores, or hyphens.');
  const description = text(data.description, 'description');
  const prompt = text(body, 'Agent instructions');
  const trust = data.trust === undefined ? undefined : resolveTrust(data.trust);
  let tools: string[] | undefined;
  if (data.tools !== undefined) {
    const raw = typeof data.tools === 'string' ? data.tools.split(',').map(value => value.trim()) : data.tools;
    if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string' || !value.trim())) throw new Error('tools must be a list of built-in tool names.');
    tools = [...new Set(raw as string[])];
    for (const tool of tools) if (!(PERMISSION_TOOLS.full as readonly string[]).includes(tool)) throw new Error(`Unsupported child tool: ${tool}. Only built-in file tools and bash are supported.`);
  }
  const permissions = data.permissions ?? (tools?.includes('bash') ? 'full' : tools?.some(tool => ['edit', 'write'].includes(tool)) ? 'edit' : 'read-only');
  if (typeof permissions !== 'string' || !Object.hasOwn(PERMISSION_TOOLS, permissions)) throw new Error('permissions must be read-only, edit, or full.');
  const allowed = PERMISSION_TOOLS[permissions as Permissions] as readonly string[];
  const toolCeiling = tools ? [...tools] : [...allowed];
  tools ??= trust === 'untrusted' ? [] : [...allowed];
  let disabledTools: string[] | undefined;
  if (data.disabledTools !== undefined) {
    if (!Array.isArray(data.disabledTools) || data.disabledTools.some(name => typeof name !== 'string' || !(PERMISSION_TOOLS.full as readonly string[]).includes(name))) throw new Error('disabledTools must be a list of built-in tool names.');
    disabledTools = [...new Set(data.disabledTools as string[])];
  }
  if (tools.some(tool => !allowed.includes(tool))) throw new Error(`tools cannot exceed ${permissions} permissions.`);
  const model = data.model === undefined ? undefined : text(data.model, 'model');
  if (model && model !== 'current' && !/^[^/\s]+\/\S+$/.test(model)) throw new Error('model must be current or provider/model-id.');
  const thinking = data.thinking;
  if (thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) throw new Error(`thinking must be one of ${THINKING_LEVELS.join(', ')}.`);
  const context = data.context;
  if (context !== undefined && context !== 'fresh' && context !== 'fork') throw new Error('context must be fresh or fork.');
  const isolation = data.isolation;
  if (isolation !== undefined && isolation !== 'shared' && isolation !== 'worktree') throw new Error('isolation must be shared or worktree.');
  // These upstream fields can change tool exposure or execute an external runner.
  // Refuse them rather than silently changing an existing agent's behavior.
  for (const field of ['extensions', 'subagentOnlyExtensions', 'runner']) {
    if (data[field] !== undefined) throw new Error(`${field} is not supported by this plugin. Child extensions and external runners are disabled.`);
  }
  const selection: Selection = {};
  for (const field of ['skills', 'disabledSkills', 'mcpTools', 'disabledMcpTools', 'mcpServers', 'hooks', 'disabledHooks'] as const) {
    const value = data[field];
    if (value === undefined) continue;
    if ((field === 'skills' || field === 'mcpTools' || field === 'hooks') && value === 'inherit') { selection[field] = value; continue; }
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${field} must be a list of configured parent capability names.`);
    selection[field] = [...new Set(value as string[])];
  }
  if (trust === 'untrusted' && ([selection.skills, selection.mcpTools, selection.hooks].includes('inherit') || selection.mcpServers !== undefined)) throw new Error('Untrusted definitions require explicit capability allowlists and exact MCP tool names.');
  return { ...selection, trust, disabledTools, toolCeiling, name, description, prompt, permissions: permissions as Permissions, tools, model, thinking: thinking as Thinking | undefined, isolation: isolation as Isolation | undefined, context: context as ContextMode | undefined, source };
}

export async function discoverAgents(userDir: string, projectDir?: string): Promise<{ agents: AgentDefinition[]; errors: string[] }> {
  const agents = new Map(BUILTIN_AGENTS.map(agent => [agent.name, { ...agent, tools: [...agent.tools] }]));
  const errors: string[] = [];
  async function scan(root: string): Promise<void> {
    const found = new Map<string, AgentDefinition>();
    const duplicates = new Set<string>();
    const invalid = new Set<string>();
    async function visit(dir: string): Promise<void> {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.chain.md')) {
          let name = basename(path, '.md');
          try {
            const content = await readFile(path, 'utf8');
            const declared = parseFrontmatter(content).frontmatter.name;
            if (typeof declared === 'string') name = declared.trim();
            const agent = parseAgent(content, path);
            if (found.has(agent.name)) { duplicates.add(agent.name); throw new Error(`Duplicate agent name: ${agent.name}.`); }
            found.set(agent.name, agent);
          } catch (error) {
            // A broken override must never fall back to a builtin with broader tools.
            errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
            invalid.add(name);
          }
        }
      }
    }
    await visit(root);
    for (const name of [...duplicates, ...invalid]) { found.delete(name); agents.delete(name); }
    for (const [name, agent] of found) agents.set(name, agent);
  }
  await scan(userDir);
  if (projectDir) await scan(projectDir);
  return { agents: [...agents.values()], errors };
}
