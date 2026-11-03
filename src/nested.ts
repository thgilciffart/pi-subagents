import { Type, type Static } from 'typebox';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { PERMISSION_TOOLS, type AgentDefinition, type Permissions } from './agents.ts';
import { capabilityPrompt, capabilityTools, type Capabilities } from './capabilities.ts';
import { resolveSelection, resolveTools, resolveTrust } from './policy.ts';
import type { SavedChild, SubagentRuntime } from './runtime.ts';

export const NestedParams = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('spawn'), Type.Literal('send'), Type.Literal('steer'), Type.Literal('status'),
    Type.Literal('wait'), Type.Literal('result'), Type.Literal('transcript'), Type.Literal('cancel'), Type.Literal('close')]),
  agent: Type.Optional(Type.String()), id: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 50000 })),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  model: Type.Optional(Type.String()), thinking: Type.Optional(Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'),
    Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')])),
  trust: Type.Optional(Type.Union([Type.Literal('trusted'), Type.Literal('untrusted')])),
  tools: Type.Optional(Type.Array(Type.String())),
  skills: Type.Optional(Type.Array(Type.String())), mcpTools: Type.Optional(Type.Array(Type.String())), hooks: Type.Optional(Type.Array(Type.String())),
  context: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('fork')])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })),
}, { additionalProperties: false });
export type NestedParams = Static<typeof NestedParams>;
const rank: Record<Permissions, number> = { 'read-only': 0, edit: 1, full: 2 };
const latest = (child: SavedChild) => child.runs.at(-1)!;
const output = (value: unknown): ToolExecutionResult => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { output: [{ type: 'text', text: text.length > 16000 ? text.slice(0, 16000) + '\n[Truncated. Read a focused transcript.]' : text }] };
};

