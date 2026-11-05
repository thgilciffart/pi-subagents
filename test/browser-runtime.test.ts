import { expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Message } from '@earendil-works/pi-ai';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

test('browser details include completed tools during a running request and exclude imported fork calls', async () => {
  const f = await fixture();
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  try {
    const path = join(f.cwd, 'evidence'); await writeFile(path, 'Evidence');
    const history: Message[] = [
      answer(fauxToolCall('read', { path }, { id: 'parent-read' }), { stopReason: 'toolUse' }),
      { role: 'toolResult', toolCallId: 'parent-read', toolName: 'read', content: [{ type: 'text', text: 'Imported parent evidence' }], isError: false, timestamp: 1 },
    ];
    f.respond(answer(fauxToolCall('read', { path }, { id: 'child-read' }), { stopReason: 'toolUse' }),
      async (_context, options) => {
        started();
        await new Promise<void>(resolve => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return answer('', { stopReason: 'aborted' });
      });
    const child = await f.spawn({ context: 'fork', history });
    await begun;
    expect((await f.runtime.indicatorRuns())[0].activity).toBe('thinking');
    expect((await f.runtime.list())[0].toolCalls).toBe(0);
    const before = JSON.stringify(await f.runtime.state());
    const details = (await f.runtime.browserRuns())[0];
    expect(details.id).toBe(child.id); expect(details.status).toBe('running');
    expect(details.toolCalls).toBe(1);
    expect(JSON.stringify(await f.runtime.state())).toBe(before);
    expect(f.faux.state.callCount).toBe(2);
  } finally { await f.cleanup(); }
});

test('browser refresh reuses unchanged transcript summaries', async () => {
  const f = await fixture();
  try {
    f.respond(answer('Finished'));
    const run = await f.spawn(); await f.runtime.wait(run.id, 3000);
    const entries = vi.spyOn(f.runtime, 'entries');
    await f.runtime.browserRuns(); await f.runtime.browserRuns(); await f.runtime.browserRuns();
    expect(entries).toHaveBeenCalledTimes(1);
    f.respond(answer('Follow-up'));
    await f.runtime.send(run.id, 'Next task', 'next', 'next'); await f.runtime.wait(run.id, 3000);
    entries.mockClear();
    expect((await f.runtime.browserRuns())[0].run).toBe(2);
    expect(entries).toHaveBeenCalledTimes(1);
  } finally { await f.cleanup(); }
});
