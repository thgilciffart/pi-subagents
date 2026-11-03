import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { BUILTIN_AGENTS } from '../src/agents.ts';
import { DEFAULT_SUBAGENT_SETTINGS } from '../src/config.ts';
import { SubagentRuntime, type SpawnOptions } from '../src/runtime.ts';
import type { ParentCapabilities } from '../src/capabilities.ts';
import { openStore } from '../src/storage.ts';

export async function fixture(persistent = false, parentId = 'parent', capabilities?: (paths: { cwd: string; agentDir: string }) => ParentCapabilities) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-test-'));
  const cwd = join(dir, 'project'), agentDir = join(dir, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const models = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  let runtime: SubagentRuntime;
  const errors: unknown[] = [];
  let allow = (_child: unknown) => {};
  const open = async () => {
    runtime = await SubagentRuntime.open(await openStore(agentDir, persistent ? join(dir, 'parent.jsonl') : undefined, parentId, cwd),
      { capabilities: capabilities?.({ cwd, agentDir }), parentId, cwd, worktreeRoot: join(dir, 'worktrees'), models, allow: child => allow(child), changed: () => {}, error: error => errors.push(error) });
    return runtime;
  };
  await open();
  const options = (extra: Partial<SpawnOptions> = {}): SpawnOptions => ({ definition: { ...BUILTIN_AGENTS[0] }, task: 'Inspect the fixture', tools: [...BUILTIN_AGENTS[0].tools],
    settings: { ...DEFAULT_SUBAGENT_SETTINGS }, model: 'faux/faux-1', thinking: 'off', instructions: 'Report to the parent.', projectTrusted: false, ...extra });
  return { dir, cwd, agentDir, faux, models, errors, options, open, get runtime() { return runtime; },
    respond: (...steps: FauxResponseStep[]) => faux.setResponses(steps), allow: (fn: typeof allow) => { allow = fn; },
    spawn: (extra: Partial<SpawnOptions> = {}, key = 'spawn-1') => runtime.spawn(options(extra), key, key),
    cleanup: async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
export { fauxAssistantMessage };
