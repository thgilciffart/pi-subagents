import { checkWorktreePath } from './worktrees.ts';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import { defineTool, type ToolRegistration, type ConversationId, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { Type } from 'typebox';
import { emptyCapabilities, type ParentCapabilities } from './capabilities.ts';
import type { SavedChild } from './runtime.ts';

const factories = { read: createReadTool, grep: createGrepTool, find: createFindTool, ls: createLsTool,
  edit: createEditTool, write: createWriteTool, bash: createBashTool };

export function childTools(cwd: string, authorize: (id: ConversationId, name: string) => Promise<SavedChild>, capabilities?: ParentCapabilities): ToolRegistration[] {
  async function execute(name: string, args: unknown, api: ToolExecutionApi, context: Context,
    run: (child: SavedChild) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    context.abortSignal?.throwIfAborted();
    let child = await authorize(api.conversationId, name);
    const selected = child.capabilities ?? emptyCapabilities();
    const hookContext = { childId: String(child.id), cwd: child.cwd, permissions: child.definition.permissions, signal: context.abortSignal };
    await capabilities?.runHooks(selected, 'before', name, args, undefined, hookContext, api, context);
    // A hook can yield while trust, cancellation, or permissions change.
    child = await authorize(api.conversationId, name);
    context.abortSignal?.throwIfAborted();
    const result = await run(child);
    return await capabilities?.runHooks(selected, 'after', name, args, result, hookContext, api, context) ?? result;
  }
  const tools: ToolRegistration[] = Object.entries(factories).map(([name, factory]) => {
    const tool: AgentTool = factory(cwd);
    return defineTool({ name, description: tool.description, parameters: tool.parameters,
      replay: ['read', 'grep', 'find', 'ls'].includes(name) ? 'safe' : 'unsafe',
      execute: (args, api, context) => execute(name, args, api, context, async child => {
        let checkedArgs = args;
        if (child.worktree && name !== 'bash') {
          const path = await checkWorktreePath(child.worktree, child.cwd, (args as { path?: string }).path, name === 'read');
          checkedArgs = { ...(args as Record<string, unknown>), path };
        }
        const current: AgentTool = factory(child.cwd);
        const result = await current.execute(api.callId, checkedArgs, context.abortSignal);
        return { output: result.content };
      }),
    });
  });
  tools.push(defineTool({ name: 'skill_read', description: 'Read a supporting file inside a selected skill directory. Use the skill name and a relative path.',
    parameters: Type.Object({ skill: Type.String(), path: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }), replay: 'safe',
    execute: (args, api, context) => execute('skill_read', args, api, context, async child => {
      if (!capabilities) throw new Error('Child skills are unavailable.');
      const path = await capabilities.skillPath(child.capabilities ?? emptyCapabilities(), args.skill, args.path);
      const result = await createReadTool(child.cwd).execute(api.callId, { path, offset: args.offset, limit: args.limit }, context.abortSignal);
      return { output: result.content };
    }),
  }));
  tools.push(defineTool({ name: 'mcp', description: 'Call one of the exact parent-selected MCP tools described in your instructions. Uncertain calls are never automatically repeated.',
    parameters: Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }), replay: 'unsafe',
    execute: (args, api, context) => execute('mcp', args, api, context, async child => {
      if (!capabilities) throw new Error('Child MCP tools are unavailable.');
      const tool = child.capabilities?.mcpTools.find(tool => tool.name === args.tool);
      if (!tool) throw new Error(`MCP tool is outside the saved selection: ${args.tool}.`);
      return capabilities.mcp.call(tool, String(child.id), child.cwd, args.args, context.abortSignal);
    }),
  }));
  return tools;
}
