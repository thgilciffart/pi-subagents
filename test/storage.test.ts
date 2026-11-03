import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openStore } from '../src/storage.ts';

test('starting in a home directory keeps its normal Pi storage and ownership lock', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-subagents-home-'));
  const agentDir = join(home, '.pi', 'agent');
  const parentFile = join(agentDir, 'sessions', 'parent.jsonl');
  try {
    const first = await openStore(agentDir, parentFile, 'parent', home);
    let path: string | undefined;
    try {
      path = first.path;
      expect(path).toContain(join(agentDir, 'subagents', 'sessions'));
      await expect(openStore(agentDir, parentFile, 'parent', home)).rejects.toThrow('Another Pi process');
    } finally { await first.storage.close(BACKGROUND_CONTEXT); first.release(); }
    const reopened = await openStore(agentDir, parentFile, 'parent', home);
    try { expect(reopened.path).toBe(path); }
    finally { await reopened.storage.close(BACKGROUND_CONTEXT); reopened.release(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test.each(['directory', 'file', 'symlink'])('rejects storage inside a checkout with a %s Git marker or path', async kind => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-storage-'));
  const project = join(dir, 'project'), cwd = join(project, 'nested');
  await mkdir(cwd, { recursive: true });
  if (kind === 'file') await writeFile(join(project, '.git'), 'gitdir: /unused/worktree-metadata\n');
  else await mkdir(join(project, '.git'));
  const agentDir = kind === 'symlink' ? join(dir, 'agent-alias') : join(project, '.pi', 'agent');
  if (kind === 'symlink') await symlink(project, agentDir, 'dir');
  try {
    await expect(openStore(agentDir, join(dir, 'parent.jsonl'), 'parent', cwd)).rejects.toThrow('outside the Git repository');
    await expect(stat(join(agentDir, 'subagents'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ephemeral parents create no runtime files even inside a checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-ephemeral-'));
  await mkdir(join(dir, '.git'));
  const agentDir = join(dir, '.pi', 'agent');
  try {
    const store = await openStore(agentDir, undefined, 'ephemeral', dir);
    try {
      expect(store.path).toBeUndefined();
      await expect(stat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await store.storage.close(BACKGROUND_CONTEXT); store.release(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
