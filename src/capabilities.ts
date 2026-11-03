import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { JsonValue } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import type { JsonObject, ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable';
import { parseFrontmatter, type ExtensionAPI, type ExtensionContext, type ToolInfo } from '@earendil-works/pi-coding-agent';
import type { Permissions } from './agents.ts';

export type SkillSnapshot = { name: string; path: string; baseDir: string; content: string; hash: string; project: boolean; description?: string; preload?: boolean };
export type McpSnapshot = { name: string; server: string; description: string; parameters: JsonObject; readOnly: boolean; signature: string; configHash: string; project: boolean };
export type HookSnapshot = { name: string; version: string; permissions: Permissions; replay: 'safe' | 'unsafe'; project: boolean };
export type Capabilities = { skills: SkillSnapshot[]; mcpTools: McpSnapshot[]; hooks: HookSnapshot[] };
export type SkillSelection = 'inherit' | string[];
export type Selection = { skills?: SkillSelection; disabledSkills?: string[]; mcpTools?: SkillSelection; disabledMcpTools?: string[]; mcpServers?: string[]; hooks?: SkillSelection; disabledHooks?: string[] };
export type ChildHookContext = { childId: string; cwd: string; permissions: Permissions; signal?: AbortSignal };
export type ChildLifecycleContext = ChildHookContext & { run: number; task: string; status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'; output: string; error?: string };
export type ChildHook = HookSnapshot & {
  onStart?: (context: ChildLifecycleContext) => Promise<void> | void;
  onResume?: (context: ChildLifecycleContext) => Promise<void> | void;
  onStop?: (context: ChildLifecycleContext) => Promise<void> | void;
  onClose?: (context: ChildLifecycleContext) => Promise<void> | void;
  beforeTool?: (call: { name: string; args: unknown }, context: ChildHookContext) => Promise<{ block?: string } | void> | { block?: string } | void;
  afterTool?: (call: { name: string; args: unknown; result: ToolExecutionResult }, context: ChildHookContext) => Promise<ToolExecutionResult | void> | ToolExecutionResult | void;
};
export const CAPABILITIES_EVENT = 'pi-subagents:capabilities';
export type CapabilityRequest = { registerHook: (hook: ChildHook) => void };
/** Call during extension load. The parent selects this hook by name when spawning a child. */
export function registerChildHook(pi: Pick<ExtensionAPI, 'events'>, hook: ChildHook): () => void {
  return pi.events.on(CAPABILITIES_EVENT, data => (data as CapabilityRequest).registerHook(hook));
}
export const emptyCapabilities = (): Capabilities => ({ skills: [], mcpTools: [], hooks: [] });
export function isProjectPath(cwd: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const offset = relative(resolve(cwd), resolve(path));
  return offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset);
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mcpSignature = (tool: Pick<ToolInfo, 'name' | 'description' | 'parameters' | 'annotations'>): string =>
  digest([tool.name, tool.description, tool.parameters, tool.annotations ?? {}]);
const rank: Record<Permissions, number> = { 'read-only': 0, edit: 1, full: 2 };
export function hookSnapshot(hook: ChildHook): HookSnapshot {
  return { name: hook.name, version: hook.version, permissions: hook.permissions, replay: hook.replay, project: hook.project };
}
export function checkCapabilityPermissions(saved: Capabilities, permissions: Permissions): void {
  if (saved.mcpTools.some(tool => !tool.readOnly) && permissions !== 'full') throw new Error('Mutating or unclassified MCP tools require full permissions.');
  for (const hook of saved.hooks) {
    if (!(hook.permissions in rank) || rank[hook.permissions] > rank[permissions]) throw new Error(`Hook ${hook.name} exceeds ${permissions} permissions.`);
    if (!['safe', 'unsafe'].includes(hook.replay)) throw new Error('Invalid hook replay policy.');
  }
}
export function capabilityTools(saved: Capabilities): string[] {
  return [...(saved.skills.length ? ['skill_read'] : []), ...(saved.mcpTools.length ? ['mcp'] : [])];
}
export function capabilityPrompt(saved: Capabilities): string {
  return [
    ...(saved.skills.some(skill => skill.preload === false) ? ['Inherited skills are available on demand through skill_read. Choose a skill that fits the task and read its SKILL.md before following it. Loading a skill does not grant tools.'] : []),
    ...saved.skills.map(skill => skill.preload === false ? `Available skill ${skill.name}: ${skill.description || 'No description provided'}. Load with skill_read using skill=${JSON.stringify(skill.name)} and path=\"SKILL.md\".` :
      `Selected skill ${skill.name} from ${skill.path}. Use skill_read with this skill name and a relative path for supporting files. Instructions:\n${skill.content}`),
    ...(saved.mcpTools.length ? ['Use mcp with tool set to the exact saved name and args matching its schema. Only these MCP tools are available:',
      ...saved.mcpTools.map(tool => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))] : []),
    ...(saved.hooks.length ? [`Selected child hooks: ${saved.hooks.map(hook => hook.name).join(', ')}.`] : []),
  ].join('\n\n');
}
export interface McpBridge {
  catalog(): Promise<McpSnapshot[]>;
  validate(tools: McpSnapshot[]): Promise<void>;
  call(tool: McpSnapshot, childId: string, cwd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult>;
  close(): Promise<void>;
}

export class ParentCapabilities {
  constructor(private pi: Pick<ExtensionAPI, 'getCommands' | 'events'>, private context: () => ExtensionContext, readonly mcp: McpBridge) {}
  hooks(): Map<string, ChildHook> {
    const hooks = new Map<string, ChildHook>(), errors: string[] = [];
    let collecting = true;
    this.pi.events.emit(CAPABILITIES_EVENT, { registerHook: (hook: ChildHook) => {
      if (!collecting) return;
      if (!hook?.name || !hook.version || !Object.hasOwn(rank, hook.permissions) || !['safe', 'unsafe'].includes(hook.replay) || typeof hook.project !== 'boolean') { errors.push('Invalid child hook registration.'); return; }
      if (hooks.has(hook.name)) { errors.push(`Duplicate child hook: ${hook.name}.`); return; }
      hooks.set(hook.name, hook);
    } } satisfies CapabilityRequest);
    collecting = false;
    if (errors.length) throw new Error(errors.join('\n'));
    return hooks;
  }
  skills() {
    return this.pi.getCommands().filter(command => command.source === 'skill' &&
      (!(command.sourceInfo.scope === 'project' || isProjectPath(this.context().cwd, command.sourceInfo.path)) || this.context().isProjectTrusted())).map(command => ({
        name: command.name.replace(/^skill:/, ''), path: command.sourceInfo.path,
        project: command.sourceInfo.scope === 'project' || isProjectPath(this.context().cwd, command.sourceInfo.path), description: command.description,
      }));
  }
  async catalog() {
    return { skills: this.skills(), mcpTools: await this.mcp.catalog(), hooks: [...this.hooks().values()].map(hookSnapshot) };
  }
  async select(selection: Selection, permissions: Permissions): Promise<Capabilities> {
    const saved = emptyCapabilities(), available = this.skills();
    const inherit = selection.skills === undefined || selection.skills === 'inherit';
    const namesToLoad = inherit ? available.map(skill => skill.name) : selection.skills as string[];
    const disabled = new Set(selection.disabledSkills ?? []);
    for (const name of new Set(namesToLoad)) {
      if (disabled.has(name)) continue;
      const matches = available.filter(skill => skill.name === name);
      if (matches.length !== 1) throw new Error(`Configured parent skill unavailable or ambiguous: ${name}.`);
      const skill = matches[0], path = await realpath(skill.path), content = await readFile(path, 'utf8');
      if (inherit && parseFrontmatter(content).frontmatter['disable-model-invocation'] === true) continue;
      saved.skills.push({ name, path, baseDir: await realpath(dirname(path)), content, hash: digest(content), project: skill.project, description: skill.description ?? '', preload: !inherit });
    }
    const inheritMcp = selection.mcpTools === 'inherit' || (selection.mcpTools === undefined && selection.mcpServers === undefined);
    const needsMcp = inheritMcp || (Array.isArray(selection.mcpTools) && selection.mcpTools.length > 0) || (selection.mcpTools === undefined && !!selection.mcpServers?.length);
    const tools = needsMcp ? await this.mcp.catalog() : [];
    const names = new Set(inheritMcp ? tools.filter(tool => permissions === 'full' || tool.readOnly).map(tool => tool.name) : Array.isArray(selection.mcpTools) ? selection.mcpTools : []);
    const disabledMcp = new Set(selection.disabledMcpTools ?? []);
    for (const server of new Set(selection.mcpTools === undefined ? selection.mcpServers ?? [] : [])) {
      const matches = tools.filter(tool => tool.server === server);
      if (!matches.length) throw new Error(`Configured parent MCP server has no available tools: ${server}.`);
      const permitted = matches.filter(tool => permissions === 'full' || tool.readOnly);
      if (!permitted.length) throw new Error(`MCP server ${server} has no tools permitted by ${permissions} permissions.`);
      for (const tool of permitted) names.add(tool.name);
    }
    for (const name of names) {
      if (disabledMcp.has(name)) continue;
      const matches = tools.filter(tool => tool.name === name);
      if (matches.length !== 1) throw new Error(`Configured parent MCP tool unavailable or ambiguous: ${name}.`);
      saved.mcpTools.push(matches[0]);
    }
    const inheritedHooks = selection.hooks === undefined || selection.hooks === 'inherit';
    const hooks = inheritedHooks || (Array.isArray(selection.hooks) && selection.hooks.length) ? this.hooks() : new Map<string, ChildHook>();
    const hookNames = inheritedHooks ? [...hooks.values()].filter(hook => rank[hook.permissions] <= rank[permissions] && (!hook.project || this.context().isProjectTrusted())).map(hook => hook.name) : selection.hooks as string[];
    const disabledHooks = new Set(selection.disabledHooks ?? []);
    for (const name of new Set(hookNames)) {
      if (disabledHooks.has(name)) continue;
      const hook = hooks.get(name);
      if (!hook || (hook.project && !this.context().isProjectTrusted())) throw new Error(`Trusted child hook unavailable: ${name}.`);
      saved.hooks.push(hookSnapshot(hook));
    }
    checkCapabilityPermissions(saved, permissions);
    return saved;
  }
  async validate(saved: Capabilities): Promise<void> {
    if ([...saved.skills, ...saved.mcpTools, ...saved.hooks].some(item => item.project) && !this.context().isProjectTrusted()) throw new Error('Project trust is required for saved child capabilities.');
    const available = saved.skills.length ? this.skills() : [];
    for (const skill of saved.skills) {
      const current = available.find(item => item.name === skill.name);
      if (!current || await realpath(current.path) !== skill.path || digest(await readFile(skill.path, 'utf8')) !== skill.hash) throw new Error(`Saved child skill changed or is unavailable: ${skill.name}.`);
    }
    const hooks = saved.hooks.length ? this.hooks() : new Map<string, ChildHook>();
    for (const savedHook of saved.hooks) {
      const current = hooks.get(savedHook.name);
      if (!current || digest(hookSnapshot(current)) !== digest(savedHook)) throw new Error(`Saved child hook changed or is unavailable: ${savedHook.name}.`);
    }
    if (saved.mcpTools.length) await this.mcp.validate(saved.mcpTools);
  }
  async skillPath(saved: Capabilities, name: string, path = 'SKILL.md'): Promise<string> {
    const skill = saved.skills.find(item => item.name === name);
    if (!skill) throw new Error(`Skill is outside the saved selection: ${name}.`);
    if (isAbsolute(path)) throw new Error('Skill paths must be relative.');
    const target = await realpath(path === 'SKILL.md' ? skill.path : resolve(skill.baseDir, path));
    const rel = relative(skill.baseDir, target);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Skill paths must remain inside the selected skill directory.');
    return target;
  }
  async runHooks(saved: Capabilities, stage: 'before' | 'after', name: string, args: unknown, result: ToolExecutionResult | undefined,
    child: ChildHookContext, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult | undefined> {
    const hooks = this.hooks();
    for (const spec of saved.hooks) {
      const hook = hooks.get(spec.name);
      if (!hook || digest(hookSnapshot(hook)) !== digest(spec)) throw new Error(`Saved hook unavailable: ${spec.name}.`);
      if (stage === 'before' ? !hook.beforeTool : !hook.afterTool) continue;
      const key = `hook:${stage}:${spec.name}`;
      const done = await api.memo(`${key}:done`, context);
      if (done !== undefined) {
        if (stage === 'before' && (done as { block?: string }).block) throw new Error(`Hook ${spec.name}: ${(done as { block: string }).block}`);
        if (stage === 'after') result = done as ToolExecutionResult;
        continue;
      }
      const started = await api.memo(`${key}:started`, context);
      if (started && spec.replay !== 'safe') throw new Error(`Hook ${spec.name} was interrupted. Inspect its effects before continuing.`);
      await api.memo(`${key}:started`, true, context);
      context.abortSignal?.throwIfAborted();
      if (stage === 'before') {
        const decision = await hook.beforeTool?.({ name, args: structuredClone(args) }, child) ?? {};
        await api.memo(`${key}:done`, decision as JsonValue, context);
        if (decision.block) throw new Error(`Hook ${spec.name}: ${decision.block}`);
      } else {
        result = await hook.afterTool?.({ name, args: structuredClone(args), result: structuredClone(result!) }, child) ?? result!;
        // Hooks may replace visible output, but cannot activate tools or change run control.
        result = { output: result.output ?? [], isError: result.isError ?? false };
        await api.memo(`${key}:done`, result as JsonValue, context);
      }
    }
    return result;
  }
  async close(): Promise<void> { await this.mcp.close(); }
}
