import { describe, expect, test } from 'vitest';
import { Type } from 'typebox';
import type { Message } from '@earendil-works/pi-ai';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

const history: Message[] = [
  { role: 'system', content: 'PARENT_SYSTEM_MUST_NOT_GRANT_TOOLS', timestamp: 1,
    toolsAdded: [{ name: 'parent_only', description: 'Parent capability', parameters: Type.Object({}) }] },
  { role: 'user', content: 'Remember this parent decision', timestamp: 2 },
  answer('The parent already checked the baseline'),
  answer(fauxToolCall('parent_only', { task: 'pending parent operation' }, { id: 'pending-parent' }), { stopReason: 'toolUse' }),
];

describe('parent conversation forks and child compaction', () => {
  test('copies model-visible history without granting parent tools or replaying a pending call', async () => {
    const f = await fixture(true);
    try {
      let captured: any;
      f.respond(context => { captured = context; return answer('Forked result'); });
      const run = await f.spawn({ context: 'fork', history, forkParentLeaf: 'parent-leaf' });
      expect((await f.runtime.wait(run.id, 3000)).status).toBe('completed');
      const serialized = JSON.stringify(captured);
      expect(serialized).toContain('Remember this parent decision');
      expect(serialized).toContain('The parent already checked the baseline');
      expect(serialized).toContain('had no saved result at the fork point');
      expect(serialized).not.toContain('PARENT_SYSTEM_MUST_NOT_GRANT_TOOLS');
      const fork = await f.runtime.saved(run.id);
      expect(fork.context).toBe('fork'); expect(fork.forkParentLeaf).toBe('parent-leaf');
      const messages = captured.messages as any[];
      expect(messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'pending-parent')).toHaveLength(1);
      expect(messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? []).some(tool => tool.name === 'parent_only')).toBe(false);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.saved(run.id)).forkParentLeaf).toBe('parent-leaf');
      expect(f.faux.state.callCount).toBe(1);
    } finally { await f.cleanup(); }
  });
  test('fresh context ignores the parent history and forked context still enforces read-only tools', async () => {
    const f = await fixture();
    try {
      let fresh = '';
      f.respond(context => { fresh = JSON.stringify(context); return answer('Fresh'); },
        answer(fauxToolCall('bash', { command: 'echo forbidden' }), { stopReason: 'toolUse' }), answer('Forbidden tool denied'));
      const a = await f.spawn({ history }); await f.runtime.wait(a.id, 3000);
      expect(fresh).not.toContain('Remember this parent decision');
      const b = await f.spawn({ context: 'fork', history }, 'forked'); await f.runtime.wait(b.id, 3000);
      expect(await f.runtime.transcript(b.id)).toContain('tool_unavailable');
      expect((await f.runtime.get(b.id)).tools).not.toContain('bash');
    } finally { await f.cleanup(); }
  });
  test('automatically compacts large forked context and retains the original transcript', async () => {
    const f = await fixture(true);
    try {
      const large: Message[] = Array.from({ length: 65 }, (_, index) => ({ role: 'user' as const,
        content: `Parent message ${index}: ` + 'saved context '.repeat(1000), timestamp: index }));
      let summarized = false, usedSummary = false;
      f.respond(context => { summarized = JSON.stringify(context).toLowerCase().includes('summar'); return answer('Compacted parent decisions'); },
        context => { usedSummary = JSON.stringify(context).includes('Compacted parent decisions'); return answer('Finished with compacted history'); });
      const run = await f.spawn({ context: 'fork', history: large });
      const result = await f.runtime.wait(run.id, 5000);
      expect(result.status).toBe('completed'); expect(result.output).toBe('Finished with compacted history');
      expect(summarized).toBe(true); expect(usedSummary).toBe(true);
      const entries = await f.runtime.entries(run.id);
      expect(entries.some(entry => entry.kind === 'pi.compaction')).toBe(true);
      expect(entries.filter(entry => entry.kind === 'pi-subagents.fork')).toHaveLength(65);
      expect(result.turns).toBe(2);
      const active = await f.runtime.modelHistory(run.id);
      expect(JSON.stringify(active)).toContain('Compacted parent decisions');
      expect(JSON.stringify(active)).not.toContain('Parent message 0:');
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.get(run.id)).output).toBe('Finished with compacted history');
      expect(f.faux.state.callCount).toBe(2);
    } finally { await f.cleanup(); }
  });
});
