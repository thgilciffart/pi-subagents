import { describe, expect, test } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { PERMISSION_TOOLS } from '../src/agents.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

const call = (name: string, args: JsonObject, id: string) => answer(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });

describe('real Durable runtime with a local Pi model', () => {
  test('fresh children run in parallel with only their allowed tools and no ambient extensions', async () => {
    const f = await fixture();
    try {
      const contexts: any[] = [];
      f.respond(context => { contexts.push(context); return answer('One'); }, context => { contexts.push(context); return answer('Two'); });
      await writeFile(join(f.cwd, 'AGENTS.md'), 'DO_NOT_LOAD_AMBIENT');
      const [a, b] = await Promise.all([f.spawn({ task: 'FIRST' }, 'first'), f.spawn({ task: 'SECOND', tools: [] }, 'second')]);
      const runs = await Promise.all([f.runtime.wait(a.id, 3000), f.runtime.wait(b.id, 3000)]);
      expect(runs.map(run => run.status)).toEqual(['completed', 'completed']);
      expect(JSON.stringify(contexts[0])).toContain('FIRST');
      expect(JSON.stringify(contexts[0])).not.toContain('SECOND');
      expect(JSON.stringify(contexts)).not.toContain('DO_NOT_LOAD_AMBIENT');
      expect((await (await f.runtime.harness.conversation((await f.runtime.saved(a.id)).id, C))!.agent(C)).tools.map(t => t.name).sort()).toEqual([...PERMISSION_TOOLS['read-only']].sort());
      expect(JSON.stringify(contexts[1])).not.toContain('"name":"bash"');
      expect((await readdir(f.agentDir)).filter(name => name !== 'auth.json')).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });
  test('denies writes and shell calls even when the model asks for them', async () => {
    const f = await fixture();
    try {
      const path = join(f.cwd, 'forbidden');
      f.respond(call('write', { path, content: 'bad' }, 'bad-write'), call('bash', { command: `touch ${path}` }, 'bad-shell'), answer('Denied'));
      const run = await f.spawn();
      expect((await f.runtime.wait(run.id, 3000)).status).toBe('completed');
      await expect(readFile(path)).rejects.toThrow();
      expect(await f.runtime.transcript(run.id)).toContain('tool_unavailable');
      await expect(f.spawn({ tools: ['bash'] }, 'escalate')).rejects.toThrow('permissions');
    } finally { await f.cleanup(); }
  });
  test('follow-up uses the same conversation and a new task receipt', async () => {
    const f = await fixture();
    try {
      let history = '';
      f.respond(answer('First result'), context => { history = JSON.stringify(context); return answer('Second result'); });
      const run = await f.spawn(); await f.runtime.wait(run.id, 3000);
      const next = await f.runtime.send(run.id, 'Follow-up', 'send-1', 'send-1');
      expect(next.id).toBe(run.id); expect(next.run).toBe(2); expect(next.receipt).not.toBe(run.receipt);
      expect((await f.runtime.wait(run.id, 3000)).output).toBe('Second result');
      expect(history).toContain('First result');
      expect(history).toContain('Follow-up');
      expect((await f.runtime.pending()).map(run => run.run)).toEqual([1, 2]);
    } finally { await f.cleanup(); }
  });
  test('request IDs prevent duplicate children and duplicate follow-up tasks', async () => {
    const f = await fixture(true);
    try {
      f.respond(answer('Done'), answer('Follow-up done'));
      const [a, b] = await Promise.all([f.spawn({}, 'same'), f.spawn({}, 'same')]);
      expect(a.id).toBe(b.id); expect(await f.runtime.list()).toHaveLength(1);
      await f.runtime.wait(a.id, 3000);
      await f.runtime.send(a.id, 'next', 'send', 'send');
      await f.runtime.send(a.id, 'next', 'send', 'send');
      await f.runtime.wait(a.id, 3000);
      expect((await f.runtime.saved(a.id)).runs).toHaveLength(2);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.spawn({}, 'same')).run).toBe(1);
      expect((await f.runtime.saved(a.id)).runs).toHaveLength(2);
      expect(f.faux.state.callCount).toBe(2);
      await expect(f.runtime.request('same', 'different')).rejects.toThrow('different');
    } finally { await f.cleanup(); }
  });
  test('completed, cancelled, and closed tasks stay terminal on reopen and resume', async () => {
    const f = await fixture(true);
    try {
      f.respond(answer('Done'), answer('Done too'));
      const done = await f.spawn(); await f.runtime.wait(done.id, 3000);
      const cancelled = await f.spawn({}, 'cancel'); await f.runtime.stop(cancelled.id);
      await f.runtime.close(done.id);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.get(cancelled.id)).status).toBe('cancelled');
      expect((await f.runtime.saved(done.id)).closed).toBe(true);
      const count = f.faux.state.callCount;
      await f.runtime.resume(cancelled.id); await f.runtime.resume(done.id);
      expect(f.faux.state.callCount).toBe(count);
    } finally { await f.cleanup(); }
  });
  test('enforces model request and concurrency limits', async () => {
    const f = await fixture();
    try {
      f.respond(call('ls', {}, 'list'), answer('Should not run'));
      const run = await f.spawn({ settings: { ...f.options().settings, maxTurns: 1 } });
      expect((await f.runtime.wait(run.id, 3000)).status).toBe('failed');
      expect(f.faux.state.callCount).toBe(1);
      expect((await f.runtime.get(run.id)).turns).toBe(1);
    } finally { await f.cleanup(); }
  });
});

