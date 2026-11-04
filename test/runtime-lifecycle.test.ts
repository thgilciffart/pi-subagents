import { expect, test } from 'vitest';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { ParentCapabilities, registerChildHook, type ChildHook, type McpBridge } from '../src/capabilities.ts';
import { Children } from '../src/runtime.ts';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';
const noMcp: McpBridge = { catalog: async () => [], validate: async () => {}, call: async () => { throw new Error('No MCP'); }, close: async () => {} };
async function setup(hook: Partial<ChildHook> = {}) {
  const events = createEventBus(); let capabilities!: ParentCapabilities;
  registerChildHook({ events }, { name: 'lifecycle', version: '1', permissions: 'read-only', project: false, replay: 'safe', ...hook });
  const f = await fixture(true, 'parent', paths => capabilities = new ParentCapabilities({ events, getCommands: () => [] },
    () => ({ cwd: paths.cwd, isProjectTrusted: () => true }) as any, noMcp));
  return { f, select: () => capabilities.select({}, 'read-only') };
}
test('inherited lifecycle hooks run for each task and closure without duplicate terminal callbacks', async () => {
  const events: string[] = [];
  const { f, select } = await setup({ onStart: context => { events.push(`start:${context.run}:${context.cwd}`); },
    onStop: context => { events.push(`stop:${context.run}:${context.status}:${context.output}`); }, onClose: () => { events.push('close'); } });
  try {
    f.respond(answer('One'), answer('Two'));
    const run = await f.spawn({ capabilities: await select() }); await f.runtime.wait(run.id, 3000); await f.runtime.refresh();
    await f.runtime.send(run.id, 'Next', 'next', 'next'); await f.runtime.wait(run.id, 3000); await f.runtime.refresh();
    await f.runtime.close(run.id); await f.runtime.close(run.id);
    expect(events).toEqual([`start:1:${f.cwd}`, 'stop:1:completed:One', `start:2:${f.cwd}`, 'stop:2:completed:Two', 'close']);
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    expect(events).toHaveLength(5); expect(f.faux.state.callCount).toBe(2);
  } finally { await f.cleanup(); }
});
test('restart recovery runs resume once per restart and preserves the saved conversation', async () => {
  const events: string[] = [];
  const { f, select } = await setup({ onStart: () => { events.push('start'); }, onResume: () => { events.push('resume'); }, onStop: context => { events.push(context.status); } });
  try {
    let begun!: () => void; const started = new Promise<void>(resolve => { begun = resolve; });
    f.respond(async (_context, options) => { begun(); await new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true })); return answer('', { stopReason: 'aborted' }); });
    const run = await f.spawn({ capabilities: await select() }); await started; await f.runtime.dispose(); await f.open();
    f.respond(answer('Recovered'));
    await f.runtime.resume(); await f.runtime.resume(); await f.runtime.wait(run.id, 3000); await f.runtime.refresh();
    expect(events).toEqual(['start', 'resume', 'completed']);
    expect((await f.runtime.get(run.id)).output).toBe('Recovered');
  } finally { await f.cleanup(); }
});
test('start failures block model dispatch and stop-hook failures retain the result', async () => {
  const blocked = await setup({ onStart: () => { throw new Error('Start denied'); } });
  try {
    await expect(blocked.f.spawn({ capabilities: await blocked.select() })).rejects.toThrow('Start denied');
    expect(blocked.f.faux.state.callCount).toBe(0);
    expect((await blocked.f.runtime.list())[0].status).toBe('failed');
  } finally { await blocked.f.cleanup(); }
  const stopped = await setup({ onStop: () => { throw new Error('Audit failed'); } });
  try {
    stopped.f.respond(answer('Keep this result'));
    const run = await stopped.f.spawn({ capabilities: await stopped.select() }); await stopped.f.runtime.wait(run.id, 3000); await stopped.f.runtime.refresh();
    const final = await stopped.f.runtime.get(run.id);
    expect(final.status).toBe('completed'); expect(final.output).toBe('Keep this result');
    expect(final.lifecycleErrors?.join('')).toContain('Audit failed');
  } finally { await stopped.f.cleanup(); }
});
test('explicit cancellation runs stop once and never resumes the cancelled task', async () => {
  const events: string[] = [];
  const { f, select } = await setup({ onResume: () => { events.push('resume'); }, onStop: context => { events.push(context.status); } });
  try {
    let begun!: () => void; const started = new Promise<void>(resolve => { begun = resolve; });
    f.respond(async (_context, options) => { begun(); await new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true })); return answer('', { stopReason: 'aborted' }); });
    const run = await f.spawn({ capabilities: await select() }); await started;
    await f.runtime.stop(run.id); await f.runtime.stop(run.id);
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    expect(events).toEqual(['cancelled']);
  } finally { await f.cleanup(); }
});

