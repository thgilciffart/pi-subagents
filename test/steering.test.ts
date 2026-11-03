import { describe, expect, test } from 'vitest';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

describe('active child steering', () => {
  test.each(['tool boundary', 'answer boundary'])('joins the same task at a %s and delivers its final answer once', async boundary => {
    const f = await fixture(true);
    let release!: () => void;
    try {
      let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let revisedContext = '';
      f.respond(async () => { started(); await gate; return boundary === 'tool boundary' ?
        answer(fauxToolCall('ls', {}), { stopReason: 'toolUse' }) : answer('Initial answer before steering'); },
      context => { revisedContext = JSON.stringify(context); return answer('Revised answer'); });
      const run = await f.spawn(); await begun;
      const steered = await f.runtime.steer(run.id, 'Focus on cancellation races', 'direction', 'direction');
      const duplicate = await f.runtime.steer(run.id, 'Focus on cancellation races', 'direction', 'direction');
      expect(steered.run).toBe(1); expect(steered.receipt).toBe(run.receipt);
      expect(duplicate.steering).toHaveLength(1); expect(duplicate.tools).toEqual(run.tools);
      expect(duplicate.startedAt).toBe(run.startedAt);
      release();
      const result = await f.runtime.wait(run.id, 3000);
      expect(result.output).toBe('Revised answer'); expect(result.status).toBe('completed');
      expect(revisedContext).toContain('Focus on cancellation races');
      expect(await f.runtime.pending()).toHaveLength(1);
      expect(f.faux.state.callCount).toBe(2);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.steer(run.id, 'Focus on cancellation races', 'direction', 'direction')).steering).toHaveLength(1);
      expect(f.faux.state.callCount).toBe(2);
      await expect(f.runtime.steer(run.id, 'New direction', 'late', 'late')).rejects.toThrow();
    } finally { release?.(); await f.cleanup(); }
  });
  test('queued steering survives reload without another child or result receipt', async () => {
    const f = await fixture(true);
    try {
      let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
      f.respond(async (_context, options) => {
        started(); await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return answer('', { stopReason: 'aborted' });
      });
      const run = await f.spawn(); await begun;
      await f.runtime.steer(run.id, 'Retain this direction after reload', 'direction', 'direction');
      await f.runtime.dispose(); await f.open();
      const contexts: unknown[] = [];
      f.respond(context => { contexts.push(context); return answer('Initial recovery answer'); }, context => { contexts.push(context); return answer('Recovered direction'); });
      await f.runtime.resume();
      const result = await f.runtime.wait(run.id, 3000);
      expect(result.status).toBe('completed'); expect(result.receipt).toBe(run.receipt);
      expect(JSON.stringify(contexts)).toContain('Retain this direction after reload');
      expect(await f.runtime.list()).toHaveLength(1); expect(await f.runtime.pending()).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
  test('cancellation withdraws queued steering and remains final after reopen', async () => {
    const f = await fixture(true);
    try {
      let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
      f.respond(async (_context, options) => {
        started(); await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return answer('', { stopReason: 'aborted' });
      });
      const run = await f.spawn(); await begun;
      await f.runtime.steer(run.id, 'Must not restart after cancellation', 'direction', 'direction');
      await f.runtime.stop(run.id); await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.get(run.id)).status).toBe('cancelled'); expect(f.faux.state.callCount).toBe(1);
      expect(await f.runtime.pending()).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
});