test('configured provider authentication stays in the shared runtime', async () => {
  const f = await fixture(true);
  try {
    const key = 'fixture-credential-never-copy-to-task';
    const provider = f.faux.provider;
    f.models.registerNativeProvider({ ...provider, auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: key } }) } } });
    let actualKey: string | undefined;
    f.respond((_context, options) => { actualKey = options?.apiKey; return answer('Authenticated locally'); });
    const run = await f.spawn();
    expect((await f.runtime.wait(run.id, 3000)).status).toBe('completed');
    expect(actualKey).toBe(key);
    expect(JSON.stringify(await f.runtime.state())).not.toContain(key);
    expect(await f.runtime.transcript(run.id)).not.toContain(key);
  } finally { await f.cleanup(); }
});

test('stateful virtual models route through Pi and keep their router state across reopen', async () => {
  const f = await fixture(true);
  try {
    const states: unknown[] = [];
    f.models.registerVirtualModel({ provider: 'fixture-router', id: 'choose', name: 'Choose fixture',
      route: request => { states.push(request.state); return { model: f.faux.models[0], thinkingLevel: 'off', state: { turns: ((request.state as any)?.turns ?? 0) + 1 } }; } });
    f.respond(answer('First'), answer('Second'));
    const run = await f.spawn({ model: 'fixture-router/choose' });
    expect((await f.runtime.wait(run.id, 3000)).status).toBe('completed');
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    await f.runtime.send(run.id, 'Next task', 'next-task', 'next-task');
    expect((await f.runtime.wait(run.id, 3000)).status).toBe('completed');
    expect(states).toEqual([undefined, { turns: 1 }]);
    expect((await f.runtime.saved(run.id)).routing?.state).toEqual({ turns: 2 });
    expect((await f.runtime.get(run.id)).model).toBe('fixture-router/choose');
  } finally { await f.cleanup(); }
});

test('a receipt from another parent cannot acknowledge this parent result', async () => {
  const first = await fixture(); const second = await fixture(false, 'other-parent');
  try {
    first.respond(answer('First parent')); second.respond(answer('Second parent'));
    const a = await first.spawn(); const b = await second.spawn();
    await first.runtime.wait(a.id, 3000); await second.runtime.wait(b.id, 3000);
    expect(a.id).toBe(b.id); expect(a.receipt).not.toBe(b.receipt);
    await second.runtime.acknowledge([a.receipt]);
    expect(await second.runtime.pending()).toHaveLength(1);
  } finally { await first.cleanup(); await second.cleanup(); }
});

test('bounded waits and concurrency do not cancel existing work', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.respond(async () => { await gate; return answer('Finished after wait'); });
    const settings = { ...f.options().settings, maxConcurrent: 1 };
    const run = await f.spawn({ settings });
    expect((await f.runtime.wait(run.id, 1)).status).toBe('running');
    await expect(f.spawn({ settings }, 'over-capacity')).rejects.toThrow('At most 1');
    release();
    expect((await f.runtime.wait(run.id, 3000)).output).toBe('Finished after wait');
    expect(f.faux.state.callCount).toBe(1);
  } finally { release?.(); await f.cleanup(); }
});

test('tool execution rechecks permissions after a model response', async () => {
  const f = await fixture();
  try {
    const path = join(f.cwd, 'must-not-write');
    const worker = { ...f.options().definition, permissions: 'edit' as const, tools: [...PERMISSION_TOOLS.edit] };
    f.respond(() => {
      f.allow(() => { throw new Error('Project trust was revoked'); });
      return call('write', { path, content: 'Denied' }, 'late-write');
    });
    const run = await f.spawn({ definition: worker, tools: worker.tools });
    expect((await f.runtime.wait(run.id, 3000)).status).toBe('failed');
    await expect(readFile(path)).rejects.toThrow();
    expect(f.faux.state.callCount).toBe(1);
  } finally { await f.cleanup(); }
});
