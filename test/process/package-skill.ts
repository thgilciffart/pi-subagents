import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, parseFrontmatter, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';

// Loads the packed package through Pi's package settings, as an installed local package.
const [packageDir, dir] = process.argv.slice(2);
const cwd = join(dir, 'skill-project'), agentDir = join(dir, 'skill-agent');
await mkdir(cwd); await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
const name = 'subagent-orchestration';
const skillFile = await realpath(join(packageDir, 'skills', name, 'SKILL.md'));
const body = parseFrontmatter(await readFile(skillFile, 'utf8')).body;
// A body line that appears only when the full instructions are loaded.
const marker = body.split('\n').map(line => line.trim()).sort((a, b) => b.length - a.length)[0];
const fail = (message: string): never => { throw new Error(message); };

async function load(pkg: string | { source: string; skills: string[] }) {
  const settingsManager = SettingsManager.inMemory({ packages: [pkg], compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length) fail(JSON.stringify(extensions.errors));
  if (!extensions.extensions.some(extension => extension.tools.has('subagent'))) fail('The package extension did not load');
  return { settingsManager, resourceLoader };
}

// Normal Pi package filters exclude the skill for the parent without removing the extension.
const filtered = await load({ source: packageDir, skills: [] });
if (filtered.resourceLoader.getSkills().skills.some(skill => skill.name === name)) fail('Package skill filter did not exclude the skill');

const { settingsManager, resourceLoader } = await load(packageDir);
const { skills, diagnostics } = resourceLoader.getSkills();
const skill = skills.find(item => item.name === name) ?? fail(`Package skill missing: ${JSON.stringify(skills.map(item => item.name))}`);
if (await realpath(skill.filePath) !== skillFile || skill.sourceInfo.origin !== 'package') fail(`Unexpected skill source: ${JSON.stringify(skill)}`);
if (skill.disableModelInvocation) fail('The skill must allow automatic model selection');
if (diagnostics.some(item => item.path?.includes(name))) fail(JSON.stringify(diagnostics));

const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ tokensPerSecond: Infinity }); models.registerNativeProvider(faux.provider);
const childContexts: string[] = [];
const child: FauxResponseFactory = context => {
  const text = JSON.stringify(context);
  childContexts.push(text);
  const loaded = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'skill_read');
  return text.includes('Inherited skill task') && !loaded ? answer(fauxToolCall('skill_read', { skill: name, path: 'SKILL.md' }), { stopReason: 'toolUse' }) : answer('Skill child done');
};
faux.setResponses([child, child, child, child]);
const parent = (await createAgentSession({ cwd, agentDir, modelRuntime: models, model: faux.models[0], thinkingLevel: 'off',
  settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ['read', 'subagent'] })).session;
const errors: string[] = [];
try {
  await parent.bindExtensions({ onError: error => errors.push(error.error) });
  // Pi advertises the skill to the parent without injecting its instructions.
  if (!parent.systemPrompt.includes(name) || parent.systemPrompt.includes(marker)) fail('The parent prompt should list the skill without its body');
  const cases: { requestId: string; task: string; params: Record<string, string[]>; selected: string[] }[] = [
    { requestId: 'inherit', task: 'Inherited skill task', params: {}, selected: [name] },
    { requestId: 'disabled', task: 'Disabled skill task', params: { disabledSkills: [name] }, selected: [] },
    { requestId: 'none', task: 'No skills task', params: { skills: [] }, selected: [] },
  ];
  let requests = 0;
  parent.agent.streamFunction = (_model, context) => {
    requests++;
    const stream = createAssistantMessageEventStream();
    const ids = context.messages.flatMap(message => message.role === 'toolResult' && message.toolName === 'subagent' ? [(message.details as any)?.runs?.[0]?.id] : []);
    const message = requests === 1 ? answer(cases.map(({ requestId, task, params }) => fauxToolCall('subagent', { action: 'spawn', agent: 'Explore', task, requestId, ...params })), { stopReason: 'toolUse' }) :
      requests === 2 ? answer(ids.map(id => fauxToolCall('subagent', { action: 'wait', id, timeoutMs: 5000 })), { stopReason: 'toolUse' }) : answer('Parent done');
    if (requests > 3) fail('Unexpected extra parent turn');
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  };
  await parent.prompt('Delegate the skill checks.');
  const results = parent.messages.filter(message => message.role === 'toolResult' && message.toolName === 'subagent');
  if (requests !== 3 || results.length !== 6 || results.some(message => message.role === 'toolResult' && message.isError)) fail(`Delegation failed: ${JSON.stringify(results)}`);
  for (const [index, item] of cases.entries()) {
    const selected = (results[index] as any).details.runs[0].capabilities.skills;
    if (JSON.stringify(selected) !== JSON.stringify(item.selected)) fail(`${item.requestId} child skills: ${JSON.stringify(selected)}`);
    const seen = childContexts.filter(text => text.includes(item.task));
    if (!seen.length) fail(`${item.requestId} child made no model request`);
    if (item.requestId !== 'inherit' && seen.some(text => text.includes(name))) fail(`${item.requestId} child saw the excluded skill`);
  }
  // The inherited child sees only the name and description until it reads the skill.
  const encoded = JSON.stringify(marker).slice(1, -1);
  const inherited = childContexts.filter(text => text.includes('Inherited skill task'));
  if (inherited.length !== 2 || inherited[0].includes(encoded)) fail('The inherited child should start without the skill body');
  if (!inherited[1].includes(encoded)) fail('skill_read did not return the packaged skill body');
  if (faux.state.callCount !== 4) fail(`Unexpected child requests: ${faux.state.callCount}`);
  if (errors.length) fail(JSON.stringify(errors));
  process.stdout.write('Packaged skill checks passed\n');
} finally { await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); parent.dispose(); }
