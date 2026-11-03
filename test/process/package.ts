import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const [entrypoint, dir, hook] = process.argv.slice(2);
const cwd = join(dir, 'project'), agentDir = join(dir, 'agent'); await mkdir(cwd); await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ tokensPerSecond: Infinity }); models.registerNativeProvider(faux.provider);
faux.setResponses([answer('Packaged child result')]);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
  noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [entrypoint, hook] });
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
if (!loaded.extensions.some(extension => extension.tools.has('subagent'))) throw new Error('Packed extension did not register its tool');
const parent = (await createAgentSession({ cwd, agentDir, modelRuntime: models, model: faux.models[0], thinkingLevel: 'off',
  settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ['subagent'] })).session;
const errors: string[] = [];
try {
  await parent.bindExtensions({ onError: error => errors.push(error.error) });
  const delegate = parent.agent.state.tools.find(tool => tool.name === 'subagent')!;
  const catalog = await delegate.execute('packaged-list', { action: 'list' });
  if ((catalog as any).isError || !JSON.stringify(catalog).includes('Parent capabilities')) throw new Error(`Packaged list failed: ${JSON.stringify(catalog)}`);
  let requests = 0;
  parent.agent.streamFunction = (_model, context) => {
    requests++;
    const stream = createAssistantMessageEventStream();
    const spawned = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'subagent');
    const id = spawned && spawned.role === 'toolResult' ? (spawned.details as any)?.runs?.[0]?.id : undefined;
    const message = requests === 1 ? answer(fauxToolCall('subagent', { action: 'spawn', agent: 'Explore', task: 'Check packaged extension' }), { stopReason: 'toolUse' }) :
      requests === 2 ? answer(fauxToolCall('subagent', { action: 'wait', id, timeoutMs: 3000 }), { stopReason: 'toolUse' }) : answer('Parent done');
    if (requests > 3) throw new Error('Unexpected duplicate turn from the packaged extension');
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  };
  await parent.prompt('Check the installed subagent tool.');
  if (requests !== 3 || faux.state.callCount !== 1 || !JSON.stringify(parent.messages).includes('Packaged child result')) throw new Error('Packaged delegation did not complete');
  if (Reflect.get(globalThis, Symbol.for('pi-subagents-package-hook')) !== 1) throw new Error('Packaged public hook import or lifecycle execution failed');
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally { await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); parent.dispose(); }
