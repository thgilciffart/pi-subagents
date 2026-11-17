import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile, rename } from 'node:fs/promises';
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
      expect(path).toBe(join(agentDir, 'sessions', 'parent.subagents', 'children.sqlite'));
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
    await expect(openStore(agentDir, join(agentDir, 'parent.jsonl'), 'parent', cwd)).rejects.toThrow('outside the Git repository');
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

test('runtime storage is rejected inside a different repository from the parent project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-other-repo-'));
  try {
    const cwd = join(dir, 'project'), dotfiles = join(dir, 'dotfiles');
    await mkdir(cwd); await mkdir(join(dotfiles, '.git'), { recursive: true });
    await expect(openStore(join(dir, 'agent'), join(dotfiles, 'parent.jsonl'), 'parent', cwd)).rejects.toThrow('outside the Git repository');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy data moves beside its parent and retains ownership protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-migration-'));
  const agentDir = join(dir, 'agent'), parentFile = join(dir, 'parent.jsonl');
  const legacyRoot = join(agentDir, 'subagents', 'sessions');
  const key = createHash('sha256').update(`parent\0${parentFile}`).digest('hex');
  const legacyDir = join(legacyRoot, key);
  try {
    const initial = await openStore(agentDir, parentFile, 'parent', dir);
    await initial.storage.close(BACKGROUND_CONTEXT); initial.release();
    await mkdir(legacyRoot, { recursive: true });
    await rename(join(dir, 'parent.subagents'), legacyDir);
    await writeFile(join(legacyDir, 'evidence'), 'retained');
    const { DatabaseSync } = await import('node:sqlite');
    const lock = new DatabaseSync(join(legacyDir, 'owner.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    try { await expect(openStore(agentDir, parentFile, 'parent', dir)).rejects.toThrow('Another Pi process'); }
    finally { lock.close(); }
    const migrated = await openStore(agentDir, parentFile, 'parent', dir);
    try {
      expect(migrated.path).toBe(initial.path);
      await expect(stat(join(dir, 'parent.subagents', 'evidence'))).resolves.toBeDefined();
      await expect(stat(join(agentDir, 'subagents'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(openStore(agentDir, parentFile, 'parent', dir)).rejects.toThrow('Another Pi process');
    } finally { await migrated.storage.close(BACKGROUND_CONTEXT); migrated.release(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
