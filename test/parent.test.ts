import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { registerChildHook } from '../src/capabilities.ts';
import subagents from '../src/index.ts';

// Adapted from the handoff's real SDK parent/child integration test.
test.each(['fresh', 'fork'] as const)('a real Pi parent keeps working and receives one asynchronous %s child result', async contextMode => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-parent-'));
  const cwd = join(dir, 'project'), agentDir = join(dir, 'agent'); await mkdir(cwd); await mkdir(agentDir);
  let parent: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0, childContext = ''; 
  const errors: unknown[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ tokensPerSecond: Infinity }); runtime.registerNativeProvider(faux.provider);
    faux.setResponses([async context => { childContext = JSON.stringify(context); await gate; return fauxAssistantMessage('Asynchronous child evidence'); }]);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const skill = join(agentDir, 'skills', 'evidence', 'SKILL.md');
    await mkdir(join(agentDir, 'skills', 'evidence'), { recursive: true });
    await writeFile(skill, '---\nname: evidence\ndescription: Evidence fixture\n---\nSKILL_PARENT_CONFIGURED');
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: false, additionalSkillPaths: [skill],
      noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [pi => { registerChildHook(pi, { name: 'policy', version: '1', permissions: 'read-only', replay: 'safe', project: false }); subagents(pi, { agentDir }); }] });
    await resourceLoader.reload();
    parent = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.models[0], thinkingLevel: 'off',
      settingsManager, resourceLoader, sessionManager: SessionManager.create(cwd, join(dir, 'sessions')), tools: ['subagent'] })).session;
    await parent.bindExtensions({ onError: error => errors.push(error.error) });
    const contexts: unknown[] = [];
    parent.agent.streamFunction = (_model, context) => {
      contexts.push(context); requests++;
      const stream = createAssistantMessageEventStream();
      const message = requests === 1 ? fauxAssistantMessage(fauxToolCall('subagent', {
        action: 'spawn', agent: 'scout', task: 'Collect evidence', requestId: 'parent-delegation', context: contextMode, ...(contextMode === 'fork' ? { skills: ['evidence'] } : {}), hooks: ['policy'],
      }), { stopReason: 'toolUse' }) : fauxAssistantMessage(requests === 2 ? 'Independent work finished' : 'Evidence incorporated');
      if (requests > 3) throw new Error('Duplicate parent continuation');
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      return stream;
    };
    let settled!: () => void; const finished = new Promise<void>(resolve => { settled = resolve; });
    parent.subscribe(event => { if (event.type === 'agent_settled' && requests === 3) settled(); });
    await parent.prompt('Delegate to scout and continue independent work.');
    expect(requests).toBe(2); release();
    const timer = setTimeout(settled, 3000);
    try { await finished; } finally { clearTimeout(timer); }
    expect(requests).toBe(3);
    expect(childContext.includes('SKILL_PARENT_CONFIGURED')).toBe(contextMode === 'fork');
    expect(childContext).toContain('evidence');
    if (contextMode === 'fresh') expect(childContext).toContain('Inherited skills are available on demand');
    expect(childContext).toContain('Selected child hooks: policy');
    expect(childContext.includes('Delegate to scout and continue independent work.')).toBe(contextMode === 'fork');
    if (contextMode === 'fork') expect(childContext).toContain('had no saved result at the fork point');
    expect(JSON.stringify(contexts[2])).toContain('Asynchronous child evidence');
    expect(errors).toEqual([]);
    const receipts = parent.sessionManager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'pi-subagents-results');
    expect(receipts).toHaveLength(1);
  } finally {
    release?.();
    if (parent) { await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); parent.dispose(); }
    await rm(dir, { recursive: true, force: true });
  }
});
