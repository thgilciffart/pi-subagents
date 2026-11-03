import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEventBus, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Storage, JsonObject } from '@earendil-works/pi-durable';
import { BUILTIN_AGENTS, PERMISSION_TOOLS } from '../../src/agents.ts';
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/config.ts';
import { SubagentRuntime } from '../../src/runtime.ts';
import { git } from '../../src/worktrees.ts';
import { ParentCapabilities, capabilityTools, registerChildHook, type McpBridge } from '../../src/capabilities.ts';
import { openStore } from '../../src/storage.ts';

const [dir, mode, phase] = process.argv.slice(2);
const cwd = join(dir, 'project'), agentDir = join(dir, 'agent');
const store = await openStore(agentDir, join(dir, 'parent.jsonl'), 'parent', cwd);
const target = store.storage;
if (phase === 'crash' && mode.startsWith('worktree-')) {
  await git(cwd, ['init', '--initial-branch=main']);
  await git(cwd, ['config', 'user.name', 'Crash fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await git(cwd, ['add', 'effect']); await git(cwd, ['commit', '-m', 'Add crash fixture']);
}
const die = () => { process.kill(process.pid, 'SIGKILL'); };
if (phase === 'crash') store.storage = new Proxy(target, { get(object, key) {
  if (key === 'commit') return (async (writes, context) => {
    // A result commit follows execution. Kill before saving it, after the file effect.
    if (['write', 'edit', 'bash', 'hook-completed'].includes(mode) && writes.some(write => write.type === 'task' && write.value.kind === 'pi.tool' && write.value.state.status === 'terminal')) die();
    if (mode === 'worktree-created' && writes.some(write => write.type === 'document.change' && write.content.kind === 'base' &&
      Object.values((write.content.value as any).children ?? {}).some((child: any) => child.worktree?.ready))) die();
    const result = await object.commit(writes, context);
    if (mode === 'worktree-intent' && writes.some(write => write.type === 'document.change' && write.content.kind === 'base' &&
      Object.values((write.content.value as any).children ?? {}).some((child: any) => child.worktree && !child.worktree.ready))) die();
    if (mode === 'steering' && writes.some(write => write.type === 'document.change' && write.content.kind === 'base' &&
      Object.values((write.content.value as any).children ?? {}).some((child: any) => child.runs.at(-1)?.steering?.length))) die();
    // Kill with a saved read intent. Recovery must execute this safe call.
    if (mode === 'admission' && writes.some(write => write.type === 'document.change' && write.content.kind === 'base' &&
      Object.keys((write.content.value as any).children ?? {}).length > 0)) die();
    if (mode === 'submission' && writes.some(write => write.type === 'submission')) die();
    if (mode === 'read' && writes.some(write => write.type === 'task' && write.value.kind === 'pi.tool' &&
      'checkpoint' in write.value.state && (write.value.state.checkpoint as any)?.phase === 'execute')) die();
    if (['cancel', 'close'].includes(mode) && writes.some(write => write.type === 'document.change' && write.content.kind === 'base' &&
      Object.values((write.content.value as any).children ?? {}).some((child: any) => child.closed || child.runs.at(-1)?.status === 'cancelled'))) die();
    return result;
  }) satisfies Storage['commit'];
  const value = Reflect.get(object, key, object);
  return typeof value === 'function' ? value.bind(object) : value;
} });
const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ tokensPerSecond: Infinity }); models.registerNativeProvider(faux.provider);
const contexts: unknown[] = [];
if (phase === 'crash') {
  if (['model', 'cancel', 'close', 'admission', 'submission', 'steering', 'worktree-intent', 'worktree-created', 'worktree-active', 'lifecycle-start', 'lifecycle-safe-start', 'lifecycle-close', 'lifecycle-resume', 'untrusted'].includes(mode)) faux.setResponses([async (_context, options) => {
    await writeFile(join(dir, 'model-started'), 'yes');
    if (mode === 'model' || mode === 'lifecycle-resume' || mode === 'untrusted') die();
    if (mode === 'worktree-active') { const child = (await runtime.list())[0]; await writeFile(join(child.cwd!, 'progress.txt'), 'Saved isolated progress'); die(); }
    await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return answer('', { stopReason: 'aborted' });
  }]);
  else if (mode === 'lifecycle-stop') faux.setResponses([answer('Finished before lifecycle hook')]);
  else {
    const path = join(cwd, 'effect');
    const args: JsonObject = mode === 'write' ? { path, content: 'written-once' } : mode === 'edit' ?
      { path, edits: [{ oldText: 'old', newText: 'new' }] } : mode === 'bash' ?
      { command: `printf x >> '${path}'` } : { path };
    faux.setResponses([answer(fauxToolCall(mode === 'mcp' ? 'mcp' : mode.startsWith('hook-') ? 'read' : mode, mode === 'mcp' ? { tool: 'mcp__fixture__append', args: {} } : args), { stopReason: 'toolUse' })]);
  }
} else faux.setResponses(Array.from({ length: mode === 'steering' ? 2 : 1 }, () => context => { contexts.push(context); return answer('Recovered from saved progress'); }));
const events = createEventBus();
const mcpTool = { name: 'mcp__fixture__append', server: 'fixture', description: 'Append fixture', parameters: {}, readOnly: false, signature: 'fixture', configHash: 'fixture', project: false };
const mcp: McpBridge = { catalog: async () => [mcpTool], validate: async () => {}, close: async () => {}, call: async () => {
  await appendFile(join(cwd, 'effect'), 'x'); if (phase === 'crash') die();
  return { output: [{ type: 'text', text: 'MCP effect' }] };
} };
const lifecycleEffect = async () => {
  if (mode === 'lifecycle-safe-start') await writeFile(join(cwd, 'effect'), 'x');
  else await appendFile(join(cwd, 'effect'), 'x');
  if (phase === 'crash' || (mode === 'lifecycle-resume' && phase === 'recover')) die();
};
registerChildHook({ events }, { name: 'fixture', version: '1', permissions: 'full', project: false,
  replay: mode === 'lifecycle-safe-start' ? 'safe' : 'unsafe',
  ...(mode.startsWith('lifecycle-') ?
    mode === 'lifecycle-stop' ? { onStop: lifecycleEffect } : mode === 'lifecycle-close' ? { onClose: lifecycleEffect } :
    mode === 'lifecycle-resume' ? { onResume: lifecycleEffect } : { onStart: lifecycleEffect } :
    ['hook-before', 'hook-completed'].includes(mode) ? { beforeTool: async () => { await appendFile(join(cwd, 'effect'), 'x'); if (phase === 'crash' && mode !== 'hook-completed') die(); } } :
    { afterTool: async () => { await appendFile(join(cwd, 'effect'), 'x'); if (phase === 'crash') die(); } }),
});
const capabilities = new ParentCapabilities({ events, getCommands: () => [] }, () => ({ isProjectTrusted: () => true }) as any, mcp);
const selected = await capabilities.select({ mcpTools: [], hooks: [], ...(mode === 'mcp' ? { mcpTools: [mcpTool.name] } : {}), ...((mode.startsWith('hook-') || mode.startsWith('lifecycle-')) ? { hooks: ['fixture'] } : {}) }, 'full');
const runtime = await SubagentRuntime.open(store, { capabilities, parentId: 'parent', cwd, models, allow: () => {}, changed: () => {}, error: error => console.error(error) });
try {
  if (phase === 'crash') {
    const run = await runtime.spawn({ definition: { ...BUILTIN_AGENTS[0], permissions: 'full', tools: [...PERMISSION_TOOLS.full] },
      task: 'Keep this original task and conversation', trust: mode === 'untrusted' ? 'untrusted' : 'trusted', capabilities: selected, tools: mode === 'untrusted' ? ['read'] : [...PERMISSION_TOOLS.full, ...capabilityTools(selected)], settings: { ...DEFAULT_SUBAGENT_SETTINGS },
      model: 'faux/faux-1', thinking: 'off', isolation: mode.startsWith('worktree-') ? 'worktree' : 'shared', instructions: 'Report to parent', projectTrusted: false }, 'original', 'original');
    if (mode === 'steering') await runtime.steer(run.id, 'Preserve crash-safe steering', 'direction', 'direction');
    if (mode === 'cancel') await runtime.stop(run.id);
    if (mode === 'close' || mode === 'lifecycle-close') await runtime.close(run.id);
    await runtime.wait(run.id, 5000);
    await runtime.refresh();
    throw new Error('Crash injection did not fire');
  } else {
    await runtime.resume();
    const runs = await runtime.list();
    if (runs[0]) await runtime.wait(runs[0].id, 5000);
    const state = await runtime.state();
    const child = Object.values(state.children)[0];
    await writeFile(join(dir, 'recovered.json'), JSON.stringify({ child, contexts, calls: faux.state.callCount,
      entries: await runtime.entries(String(child.id)) }));
  }
} finally { await runtime.dispose(); }
