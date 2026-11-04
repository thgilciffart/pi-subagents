import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { JsonObject } from '@earendil-works/pi-durable';
import { BUILTIN_AGENTS } from '../src/agents.ts';
import { Children } from '../src/runtime.ts';
import { nestedOperation } from '../src/nested.ts';
import { runSummary } from '../src/ui.ts';
import { git } from '../src/worktrees.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

const text = (result: any) => JSON.parse(result.output[0].text);
const call = (args: JsonObject, id = 'delegate') => answer(fauxToolCall('subagent', args, { id }), { stopReason: 'toolUse' });
function hold(_context: unknown, options: any) {
  return new Promise<ReturnType<typeof answer>>(resolve => {
    const abort = () => resolve(answer('', { stopReason: 'aborted' }));
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener('abort', abort, { once: true });
  });
}

test('Claude-style built-ins replace the earlier roles', () => {
  expect(BUILTIN_AGENTS.map(agent => agent.name)).toEqual(['Explore', 'Plan', 'general-purpose']);
  expect(BUILTIN_AGENTS.slice(0, 2).every(agent => agent.permissions === 'read-only' && !agent.tools.includes('bash'))).toBe(true);
  expect(BUILTIN_AGENTS[2].tools).toContain('bash');
});

test('a real child delegates and receives its own result without notifying the main parent twice', async () => {
  const f = await fixture(true);
  try {
    const route = (context: any) => {
      if (context.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('Nested evidence'))) return answer('Evidence from grandchild');
      const results = context.messages.filter((message: any) => message.role === 'toolResult' && message.toolName === 'subagent');
      if (!results.length) return call({ action: 'spawn', agent: 'Explore', task: 'Nested evidence', requestId: 'research' });
      const first = JSON.parse(results[0].content[0].text);
      if (results.length === 1) return call({ action: 'wait', id: first.id, timeoutMs: 3000 }, 'wait');
      expect(JSON.stringify(results.at(-1))).toContain('Evidence from grandchild');
      return answer('Parent incorporated nested evidence');
    };
    f.respond(...Array.from({ length: 8 }, () => route));
    const run = await f.spawn({ task: 'Top task' });
    expect((await f.runtime.wait(run.id, 5000)).output).toBe('Parent incorporated nested evidence');
    const children = await f.runtime.list();
    expect(children).toHaveLength(2);
    const nested = children.find(child => child.parentChildId === run.id)!;
    expect(nested.depth).toBe(2);
    expect((await f.runtime.pending()).map(child => child.id)).toEqual([run.id]);
    expect(runSummary(nested)).toContain(`parent #${run.id}`);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});

