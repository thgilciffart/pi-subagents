import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonicalPath } from './storage.ts';

const exec = promisify(execFile);
export type Worktree = {
  path: string; branch: string; baseCommit: string; sourceRoot: string; commonDir: string;
  relativeCwd: string; ready: boolean;
};

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trimEnd();
}
function within(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !offset || (offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset));
}
export async function planWorktree(cwd: string, root?: string): Promise<Worktree> {
  const sourceRoot = await realpath(await git(cwd, ['rev-parse', '--show-toplevel']));
  const path = await canonicalPath(join(root ?? join(sourceRoot, '.pi', 'subagents', 'worktrees'), randomUUID()));
  const commonDir = await realpath(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const baseCommit = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return { path, branch: `pi-subagents/${randomUUID()}`, baseCommit, sourceRoot, commonDir,
    relativeCwd: relative(sourceRoot, await realpath(cwd)), ready: false };
}

async function registered(worktree: Worktree): Promise<{ branch?: string; locked: boolean } | undefined> {
  const records = (await git(worktree.sourceRoot, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  for (const record of records) {
    const fields = record.split('\0');
    if (fields.find(field => field.startsWith('worktree '))?.slice(9) !== worktree.path) continue;
    return { branch: fields.find(field => field.startsWith('branch '))?.slice(7), locked: fields.some(field => field.startsWith('locked')) };
  }
}
export async function verifyWorktree(worktree: Worktree): Promise<void> {
  const record = await registered(worktree);
  if (!record || record.branch !== `refs/heads/${worktree.branch}` || record.locked) throw new Error('The saved child worktree is missing, incomplete, or on another branch. Repair it before continuing.');
  const actual = await realpath(worktree.path);
  const common = await realpath(await git(worktree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (actual !== worktree.path || common !== worktree.commonDir) throw new Error('The child worktree no longer matches its saved repository.');
  const cwd = await realpath(join(worktree.path, worktree.relativeCwd));
  if (!within(actual, cwd)) throw new Error('The child working directory escapes its worktree.');
}

/** Reattach a completed add, or finish a never-started add using the saved branch and commit. */
export async function ensureWorktree(worktree: Worktree): Promise<void> {
  const record = await registered(worktree);
  if (!record) {
    if (worktree.ready) throw new Error('The saved child worktree is missing. Recovery will not replace it with a fresh checkout.');
    try { await lstat(worktree.path); throw new Error('An unregistered directory occupies the saved worktree path.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (within(worktree.sourceRoot, worktree.path)) {
      const managed = join(worktree.sourceRoot, '.pi', 'subagents', 'worktrees');
      if (dirname(worktree.path) !== managed) throw new Error('In-repository worktrees must use .pi/subagents/worktrees.');
      if (await git(worktree.sourceRoot, ['ls-files', '--', '.pi/subagents/worktrees'])) throw new Error('The worktree directory contains tracked files. Move or untrack them before creating children.');
      const exclude = join(worktree.commonDir, 'info', 'exclude');
      await mkdir(dirname(exclude), { recursive: true });
      let contents = '';
      try { contents = await readFile(exclude, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!contents.split('\n').includes('/.pi/subagents/worktrees/')) await appendFile(exclude, '\n/.pi/subagents/worktrees/\n', { mode: 0o600 });
    }
    await mkdir(dirname(worktree.path), { recursive: true, mode: 0o700 });
    let existing: string | undefined;
    try { existing = await git(worktree.sourceRoot, ['rev-parse', '--verify', `refs/heads/${worktree.branch}`]); }
    catch (error) { if ((error as { code?: number }).code !== 128) throw error; }
    if (existing && existing !== worktree.baseCommit) throw new Error('The pending child branch has moved. Recovery will not reset it.');
    await git(worktree.sourceRoot, existing ? ['worktree', 'add', '--', worktree.path, worktree.branch] :
      ['worktree', 'add', '-b', worktree.branch, '--', worktree.path, worktree.baseCommit]);
  }
  await verifyWorktree(worktree);
  if (!worktree.ready && await git(worktree.path, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('The pending worktree contains changes or an incomplete checkout. Recovery will not overwrite it.');
  }
}

type ToolPathResolver = { resolveToCwd: (path: string, cwd: string) => string; resolveReadPath: (path: string, cwd: string) => string };
let toolPaths: Promise<ToolPathResolver> | undefined;
/** Use the same Pi 1.4 resolver as the tool, including home paths and file URLs. */
export async function checkWorktreePath(worktree: Worktree, cwd: string, path: string | undefined, read = false): Promise<string> {
  toolPaths ??= import(new URL('core/tools/path-utils.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href).then(module => {
    if (typeof module.resolveToCwd !== 'function' || typeof module.resolveReadPath !== 'function') throw new Error('Pi 1.4 tool path resolver is unavailable.');
    return module as ToolPathResolver;
  });
  const resolver = await toolPaths;
  const resolved = (read ? resolver.resolveReadPath : resolver.resolveToCwd)(path ?? '.', cwd);
  const target = await canonicalPath(resolved);
  if (!within(worktree.path, target)) throw new Error(`Path is outside the child worktree. Use paths under ${worktree.path}.`);
  return resolved;
}