export async function nestedOperation(runtime: SubagentRuntime, caller: SavedChild, definitions: AgentDefinition[], params: NestedParams,
  callId: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
  signal?.throwIfAborted();
  const owned = (child: SavedChild) => child.delegation?.ownerId === String(caller.id) && child.delegation.ownerRun === latest(caller).run;
  const input = JSON.stringify({ ...params, requestId: undefined });
  const key = `nested:${caller.id}:${latest(caller).run}:${params.requestId ?? callId}`;
  if (params.action === 'list') return output({
    agents: definitions.map(definition => ({ name: definition.name, description: definition.description, permissions: definition.permissions })),
    children: Object.values((await runtime.state()).children).filter(child => owned(child) && !child.closed).map(latest),
    depth: caller.delegation?.depth ?? 1, maxDepth: caller.settings.maxDepth,
  });
  if (params.action === 'spawn') {
    const prior = await runtime.request(key, input);
    if (prior) return output(prior);
    if (!params.agent || !params.task?.trim()) throw new Error('Nested spawn requires agent and task.');
    const source = definitions.find(definition => definition.name === params.agent);
    if (!source) throw new Error(`Unknown or invalid agent: ${params.agent}.`);
    const depth = (caller.delegation?.depth ?? 1) + 1;
    if (depth > caller.settings.maxDepth) throw new Error('Nested delegation depth limit reached.');
    const permissions = rank[source.permissions] <= rank[caller.definition.permissions] ? source.permissions : caller.definition.permissions;
    const ceiling = (source.toolCeiling ?? source.tools).filter(name => caller.tools.includes(name) && (PERMISSION_TOOLS[permissions] as readonly string[]).includes(name));
    const definition = { ...source, permissions, tools: source.tools.filter(name => ceiling.includes(name)), toolCeiling: ceiling };
    const trust = resolveTrust(params.trust ?? (caller.trust === 'untrusted' ? 'untrusted' : definition.trust));
    if (caller.trust === 'untrusted' && trust !== 'untrusted') throw new Error('Untrusted agents cannot create trusted descendants.');
    const tools = resolveTools(definition, trust, params.tools);
    const selection = resolveSelection(trust, definition, params);
    const inherited = caller.capabilities;
    function choose<K extends 'skills' | 'mcpTools' | 'hooks'>(field: K): Capabilities[K] {
      const available = inherited?.[field] ?? [];
      const names = selection[field];
      if (Array.isArray(names) && names.some(name => !available.some(item => item.name === name))) throw new Error(`Nested ${field} exceed the owner allowlist.`);
      const disabled = selection[field === 'skills' ? 'disabledSkills' : field === 'mcpTools' ? 'disabledMcpTools' : 'disabledHooks'] ?? [];
      return available.filter(item => (!Array.isArray(names) || names.includes(item.name)) && !disabled.includes(item.name)) as Capabilities[K];
    }
    const capabilities: Capabilities = {
      skills: choose('skills').map(skill => ({ ...skill, ...(Array.isArray(selection.skills) ? { preload: true } : {}) })),
      mcpTools: choose('mcpTools').filter(tool => (permissions === 'full' || tool.readOnly) && (!selection.mcpServers || selection.mcpServers.includes(tool.server))),
      hooks: choose('hooks').filter(hook => rank[hook.permissions] <= rank[permissions]),
    };
    tools.push(...capabilityTools(capabilities));
    if (tools.some(name => !caller.tools.includes(name))) throw new Error('Nested tools exceed the owner allowlist.');
    const selectedModel = params.model ?? definition.model ?? 'current';
    const model = selectedModel === 'current' ? caller.model : selectedModel;
    const configured = runtime.configuredModel(model);
    if (!configured) throw new Error(`Configured model unavailable: ${model}.`);
    // Runtime admission also checks the parent's configured model scope.
    const levels = getSupportedThinkingLevels(configured);
    const explicitThinking = params.thinking ?? definition.thinking;
    if (explicitThinking && !levels.includes(explicitThinking)) throw new Error('Nested thinking level is unsupported by the selected model.');
    const thinking = explicitThinking ?? (levels.includes(caller.thinking) ? caller.thinking : levels[0] ?? 'off');
    const context = params.context ?? definition.context ?? caller.settings.context;
    const history = context === 'fork' ? (await runtime.entries(String(caller.id))).flatMap(entry => entry.model ?? []) : undefined;
    const instructions = `You are the ${definition.name} subagent. Your immediate parent is child ${caller.id}; the main parent owns user questions.
Work only on the assigned task. Preserve other agents' edits. Inspect uncertain effects before repeating a write or command.
Your trust policy is ${trust}. Your permission profile is ${permissions}. Available tools: ${tools.join(', ') || 'none'}.
${definition.prompt}\n\n${caller.sharedInstructions ?? ''}\n\n${capabilityPrompt(capabilities)}`;
    return output(await runtime.spawn({ definition, trust, tools, capabilities, task: params.task, model, thinking,
      settings: { ...caller.settings }, instructions, sharedInstructions: caller.sharedInstructions, projectTrusted: caller.projectTrusted,
      isolation: 'shared', context, history, delegation: { ownerId: String(caller.id), ownerRun: latest(caller).run, depth } }, key, input));
  }
  if (!params.id) throw new Error('A nested child ID is required.');
  const child = await runtime.saved(params.id);
  if (!owned(child)) throw new Error('Agents can control only their own direct children in the current task.');
  switch (params.action) {
    case 'send': return output(await runtime.send(params.id, params.task ?? '', key, input));
    case 'steer': return output(await runtime.steer(params.id, params.task ?? '', key, input));
    case 'wait': return output(await runtime.wait(params.id, params.timeoutMs ?? 30000, signal));
    case 'result': await runtime.refresh(); return output(await runtime.get(params.id));
    case 'status': return output(await runtime.get(params.id));
    case 'transcript': return output(await runtime.transcript(params.id));
    case 'cancel': return output(await runtime.stop(params.id));
    case 'close': await runtime.close(params.id); return output(await runtime.get(params.id));
  }
  throw new Error('Unknown nested action.');
}