test('nested automatic request keys distinguish repeated provider call IDs across assistant turns', async () => {
  const f = await fixture();
  try {
    const route = (context: any, options: any) => {
      if (context.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('Repeated nested evidence'))) return hold(context, options);
      const results = context.messages.filter((message: any) => message.role === 'toolResult' && message.toolName === 'subagent');
      return results.length < 2 ? call({ action: 'spawn', agent: 'Explore', task: 'Repeated nested evidence' }, 'call_0') : answer('Spawned two independent tasks');
    };
    f.respond(...Array.from({ length: 8 }, () => route));
    const owner = await f.spawn(); await f.runtime.wait(owner.id, 3000);
    expect((await f.runtime.list()).filter(child => child.parentChildId === owner.id)).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test('nested retries preserve IDs, ownership, read-only permissions, and the global concurrency limit', async () => {
  const f = await fixture(true);
  try {
    f.respond(...Array.from({ length: 8 }, () => hold));
    const owner = await f.spawn();
    const params = { action: 'spawn' as const, agent: 'general-purpose', task: 'Read evidence', requestId: 'same' };
    const first = text(await f.runtime.delegate(owner.id, params, 'call-1'));
    const retry = text(await f.runtime.delegate(owner.id, params, 'call-2'));
    expect(retry.id).toBe(first.id);
    expect((await f.runtime.list())).toHaveLength(2);
    expect(first.tools).not.toContain('write'); expect(first.tools).not.toContain('bash');
    await expect(f.runtime.delegate(owner.id, { ...params, requestId: 'broad', tools: ['bash'] }, 'broaden')).rejects.toThrow('permissions');
    const second = text(await f.runtime.delegate(owner.id, { ...params, requestId: 'other' }, 'other'));
    await expect(f.runtime.delegate(first.id, { action: 'status', id: second.id }, 'sibling')).rejects.toThrow('own direct children');
    await f.runtime.delegate(owner.id, { ...params, requestId: 'third' }, 'third');
    await expect(f.runtime.delegate(owner.id, { ...params, requestId: 'over' }, 'over')).rejects.toThrow('At most 4');
    await f.runtime.stop(owner.id);
    expect((await f.runtime.list()).every(child => child.status === 'cancelled')).toBe(true);
    const count = f.faux.state.callCount;
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    expect(f.faux.state.callCount).toBe(count);
    await expect(f.runtime.send(first.id, 'Restart orphan', 'orphan', 'orphan')).rejects.toThrow('active');
  } finally { await f.cleanup(); }
});

test('untrusted delegation requires an explicit tool and cannot widen trust or capabilities', async () => {
  const f = await fixture();
  try {
    f.respond(...Array.from({ length: 8 }, () => hold));
    const noDelegation = await f.spawn({ trust: 'untrusted', tools: ['read'] });
    await expect(f.runtime.delegate(noDelegation.id, { action: 'list' }, 'deny')).rejects.toThrow('permission');
    const owner = await f.spawn({ trust: 'untrusted', tools: ['read', 'subagent'] }, 'untrusted-owner');
    const request = { action: 'spawn' as const, agent: 'general-purpose', task: 'Inspect' };
    const child = text(await f.runtime.delegate(owner.id, { ...request, tools: ['read'] }, 'allow'));
    expect(child.trust).toBe('untrusted'); expect(child.tools).toEqual(['read']);
    await expect(f.runtime.delegate(owner.id, { ...request, trust: 'trusted' }, 'trust')).rejects.toThrow('trusted descendants');
    await expect(f.runtime.delegate(owner.id, { ...request, skills: ['not-granted'] }, 'skill')).rejects.toThrow('allowlist');
    await expect(f.runtime.delegate(owner.id, { ...request, mcpTools: ['mcp__hidden__write'] }, 'mcp')).rejects.toThrow('allowlist');
  } finally { await f.cleanup(); }
});

test('depth three removes delegation, and depth one disables it for new children', async () => {
  const f = await fixture();
  try {
    f.respond(...Array.from({ length: 8 }, () => hold));
    const owner = await f.spawn();
    const params = { action: 'spawn' as const, agent: 'Explore', task: 'Nested' };
    const second = text(await f.runtime.delegate(owner.id, params, 'second'));
    const third = text(await f.runtime.delegate(second.id, params, 'third'));
    expect(third.depth).toBe(3); expect(third.tools).not.toContain('subagent');
    await expect(f.runtime.delegate(third.id, params, 'fourth')).rejects.toThrow('permission');
    await f.runtime.stop(owner.id);
    const disabled = await f.spawn({ settings: { ...f.options().settings, maxDepth: 1 } }, 'no-nesting');
    expect(disabled.tools).not.toContain('subagent');
  } finally { await f.cleanup(); }
});

test('nested fork context and saved policy survive reload without duplicate children', async () => {
  const f = await fixture(true);
  try {
    f.respond(...Array.from({ length: 8 }, () => hold));
    const owner = await f.spawn({ task: 'Owner history marker' });
    await writeFile(join(f.cwd, 'evidence'), 'Read-only evidence');
    const params = { action: 'spawn' as const, agent: 'Plan', task: 'Plan from saved context', context: 'fork' as const, requestId: 'persistent-nested' };
    const nested = text(await f.runtime.delegate(owner.id, params, 'first'));
    const saved = await f.runtime.saved(nested.id);
    expect(await f.runtime.transcript(nested.id)).toContain('Owner history marker');
    await f.runtime.dispose(); await f.open();
    f.respond(...Array.from({ length: 8 }, () => hold));
    await f.runtime.resume();
    const retry = text(await f.runtime.delegate(owner.id, params, 'retry'));
    expect(retry.id).toBe(nested.id); expect(await f.runtime.list()).toHaveLength(2);
    expect((await f.runtime.saved(nested.id)).policy).toEqual(saved.policy);
    await f.runtime.harness.commit(async tx => {
      (await tx.doc(Children)).children[nested.id].delegation!.ownerId = nested.id;
    }, C);
    await expect(f.runtime.delegate(nested.id, { action: 'list' }, 'tamper')).rejects.toThrow('ownership');
  } finally { await f.cleanup(); }
});

test('nested forks respect the owner context head after a reset', async () => {
  const f = await fixture();
  try {
    f.respond(answer('Old private history'));
    const owner = await f.spawn({ task: 'OLD_CONTEXT_MARKER' }); await f.runtime.wait(owner.id, 3000);
    await (await f.runtime.harness.conversation((await f.runtime.saved(owner.id)).id, C))!.reset('CURRENT_CONTEXT_MARKER', C);
    f.respond(hold, hold);
    await f.runtime.send(owner.id, 'Current task', 'current', 'current');
    const child = text(await f.runtime.delegate(owner.id, { action: 'spawn', agent: 'Explore', task: 'Read current context', context: 'fork' }, 'fork-current'));
    const transcript = await f.runtime.transcript(child.id);
    expect(transcript).toContain('CURRENT_CONTEXT_MARKER'); expect(transcript).not.toContain('OLD_CONTEXT_MARKER');
    expect(transcript).not.toContain('Old private history');
  } finally { await f.cleanup(); }
});

test('nested project definitions record their own project trust dependency', async () => {
  const f = await fixture();
  try {
    f.respond(hold, hold);
    const owner = await f.spawn({ projectTrusted: false });
    const definition = { ...BUILTIN_AGENTS[0], name: 'project-agent', source: join(f.cwd, '.pi', 'agents', 'project-agent.md') };
    const result = text(await nestedOperation(f.runtime, await f.runtime.saved(owner.id), [definition], { action: 'spawn', agent: definition.name, task: 'Project task' }, 'project'));
    expect((await f.runtime.saved(result.id)).projectTrusted).toBe(true);
  } finally { await f.cleanup(); }
});

test('nested children reuse the delegating worktree instead of creating another checkout', async () => {
  const f = await fixture(true);
  try {
    await git(f.cwd, ['init', '--initial-branch=main']);
    await writeFile(join(f.cwd, 'evidence'), 'Committed evidence');
    await git(f.cwd, ['add', 'evidence']);
    await git(f.cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Add evidence']);
    f.respond(...Array.from({ length: 8 }, () => hold));
    const owner = await f.spawn({ definition: BUILTIN_AGENTS[2], tools: [...BUILTIN_AGENTS[2].tools], isolation: 'worktree', projectTrusted: true });
    const before = await git(f.cwd, ['worktree', 'list', '--porcelain']);
    const child = text(await f.runtime.delegate(owner.id, { action: 'spawn', agent: 'Explore', task: 'Inspect the same checkout' }, 'same-checkout'));
    expect(child.cwd).toBe(owner.cwd);
    expect((await f.runtime.saved(child.id)).worktree).toEqual((await f.runtime.saved(owner.id)).worktree);
    expect(await git(f.cwd, ['worktree', 'list', '--porcelain'])).toBe(before);
    await f.runtime.close(owner.id);
    expect((await f.runtime.get(child.id)).status).toBe('cancelled');
    expect(await git(f.cwd, ['worktree', 'list', '--porcelain'])).toBe(before);
  } finally { await f.cleanup(); }
});

test('saved worker conversations retain their old edit-only policy after the built-ins change', async () => {
  const f = await fixture(true);
  try {
    const definition = { ...BUILTIN_AGENTS[2], name: 'worker', permissions: 'edit' as const, tools: ['read', 'edit', 'write'] };
    f.respond(answer('Original work'));
    const original = await f.spawn({ definition, tools: [...definition.tools] });
    await f.runtime.wait(original.id, 3000);
    const policy = (await f.runtime.saved(original.id)).policy;
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    expect((await f.runtime.saved(original.id)).policy).toEqual(policy);
    f.respond(answer('Continued old conversation'));
    await f.runtime.send(original.id, 'Continue', 'legacy-follow-up', 'legacy-follow-up');
    const resumed = await f.runtime.wait(original.id, 3000);
    expect(resumed.agent).toBe('worker');
    expect(resumed.tools).toEqual(['read', 'edit', 'write']);
    expect(resumed.output).toBe('Continued old conversation');
  } finally { await f.cleanup(); }
});
