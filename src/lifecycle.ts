export type LifecycleEvent = 'start' | 'resume' | 'stop' | 'close';

export type LifecycleRecord = {
  status: 'started' | 'done' | 'failed' | 'interrupted';
  error?: string;
};

export type LifecycleStore = {
  read(key: string): Promise<LifecycleRecord | undefined>;
  write(key: string, value: LifecycleRecord): Promise<void>;
};

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function runLifecycleHook(
  store: LifecycleStore,
  key: string,
  replay: 'safe' | 'unsafe',
  callback: () => Promise<void>,
): Promise<void> {
  const saved = await store.read(key);
  if (saved?.status === 'done') return;
  if (saved?.status === 'failed' || saved?.status === 'interrupted') {
    throw new Error(saved.error || `Lifecycle hook ${key} ${saved.status}.`);
  }
  if (saved?.status === 'started') {
    if (replay !== 'safe') {
      const message = saved.error || `Lifecycle hook ${key} was interrupted. Inspect its effects before continuing.`;
      await store.write(key, { status: 'interrupted', error: message });
      throw new Error(message);
    }
  } else {
    await store.write(key, { status: 'started' });
  }
  try {
    await callback();
  } catch (error) {
    await store.write(key, { status: 'failed', error: reason(error) });
    throw error;
  }
  await store.write(key, { status: 'done' });
}
