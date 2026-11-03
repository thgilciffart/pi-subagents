import { expect, test } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BUILTIN_AGENTS, parseAgent, PERMISSION_TOOLS } from '../src/agents.ts';
import { resolveSelection, resolveTools, resolveTrust } from '../src/policy.ts';
import { Children } from '../src/runtime.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

const full = { ...BUILTIN_AGENTS[2], permissions: 'full' as const, tools: [...PERMISSION_TOOLS.full] };
test('trust chooses defaults without expanding a named permission ceiling', () => {
  expect(resolveTrust(undefined)).toBe('trusted'); expect(() => resolveTrust('root')).toThrow('trust');
  expect(resolveTools(full, 'untrusted')).toEqual([]);
  expect(resolveTools(full, 'untrusted', ['read', 'ls'])).toEqual(['read', 'ls']);
  expect(resolveTools(full, 'trusted', undefined, ['bash', 'write'])).not.toContain('bash');
  expect(() => resolveTools(BUILTIN_AGENTS[0], 'trusted', ['bash'])).toThrow('permissions');
  expect(() => resolveTools(full, 'trusted', undefined, ['unknown'])).toThrow('disabledTools');
});
test('untrusted children do not inherit trusted definition capabilities or accept broad selectors', () => {
  const definition = { ...full, skills: ['inspect'], mcpTools: ['mcp__docs__read'], hooks: ['audit'] };
  expect(resolveSelection('untrusted', definition, {})).toMatchObject({ skills: [], mcpTools: [], hooks: [] });
  expect(resolveSelection('trusted', definition, {})).toMatchObject({ skills: ['inspect'], mcpTools: ['mcp__docs__read'], hooks: ['audit'] });
  for (const input of [{ skills: 'inherit' as const }, { hooks: 'inherit' as const }, { mcpTools: 'inherit' as const }, { mcpServers: ['docs'] }, { mcpServers: [] }]) {
    expect(() => resolveSelection('untrusted', full, input)).toThrow(/allowlist|exact/);
  }
  expect(resolveSelection('untrusted', definition, { skills: ['inspect'], mcpTools: ['mcp__docs__read'], hooks: ['audit'] }))
    .toMatchObject({ skills: ['inspect'], mcpTools: ['mcp__docs__read'], hooks: ['audit'] });
});
test('untrusted definitions persist explicit allowlists and default to no built-in tools', () => {
  const content = (fields: string) => `---\nname: limited\ndescription: Limited\ntrust: untrusted\n${fields}\n---\nInspect`;
  const none = parseAgent(content(''), 'limited.md'); expect(none.tools).toEqual([]);
  expect(resolveTools(none, 'untrusted', ['read'])).toEqual(['read']);
  expect(() => resolveTools(parseAgent(content('tools: []'), 'limited.md'), 'untrusted', ['read'])).toThrow('permissions');
  const named = parseAgent(content('tools: [read]\nskills: [inspect]\nhooks: [audit]'), 'limited.md');
  expect(resolveTools(named, 'untrusted')).toEqual(['read']);
  expect(resolveSelection('untrusted', named, {})).toMatchObject({ skills: ['inspect'], mcpTools: [], hooks: ['audit'] });
  for (const fields of ['skills: inherit', 'hooks: inherit', 'mcpTools: inherit', 'mcpServers: [docs]', 'mcpServers: []']) expect(() => parseAgent(content(fields), 'limited.md')).toThrow('allowlist');
});
test('an untrusted full-profile child enforces its saved read-only allowlist through reopen and follow-up', async () => {
  const f = await fixture(true);
  try {
    const path = join(f.cwd, 'evidence'); await writeFile(path, 'Original evidence');
    f.respond(answer(fauxToolCall('write', { path, content: 'bad' }), { stopReason: 'toolUse' }),
      answer(fauxToolCall('bash', { command: 'echo forbidden' }), { stopReason: 'toolUse' }),
      answer(fauxToolCall('read', { path }), { stopReason: 'toolUse' }), answer('Read only'));
    const run = await f.spawn({ definition: full, trust: 'untrusted', tools: ['read'] });
    expect((await f.runtime.wait(run.id, 3000)).output).toBe('Read only');
    expect(await readFile(path, 'utf8')).toBe('Original evidence');
    const original = await f.runtime.saved(run.id); expect(original.policy?.tools).toEqual(['read']); expect(original.trust).toBe('untrusted');
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    expect((await f.runtime.saved(run.id)).policy).toEqual(original.policy);
    f.respond(answer('Follow-up'));
    await f.runtime.send(run.id, 'Continue', 'continue', 'continue'); await f.runtime.wait(run.id, 3000);
    expect((await f.runtime.get(run.id)).trust).toBe('untrusted');
    await f.runtime.harness.commit(async tx => { (await tx.doc(Children)).children[run.id].tools.push('bash'); }, C);
    await expect(f.runtime.send(run.id, 'Broaden', 'broaden', 'broaden')).rejects.toThrow('allowlist');
    expect(f.faux.state.callCount).toBe(5);
    await f.runtime.harness.commit(async tx => { const child = (await tx.doc(Children)).children[run.id]; child.tools = ['read']; child.trust = 'trusted'; }, C);
    await expect(f.runtime.send(run.id, 'Change trust', 'change-trust', 'change-trust')).rejects.toThrow('trust policy');
  } finally { await f.cleanup(); }
});
test('legacy saved children receive a policy for their existing tool set without inheriting new tools', async () => {
  const f = await fixture(true);
  try {
    f.respond(answer('Done')); const run = await f.spawn({ tools: ['read'] }); await f.runtime.wait(run.id, 3000);
    await f.runtime.harness.commit(async tx => { const child = (await tx.doc(Children)).children[run.id]; delete child.policy; delete child.trust; }, C);
    await f.runtime.dispose(); await f.open();
    const child = await f.runtime.saved(run.id); expect(child.trust).toBe('trusted'); expect(child.policy?.tools).toEqual(['read']);
  } finally { await f.cleanup(); }
});