test('a failed terminal hook does not suppress other inherited terminal hooks or repeat its warning', async () => {
  const events = createEventBus(); let capabilities!: ParentCapabilities, successful = 0;
  registerChildHook({ events }, { name: 'failed', version: '1', permissions: 'read-only', project: false, replay: 'safe', onStop: () => { throw new Error('First audit failed'); } });
  registerChildHook({ events }, { name: 'successful', version: '1', permissions: 'read-only', project: false, replay: 'safe', onStop: () => { successful++; } });
  const f = await fixture(true, 'parent', paths => capabilities = new ParentCapabilities({ events, getCommands: () => [] }, () => ({ cwd: paths.cwd, isProjectTrusted: () => true }) as any, noMcp));
  try {
    f.respond(answer('Completed result'));
    const run = await f.spawn({ capabilities: await capabilities.select({}, 'read-only') }); await f.runtime.wait(run.id, 3000); await f.runtime.refresh();
    expect(successful).toBe(1); expect(f.errors).toHaveLength(1);
    await f.runtime.dispose(); await f.open(); await f.runtime.resume(); await f.runtime.refresh();
    expect(successful).toBe(1); expect(f.errors).toHaveLength(1);
    expect((await f.runtime.get(run.id)).output).toBe('Completed result');
  } finally { await f.cleanup(); }
});

test('a recovered safe resume checkpoint invokes the callback only once in the new runtime', async () => {
  let resumes = 0;
  const { f, select } = await setup({ onResume: () => { resumes++; } });
  try {
    let begun!: () => void; const started = new Promise<void>(resolve => { begun = resolve; });
    f.respond(async (_context, options) => { begun(); await new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true })); return answer('', { stopReason: 'aborted' }); });
    const run = await f.spawn({ capabilities: await select() }); await started; await f.runtime.dispose(); await f.open();
    await f.runtime.harness.commit(async tx => {
      const child = (await tx.doc(Children)).children[run.id]; child.lifecycle ??= {};
      child.lifecycle[JSON.stringify([run.run, 'resume', 'previous-process', 'lifecycle'])] = { status: 'started' };
    }, C);
    f.respond(answer('Recovered once')); await f.runtime.resume(); await f.runtime.wait(run.id, 3000);
    expect(resumes).toBe(1);
  } finally { await f.cleanup(); }
});
test('starting another child cannot bypass a recovered sibling resume hook', async () => {
  let begin!: () => void, release!: () => void, resumed = false;
  const begun = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { f, select } = await setup({ onResume: async () => { begin(); await gate; resumed = true; } });
  try {
    let modelStarted!: () => void; const modelBegun = new Promise<void>(resolve => { modelStarted = resolve; });
    f.respond(async (_context, options) => { modelStarted(); await new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true })); return answer('', { stopReason: 'aborted' }); });
    const old = await f.spawn({ task: 'Old recovered task', capabilities: await select() }); await modelBegun; await f.runtime.dispose(); await f.open();
    const response = (context: unknown) => { if (JSON.stringify(context).includes('Old recovered task')) expect(resumed).toBe(true); return answer('Done'); };
    f.respond(response, response);
    const recovering = f.runtime.resume();
    await begun;
    const next = await f.spawn({ task: 'New child', capabilities: await select() }, 'new-child');
    release(); await recovering;
    expect((await f.runtime.wait(old.id, 3000)).status).toBe('completed');
    expect((await f.runtime.wait(next.id, 3000)).status).toBe('completed');
  } finally { release(); await f.cleanup(); }
});
test('cancelling during a start hook aborts it before stop and prevents model dispatch', async () => {
  const events: string[] = []; let begin!: () => void;
  const begun = new Promise<void>(resolve => { begin = resolve; });
  const { f, select } = await setup({ onStart: async context => {
    events.push('start'); begin();
    await new Promise<void>(resolve => context.signal?.addEventListener('abort', () => { events.push('start-aborted'); resolve(); }, { once: true }));
  }, onStop: () => { events.push('stop'); } });
  try {
    const starting = f.spawn({ capabilities: await select() }); const failed = starting.catch(error => error);
    await begun; const id = (await f.runtime.list())[0].id; await f.runtime.stop(id); await failed;
    expect(events).toEqual(['start', 'start-aborted', 'stop']); expect(f.faux.state.callCount).toBe(0);
    expect((await f.runtime.get(id)).status).toBe('cancelled');
  } finally { await f.cleanup(); }
});
