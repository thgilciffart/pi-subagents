import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { THINKING_LEVELS, type Thinking, type Isolation, type ContextMode } from './agents.ts';

export type SubagentSettings = {
  maxConcurrent: number;
  maxDepth: number;
  indicatorPosition: 'footer-right' | 'status';
  maxTurns: number;
  timeoutSeconds: number;
  model: string;
  isolation: Isolation;
  context: ContextMode;
  thinking: Thinking | 'current';
}
export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> = {
  maxConcurrent: 4, maxDepth: 3, indicatorPosition: 'footer-right', maxTurns: 20, timeoutSeconds: 300, model: 'current', thinking: 'current', isolation: 'shared', context: 'fresh',
};

export function validateSubagentSettings(value: unknown): SubagentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Subagent settings must be a JSON object.');
  const settings = { ...DEFAULT_SUBAGENT_SETTINGS, ...value } as SubagentSettings;
  for (const [key, max] of [['maxDepth', 8], ['maxConcurrent', 16], ['maxTurns', 100], ['timeoutSeconds', 3600]] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > max) throw new Error(`${key} must be an integer from 1 to ${max}.`);
  }
  if (typeof settings.model !== 'string' || (settings.model !== 'current' && !/^[^/\s]+\/\S+$/.test(settings.model))) throw new Error('model must be current or provider/model-id.');
  if (settings.thinking !== 'current' && !THINKING_LEVELS.includes(settings.thinking)) throw new Error(`thinking must be current or ${THINKING_LEVELS.join(', ')}.`);
  if (settings.isolation !== 'shared' && settings.isolation !== 'worktree') throw new Error('isolation must be shared or worktree.');
  if (settings.context !== 'fresh' && settings.context !== 'fork') throw new Error('context must be fresh or fork.');
  if (settings.indicatorPosition !== 'footer-right' && settings.indicatorPosition !== 'status') throw new Error('indicatorPosition must be footer-right or status.');
  return { indicatorPosition: settings.indicatorPosition, maxDepth: settings.maxDepth, context: settings.context, isolation: settings.isolation, maxConcurrent: settings.maxConcurrent, maxTurns: settings.maxTurns, timeoutSeconds: settings.timeoutSeconds, model: settings.model, thinking: settings.thinking };
}

export async function readSubagentSettings(path: string): Promise<SubagentSettings> {
  try { return validateSubagentSettings(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SUBAGENT_SETTINGS };
    throw error;
  }
}

/** Preserve valid fields in a damaged file without writing until the user applies a change. */
export async function editableSubagentSettings(path: string): Promise<{ settings: SubagentSettings; warning?: string }> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: { ...DEFAULT_SUBAGENT_SETTINGS } };
    if (!(error instanceof SyntaxError)) throw error;
    return { settings: { ...DEFAULT_SUBAGENT_SETTINGS }, warning: 'Settings contain invalid JSON. Defaults are shown; apply a change or choose Save settings to repair the file.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { settings: { ...DEFAULT_SUBAGENT_SETTINGS }, warning: 'Settings must be an object. Save the displayed values to repair the file.' };
  const settings = { ...DEFAULT_SUBAGENT_SETTINGS }, invalid: string[] = [];
  for (const key of Object.keys(settings) as (keyof SubagentSettings)[]) {
    if (!Object.hasOwn(value, key)) continue;
    try { Object.assign(settings, { [key]: validateSubagentSettings({ [key]: (value as Record<string, unknown>)[key] })[key] }); }
    catch { invalid.push(key); }
  }
  return { settings, ...(invalid.length ? { warning: `Invalid values replaced with defaults: ${invalid.join(', ')}. Choose Save settings to repair the file.` } : {}) };
}

export async function writeSubagentSettings(path: string, value: unknown): Promise<void> {
  const settings = validateSubagentSettings(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
