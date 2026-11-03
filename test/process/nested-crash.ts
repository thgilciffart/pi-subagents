import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Storage } from '@earendil-works/pi-durable';
import { BUILTIN_AGENTS } from '../../src/agents.ts';
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/config.ts';
import { SubagentRuntime } from '../../src/runtime.ts';
import { openStore } from '../../src/storage.ts';

const [dir, mode, phase] = process.argv.slice(2);
const cwd = join(dir, 'project'), agentDir = join(dir, 'agent');
const store = await openStore(agentDir, join(dir, 'parent.jsonl'), 'nested-parent', cwd);
const original = store.storage;
if (phase === 'crash') store.storage = new Proxy(original, { get(object, key) {
  if (key === 'commit') return (async (writes, context) => {
    const result = await object.commit(writes, context);
    const states = writes.filter(write => write.type === 'document.change' && write.content.kind === 'base')
      .flatMap(write => Object.values((write as any).content.value.children ?? {}) as any[]);
    if ((mode === 'spawn' && states.some(child => child.delegation)) ||
      (mode !== 'spawn' && states.some(child => !child.delegation && child.runs.at(-1)?.status === 'cancelled'))) process.kill(process.pid, 'SIGKILL');
    return result;
  }) satisfies Storage['commit'];
  const value = Reflect.get(object, key, object);
  return typeof value === 'function' ? value.bind(object) : value;
} });
const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ tokensPerSecond: Infinity }); models.registerNativeProvider(faux.provider);
const route = (context: any, options: any) => {
  if (phase === 'crash' && mode !== 'spawn') return new Promise<ReturnType<typeof answer>>(resolve => {
    const abort = () => resolve(answer('', { stopReason: 'aborted' }));
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
  });
  if (context.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('NESTED_EVIDENCE'))) return answer('Saved nested result');
  const results = context.messages.filter((message: any) => message.role === 'toolResult' && message.toolName === 'subagent');
  if (!results.length) return answer(fauxToolCall('subagent', { action: 'spawn', agent: 'Explore', task: 'NESTED_EVIDENCE', requestId: 'nested-once' }, { id: 'nested-spawn' }), { stopReason: 'toolUse' });
  const child = JSON.parse(results[0].content[0].text);
  if (results.length === 1) return answer(fauxToolCall('subagent', { action: 'wait', id: child.id, timeoutMs: 3000 }, { id: 'nested-wait' }), { stopReason: 'toolUse' });
  if (!JSON.stringify(results.at(-1)).includes('Saved nested result')) throw new Error('Nested result did not reach its owner');
  return answer('Root incorporated saved nested result');
};
faux.setResponses(Array.from({ length: 12 }, () => route));
const runtime = await SubagentRuntime.open(store, { parentId: 'nested-parent', cwd, models, allow: () => {}, changed: () => {}, error: error => console.error(error) });
try {
  if (phase === 'crash') {
    const owner = await runtime.spawn({ definition: BUILTIN_AGENTS[0], task: 'ROOT_TASK', tools: [...BUILTIN_AGENTS[0].tools],
      settings: { ...DEFAULT_SUBAGENT_SETTINGS }, model: 'faux/faux-1', thinking: 'off', instructions: 'Return evidence.', projectTrusted: false }, 'root', 'root');
    if (mode !== 'spawn') {
      await runtime.delegate(owner.id, { action: 'spawn', agent: 'Plan', task: 'NESTED_EVIDENCE' }, 'direct-nested');
      if (mode === 'close') await runtime.close(owner.id); else await runtime.stop(owner.id);
    }
    await runtime.wait(owner.id, 5000);
    throw new Error('Crash injection did not fire');
  }
  await runtime.resume();
  const owner = Object.values((await runtime.state()).children).find(child => !child.delegation)!;
  const result = await runtime.wait(String(owner.id), 5000);
  const children = await runtime.list();
  await writeFile(join(dir, 'nested-recovered.json'), JSON.stringify({ result, children, calls: faux.state.callCount,
    pending: await runtime.pending(), policies: Object.values((await runtime.state()).children).map(child => child.policy) }));
} finally { await runtime.dispose(); }
