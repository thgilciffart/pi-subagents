import { PERMISSION_TOOLS, type AgentDefinition, type Permissions } from './agents.ts';
import type { Capabilities, Selection } from './capabilities.ts';

export type Trust = 'trusted' | 'untrusted';
export type ToolPolicy = {
  trust: Trust; permissions: Permissions; tools: string[]; skills: string[]; mcpTools: string[]; hooks: string[];
  delegation?: { ownerId: string; ownerRun: number; depth: number };
};
export type PolicyChild = { trust?: Trust; definition: Pick<AgentDefinition, 'permissions'>; tools: string[]; capabilities?: Capabilities; policy?: ToolPolicy; delegation?: ToolPolicy['delegation'] };
export function resolveTrust(value: unknown): Trust {
  if (value === undefined) return 'trusted';
  if (value !== 'trusted' && value !== 'untrusted') throw new Error('trust must be trusted or untrusted.');
  return value;
}
export function resolveTools(definition: AgentDefinition, trust: Trust, provided?: string[], disabled: string[] = definition.disabledTools ?? []): string[] {
  if (disabled.some(name => !(PERMISSION_TOOLS.full as readonly string[]).includes(name))) throw new Error('disabledTools must contain built-in tool names.');
  const selected = provided ?? (trust === 'untrusted' && definition.trust !== 'untrusted' ? [] : definition.tools);
  if (selected.some(name => !(definition.toolCeiling ?? definition.tools).includes(name))) throw new Error('A launch can narrow tools but cannot grant additional permissions.');
  return [...new Set(selected)].filter(name => !disabled.includes(name));
}
/** Untrusted capabilities require exact names. Empty allowlists stay empty. */
export function resolveSelection(trust: Trust, definition: AgentDefinition, provided: Selection): Selection {
  const defaults: Selection = trust === 'untrusted' && definition.trust !== 'untrusted' ? {} : definition;
  const selection: Selection = {
    skills: provided.skills ?? defaults.skills, disabledSkills: provided.disabledSkills ?? defaults.disabledSkills,
    mcpTools: provided.mcpTools ?? (provided.mcpServers === undefined ? defaults.mcpTools : undefined),
    disabledMcpTools: provided.disabledMcpTools ?? defaults.disabledMcpTools,
    mcpServers: provided.mcpServers ?? defaults.mcpServers,
    hooks: provided.hooks ?? defaults.hooks, disabledHooks: provided.disabledHooks ?? defaults.disabledHooks,
  };
  if (trust === 'untrusted') {
    for (const field of ['skills', 'mcpTools', 'hooks'] as const) {
      if (selection[field] === 'inherit') throw new Error(`Untrusted children require an explicit ${field} allowlist.`);
      selection[field] ??= [];
    }
    if (selection.mcpServers !== undefined) throw new Error('Untrusted children require exact mcpTools names instead of mcpServers.');
  }
  return selection;
}
export function createPolicy(child: PolicyChild): ToolPolicy {
  return { trust: resolveTrust(child.trust), permissions: child.definition.permissions, tools: [...child.tools],
    skills: child.capabilities?.skills.map(skill => skill.name) ?? [], mcpTools: child.capabilities?.mcpTools.map(tool => tool.name) ?? [],
    hooks: child.capabilities?.hooks.map(hook => hook.name) ?? [], ...(child.delegation ? { delegation: { ...child.delegation } } : {}) };
}
export function checkPolicy(child: PolicyChild): void {
  const policy = child.policy;
  if (!policy) throw new Error('The saved child tool policy is missing.');
  const current = createPolicy(child);
  if (JSON.stringify(policy.delegation) !== JSON.stringify(current.delegation)) throw new Error('The saved delegation ownership changed.');
  if (policy.trust !== current.trust || policy.permissions !== current.permissions) throw new Error('The saved trust policy or permission ceiling changed.');
  for (const field of ['tools', 'skills', 'mcpTools', 'hooks'] as const) {
    if (current[field].some(name => !policy[field].includes(name))) throw new Error(`Saved ${field} exceed the child allowlist.`);
  }
}
