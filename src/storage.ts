import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, rename, rmdir } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, resolve, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';

export interface Store { storage: Storage; path?: string; release: () => void; }

export async function canonicalPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(candidate), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(basename(candidate)); candidate = dirname(candidate);
    }
  }
}

/** The operating system releases this exclusive SQLite lock even after SIGKILL. */
export async function openStore(agentDir: string, parentFile: string | undefined, parentId: string, cwd: string): Promise<Store> {
  if (!parentFile) return { storage: new MemoryStorage(), release: () => {} };
  const parentPath = await canonicalPath(parentFile);
  const root = dirname(parentPath);
  const actualRoot = await canonicalPath(root);
  let boundary: string | undefined;
  for (let directory = actualRoot; ; directory = dirname(directory)) {
    try { await stat(join(directory, '.git')); boundary = directory; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (directory === dirname(directory)) break;
  }
  if (boundary) {
    const within = relative(boundary, actualRoot);
    if (within === '' || (within !== '..' && !within.startsWith('../') && !isAbsolute(within))) {
      throw new Error('Parent session directory must be outside the Git repository. Runtime chats cannot be stored in the repository.');
    }
  }
  await mkdir(actualRoot, { recursive: true, mode: 0o700 });
  const dir = join(actualRoot, `${encodeURIComponent(parentId)}.subagents`);
  const key = createHash('sha256').update(`${parentId}\0${parentPath}`).digest('hex');
  const legacyRoot = join(agentDir, 'subagents', 'sessions');
  const legacyDir = join(legacyRoot, key);
  let legacyLock: DatabaseSync | undefined;
  try {
    try { await stat(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (await stat(legacyDir).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        legacyLock = new DatabaseSync(join(legacyDir, 'owner.sqlite'));
        try { legacyLock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); }
        catch (error) { throw new Error('Another Pi process owns this parent session. Close it before recovering its subagents.', { cause: error }); }
        await rename(legacyDir, dir);
        for (const empty of [legacyRoot, dirname(legacyRoot)]) {
          await rmdir(empty).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
        }
      }
    }
  } finally { legacyLock?.close(); }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(dir, 'owner.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    throw new Error('Another Pi process owns this parent session. Close it before recovering its subagents.', { cause: error });
  }
  try {
    const path = join(dir, 'children.sqlite');
    const database = await openNodeSqliteDatabase(path);
    let storage: Storage;
    try { await database.exec('PRAGMA synchronous = FULL'); storage = await SqliteStorage.open(database); } catch (error) { await database.close(); throw error; }
    return { storage, path, release: () => lock.close() };
  } catch (error) { lock.close(); throw error; }
}
