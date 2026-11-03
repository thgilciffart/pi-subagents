import { describe, expect, test } from 'vitest';
import { runLifecycleHook, type LifecycleEvent, type LifecycleRecord, type LifecycleStore } from '../src/lifecycle.ts';

function memoryStore(initial: Record<string, LifecycleRecord> = {}, failOnWrite?: (key: string, value: LifecycleRecord) => Error | undefined) {
  const records = new Map<string, LifecycleRecord>(Object.entries(initial));
  const writes: Array<{ key: string; value: LifecycleRecord }> = [];
  const store: LifecycleStore = {
    async read(key) {
      const value = records.get(key);
      return value ? { ...value } : undefined;
    },
    async write(key, value) {
      const failure = failOnWrite?.(key, value);
      if (failure) throw failure;
      const copy = { ...value };
      records.set(key, copy);
      writes.push({ key, value: copy });
    },
  };
  return { store, records, writes };
}

describe('runLifecycleHook', () => {
  test('persists started before the callback and done after success, then deduplicates completed hooks', async () => {
    const events: LifecycleEvent[] = ['start', 'resume', 'stop', 'close'];
    const { store, records, writes } = memoryStore();
    let seenStatus: LifecycleRecord['status'] | undefined;
    let calls = 0;

    await runLifecycleHook(store, `child:1:${events[0]}`, 'unsafe', async () => {
      calls++;
      seenStatus = records.get('child:1:start')?.status;
    });

    expect(calls).toBe(1);
    expect(seenStatus).toBe('started');
    expect(records.get('child:1:start')).toEqual({ status: 'done' });
    expect(writes).toEqual([
      { key: 'child:1:start', value: { status: 'started' } },
      { key: 'child:1:start', value: { status: 'done' } },
    ]);

    await runLifecycleHook(store, 'child:1:start', 'unsafe', async () => {
      calls++;
    });

    expect(calls).toBe(1);
    expect(writes).toHaveLength(2);
  });

  test('reruns a started hook after a crash when replay is safe', async () => {
    const { store, records, writes } = memoryStore();
    let attempts = 0;

    await expect(async () => {
      await store.write('child:1:resume', { status: 'started' });
      attempts++;
      throw new Error('process crashed mid-callback');
    }).rejects.toThrow('process crashed mid-callback');

    expect(records.get('child:1:resume')).toEqual({ status: 'started' });

    let recoveredCalls = 0;
    await runLifecycleHook(store, 'child:1:resume', 'safe', async () => {
      recoveredCalls++;
      expect(records.get('child:1:resume')).toEqual({ status: 'started' });
    });

    expect(attempts).toBe(1);
    expect(recoveredCalls).toBe(1);
    expect(records.get('child:1:resume')).toEqual({ status: 'done' });
    expect(writes.map(entry => entry.value.status)).toEqual(['started', 'done']);
  });

  test('marks a started unsafe hook as interrupted without rerunning the callback, then rethrows the saved reason', async () => {
    const { store, records, writes } = memoryStore({
      'child:1:stop': { status: 'started' },
    });
    let calls = 0;

    await expect(
      runLifecycleHook(store, 'child:1:stop', 'unsafe', async () => {
        calls++;
      }),
    ).rejects.toThrow(/Inspect its effects/i);

    expect(calls).toBe(0);
    const saved = records.get('child:1:stop');
    expect(saved?.status).toBe('interrupted');
    expect(saved?.error).toMatch(/Inspect its effects/i);
    expect(writes).toHaveLength(1);

    await expect(
      runLifecycleHook(store, 'child:1:stop', 'safe', async () => {
        calls++;
      }),
    ).rejects.toThrow(saved!.error);

    expect(calls).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test('persists failed when the callback throws and rethrows the saved reason on subsequent calls', async () => {
    const { store, records, writes } = memoryStore();
    let calls = 0;

    await expect(
      runLifecycleHook(store, 'child:1:close', 'safe', async () => {
        calls++;
        throw new Error('cleanup hook failed');
      }),
    ).rejects.toThrow('cleanup hook failed');

    expect(calls).toBe(1);
    expect(records.get('child:1:close')).toEqual({
      status: 'failed',
      error: 'cleanup hook failed',
    });
    expect(writes.map(entry => entry.value.status)).toEqual(['started', 'failed']);

    await expect(
      runLifecycleHook(store, 'child:1:close', 'safe', async () => {
        calls++;
      }),
    ).rejects.toThrow('cleanup hook failed');

    expect(calls).toBe(1);
    expect(writes).toHaveLength(2);
  });

  test('leaves started in storage when persisting done fails after the callback succeeds', async () => {
    let rejectDone = true;
    const { store, records, writes } = memoryStore({}, (_key, value) => {
      if (rejectDone && value.status === 'done') return new Error('sqlite commit failed');
      return undefined;
    });
    let calls = 0;

    await expect(
      runLifecycleHook(store, 'child:1:start', 'safe', async () => {
        calls++;
      }),
    ).rejects.toThrow('sqlite commit failed');

    expect(calls).toBe(1);
    expect(records.get('child:1:start')).toEqual({ status: 'started' });
    expect(writes).toEqual([{ key: 'child:1:start', value: { status: 'started' } }]);

    rejectDone = false;
    await runLifecycleHook(store, 'child:1:start', 'safe', async () => {
      calls++;
    });

    expect(calls).toBe(2);
    expect(records.get('child:1:start')).toEqual({ status: 'done' });
  });
});
