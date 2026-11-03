import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager, SettingsManager, type McpServerEntry } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import subagents from '../src/index.ts';
import type { SubagentRuntime } from '../src/runtime.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

test('a real Pi parent delegates its native MCP tool to a background Durable child', async () => {
  const f = await fixture();
  let parent: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let childRuntime: SubagentRuntime | undefined;
  const errors: unknown[] = [];
  try {
    const config = { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./process/mcp-server.ts', import.meta.url)), join(f.dir, 'effect')], exposure: 'direct' as const };
    await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: config } }));
    const entry: McpServerEntry = { name: 'fixture', config, source: join(f.agentDir, 'mcp.json'), scope: 'global' };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager, noExtensions: true, noSkills: true,
      noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [
        createMcpExtension({ loadConfig: () => ({ servers: [entry], errors: [] }), logPath: join(f.agentDir, 'mcp.log') }),
        pi => subagents(pi, { agentDir: f.agentDir, onRuntime: runtime => { childRuntime = runtime; } }),
      ] });
    await resourceLoader.reload();
    parent = (await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime: f.models, model: f.faux.models[0], thinkingLevel: 'off',
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(f.cwd), tools: ['subagent', 'mcp__fixture__inspect'] })).session;
    await parent.bindExtensions({ onError: error => errors.push(error.error) });
    parent.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: answer('Parent received result') }); return stream;
    };
    const deadline = Date.now() + 3000;
    while (!parent.getAllTools().some(tool => tool.name === 'mcp__fixture__inspect')) {
      if (Date.now() > deadline) throw new Error('Native MCP tool did not register');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    f.respond(answer(fauxToolCall('mcp', { tool: 'mcp__fixture__inspect', args: {} }), { stopReason: 'toolUse' }),
      context => { expect(JSON.stringify(context)).toContain(`Local MCP inspect in ${f.cwd}`); return answer('Native MCP evidence collected'); });
    const delegate = parent.agent.state.tools.find(tool => tool.name === 'subagent')!;
    const spawned = await delegate.execute('spawn-native-mcp', { action: 'spawn', agent: 'scout', task: 'Inspect using the configured server', mcpServers: ['fixture'] });
    expect((spawned as any).isError).not.toBe(true);
    const run = await childRuntime!.wait((spawned.details as any).runs[0].id, 3000);
    expect(run.output).toBe('Native MCP evidence collected');
    expect(run.capabilities?.mcpTools).toEqual(['mcp__fixture__inspect']);
    expect(errors).toEqual([]);
  } finally {
    if (parent) { await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); parent.dispose(); }
    await f.cleanup();
  }
});
