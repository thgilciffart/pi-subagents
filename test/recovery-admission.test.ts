import { expect, test } from 'vitest';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { Children } from '../src/runtime.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';

async function interrupted() {
  const f = await fixture(true);
  let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  f.respond(async (_context, options) => {
    started();
    await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return answer('', { stopReason: 'aborted' });
  });
  const run = await f.spawn(); await begun; await f.runtime.dispose();
  return { f, run };
}

test('temporary recovery restrictions preserve the checkpoint through reload and resume the same task', async () => {
  const { f, run } = await interrupted();
  try {
    f.allow(() => { throw new Error('Project trust is required for now'); }); await f.open();
    const before = await f.runtime.saved(run.id);
    await f.runtime.resume();
    expect((await f.runtime.get(run.id)).status).toBe('running');
    expect((await f.runtime.get(run.id)).recoveryError).toContain('Project trust');
    f.respond(answer('Independent sibling'));
    const other = await f.spawn({}, 'other').catch(() => undefined);
    expect(other).toBeUndefined(); // Environment admission still applies to new children.
    expect(f.faux.state.callCount).toBe(1);
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    expect(f.faux.state.callCount).toBe(1);
    f.allow(() => {}); f.respond(answer('Continued saved conversation'));
    await f.runtime.resume(run.id, true);
    expect((await f.runtime.wait(run.id, 3000)).output).toBe('Continued saved conversation');
    const after = await f.runtime.saved(run.id);
    expect(after.id).toBe(before.id); expect(after.runs).toHaveLength(1); expect(after.policy).toEqual(before.policy);
    expect(after.recovery).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('starting a permitted sibling cannot run a parked child and cancellation remains final', async () => {
  const { f, run } = await interrupted();
  try {
    f.allow(child => { if ((child as { id: number }).id === Number(run.id)) throw new Error('Temporarily unavailable'); });
    await f.open(); await f.runtime.resume();
    f.respond(answer('Sibling finished'));
    const sibling = await f.spawn({}, 'sibling'); await f.runtime.wait(sibling.id, 3000);
    expect(f.faux.state.callCount).toBe(2);
    await f.runtime.stop(run.id); f.allow(() => {});
    await f.runtime.dispose(); await f.open(); await f.runtime.resume(run.id, true);
    expect((await f.runtime.get(run.id)).status).toBe('cancelled'); expect(f.faux.state.callCount).toBe(2);
  } finally { await f.cleanup(); }
});

test('resuming one child leaves recovered siblings parked until selected', async () => {
  const { f, run } = await interrupted();
  try {
    await f.open();
    let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
    f.respond(async (_context, options) => {
      started(); await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return answer('', { stopReason: 'aborted' });
    });
    const sibling = await f.spawn({}, 'sibling'); await begun;
    await f.runtime.dispose(); await f.open();
    f.respond(answer('Selected child resumed'));
    await f.runtime.resume(run.id, true); await f.runtime.wait(run.id, 3000);
    expect((await f.runtime.saved(sibling.id)).recovery).toBeDefined();
    expect((await f.runtime.get(sibling.id)).status).toBe('running');
    expect(f.faux.state.callCount).toBe(3);
  } finally { await f.cleanup(); }
});

test('recovery cannot rewrite a currently executing task checkpoint', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    let start!: () => void; const begun = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.respond(async () => { start(); await gate; return answer('Live work finished'); });
    const run = await f.spawn(); await begun;
    f.allow(() => { throw new Error('Temporary restriction'); });
    await expect(f.runtime.resume(run.id)).rejects.toThrow('live work');
    expect((await f.runtime.saved(run.id)).recovery).toBeUndefined();
    f.allow(() => {}); release();
    expect((await f.runtime.wait(run.id, 3000)).output).toBe('Live work finished');
  } finally { release?.(); await f.cleanup(); }
});

test('a task whose deadline expired while Pi was closed fails without another model request', async () => {
  const { f, run } = await interrupted();
  try {
    await f.open();
    await f.runtime.harness.commit(async tx => {
      const child = (await tx.doc(Children)).children[run.id]; child.runs[0].startedAt = Date.now() - 3600001;
    }, C);
    await f.runtime.resume();
    expect((await f.runtime.get(run.id)).status).toBe('failed');
    expect((await f.runtime.get(run.id)).error).toContain('deadline'); expect(f.faux.state.callCount).toBe(1);
  } finally { await f.cleanup(); }
});

test('deferred polling checks current admission before contacting the provider', async () => {
  const f = await fixture();
  const faux = fauxProvider({ tokensPerSecond: Infinity, deferred: { pollAfterMs: 300 } });
  f.models.registerNativeProvider(faux.provider);
  const original = f.models.streamSimple.bind(f.models);
  f.models.streamSimple = (model, context, options) => original(model, context, { ...options, deferred: true });
  try {
    faux.setResponses([answer('Deferred result')]);
    const run = await f.spawn();
    await expect.poll(async () => (await f.runtime.harness.inspect(C)).tasks.some(task => {
      const state = task.record.state;
      return state.status !== 'terminal' && state.status !== 'completing' && (state.checkpoint as { phase?: string })?.phase === 'poll';
    })).toBe(true);
    f.allow(() => { throw new Error('Scope temporarily unavailable'); });
    await expect.poll(() => f.errors.some(error => String(error).includes('Scope temporarily unavailable'))).toBe(true);
    expect(faux.state.deferredFetchCount).toBe(0);
  } finally { await f.cleanup(); }
});
