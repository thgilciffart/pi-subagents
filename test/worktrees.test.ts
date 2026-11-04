import { describe, expect, test } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BUILTIN_AGENTS, PERMISSION_TOOLS } from '../src/agents.ts';
import { checkWorktreePath, ensureWorktree, git, planWorktree } from '../src/worktrees.ts';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';

async function repository(cwd: string) {
  await git(cwd, ['init', '--initial-branch=main']);
  await git(cwd, ['config', 'user.name', 'Subagent fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(cwd, 'baseline.txt'), 'Committed baseline');
  await git(cwd, ['add', 'baseline.txt']); await git(cwd, ['commit', '-m', 'Add fixture baseline']);
}
const worker = { ...BUILTIN_AGENTS[2] };

test('an untracked cwd fails before creating a worktree or branch', async () => {
  const f = await fixture();
  try {
    await repository(f.cwd); const cwd = join(f.cwd, 'new-directory'); await mkdir(cwd);
    const trees = await git(f.cwd, ['worktree', 'list', '--porcelain']);
    const branches = await git(f.cwd, ['branch', '--list']);
    await expect(planWorktree(cwd)).rejects.toThrow('does not exist at HEAD');
    expect(await git(f.cwd, ['worktree', 'list', '--porcelain'])).toBe(trees);
    expect(await git(f.cwd, ['branch', '--list'])).toBe(branches);
  } finally { await f.cleanup(); }
});

describe('isolated child worktrees', () => {
  test('runs file tools in a branch at parent HEAD without copying dirty or untracked parent files', async () => {
    const f = await fixture(true);
    try {
      await repository(f.cwd); const base = await git(f.cwd, ['rev-parse', 'HEAD']);
      await writeFile(join(f.cwd, 'baseline.txt'), 'Parent dirty change');
      await writeFile(join(f.cwd, 'untracked.txt'), 'Parent only');
      let context = '';
      f.respond(answer(fauxToolCall('read', { path: 'baseline.txt' }), { stopReason: 'toolUse' }), current => {
        context = JSON.stringify(current); return answer(fauxToolCall('write', { path: 'baseline.txt', content: 'Child change' }), { stopReason: 'toolUse' });
      }, answer('Done in child branch'));
      const run = await f.spawn({ definition: worker, tools: worker.tools, isolation: 'worktree' });
      expect((await f.runtime.wait(run.id, 5000)).status).toBe('completed');
      const child = await f.runtime.saved(run.id);
      expect(context).toContain('Committed baseline'); expect(context).not.toContain('Parent dirty change');
      expect(child.worktree?.baseCommit).toBe(base);
      expect(await git(child.cwd, ['branch', '--show-current'])).toBe(child.worktree?.branch);
      expect(await readFile(join(child.cwd, 'baseline.txt'), 'utf8')).toBe('Child change');
      expect(await readFile(join(f.cwd, 'baseline.txt'), 'utf8')).toBe('Parent dirty change');
      await expect(readFile(join(child.cwd, 'untracked.txt'))).rejects.toThrow();
      await f.runtime.close(run.id);
      expect(await readFile(join(child.cwd, 'baseline.txt'), 'utf8')).toBe('Child change');
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      expect((await f.runtime.saved(run.id)).worktree).toEqual(child.worktree);
    } finally { await f.cleanup(); }
  });
  test('reuses the same dirty worktree for a follow-up after reload and deduplicates creation', async () => {
    const f = await fixture(true);
    try {
      await repository(f.cwd);
      f.respond(answer('First'), answer('Follow-up'));
      const options = { definition: worker, tools: worker.tools, isolation: 'worktree' as const };
      const [a, b] = await Promise.all([f.spawn(options), f.spawn(options)]);
      expect(a.id).toBe(b.id);
      await f.runtime.wait(a.id, 5000); const child = await f.runtime.saved(a.id);
      await writeFile(join(child.cwd, 'progress.txt'), 'Saved child progress');
      const before = await git(f.cwd, ['worktree', 'list', '--porcelain']);
      await f.runtime.dispose(); await f.open(); await f.runtime.resume();
      await f.runtime.send(a.id, 'Continue saved work', 'next', 'next'); await f.runtime.wait(a.id, 5000);
      expect((await f.runtime.saved(a.id)).cwd).toBe(child.cwd);
      expect(await readFile(join(child.cwd, 'progress.txt'), 'utf8')).toBe('Saved child progress');
      expect(await git(f.cwd, ['worktree', 'list', '--porcelain'])).toBe(before);
    } finally { await f.cleanup(); }
  });
  test('rejects parent paths and symlinks escaping the isolated checkout', async () => {
    const f = await fixture(true);
    try {
      await repository(f.cwd);
      f.respond(answer('Prepare'), answer(fauxToolCall('write', { path: join(f.cwd, 'baseline.txt'), content: 'Forbidden' }), { stopReason: 'toolUse' }), answer('Blocked'),
        answer(fauxToolCall('write', { path: 'escape/baseline.txt', content: 'Forbidden' }), { stopReason: 'toolUse' }), answer('Blocked again'));
      const run = await f.spawn({ definition: worker, tools: worker.tools, isolation: 'worktree' }); await f.runtime.wait(run.id, 5000);
      const child = await f.runtime.saved(run.id); await symlink(f.cwd, join(child.cwd, 'escape'), 'dir');
      await f.runtime.send(run.id, 'Try parent absolute path', 'absolute', 'absolute'); await f.runtime.wait(run.id, 5000);
      await f.runtime.send(run.id, 'Try escaping symlink', 'symlink', 'symlink'); await f.runtime.wait(run.id, 5000);
      expect(await readFile(join(f.cwd, 'baseline.txt'), 'utf8')).toBe('Committed baseline');
      expect(await f.runtime.transcript(run.id)).toContain('outside the child worktree');
    } finally { await f.cleanup(); }
  });
  test('shell tools use the child directory and creation does not execute checkout hooks', async () => {
    const f = await fixture(true);
    try {
      await repository(f.cwd);
      const hook = join(f.cwd, '.git', 'hooks', 'post-checkout');
      await writeFile(hook, `#!/bin/sh\nprintf bad > '${join(f.dir, 'hook-ran')}'\n`, { mode: 0o755 });
      const full = { ...worker, permissions: 'full' as const, tools: [...PERMISSION_TOOLS.full] };
      f.respond(answer(fauxToolCall('bash', { command: 'pwd' }), { stopReason: 'toolUse' }), context => answer(JSON.stringify(context)));
      const run = await f.spawn({ definition: full, tools: full.tools, isolation: 'worktree' });
      const result = await f.runtime.wait(run.id, 5000);
      expect(result.status).toBe('completed'); expect(result.output).toContain(run.cwd);
      await expect(readFile(join(f.dir, 'hook-ran'))).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
  test('a missing saved worktree fails without touching the parent or creating a replacement', async () => {
    const f = await fixture(true);
    try {
      await repository(f.cwd); f.respond(answer('Done'));
      const run = await f.spawn({ isolation: 'worktree' }); await f.runtime.wait(run.id, 5000);
      const child = await f.runtime.saved(run.id); await rm(child.worktree!.path, { recursive: true, force: true });
      await expect(f.runtime.send(run.id, 'Continue', 'next', 'next')).rejects.toThrow();
      expect(f.faux.state.callCount).toBe(1);
      expect(await readFile(join(f.cwd, 'baseline.txt'), 'utf8')).toBe('Committed baseline');
    } finally { await f.cleanup(); }
  });
  test('reattaches a completed worktree add when the ready checkpoint was not saved', async () => {
    const f = await fixture(true);
    try {
      await repository(f.cwd); f.respond(answer('Done'));
      const run = await f.spawn({ isolation: 'worktree' }); await f.runtime.wait(run.id, 5000);
      const child = await f.runtime.saved(run.id); const plan = { ...child.worktree!, ready: false };
      const before = await git(f.cwd, ['worktree', 'list', '--porcelain']);
      await ensureWorktree(plan);
      expect(await git(f.cwd, ['worktree', 'list', '--porcelain'])).toBe(before);
    } finally { await f.cleanup(); }
  });
});

test('default worktrees live in .pi and are ignored by Git', async () => {
  const f = await fixture(true);
  try {
    await repository(f.cwd); f.respond(answer('Done'));
    // Use the production default instead of the fixture's external worktree root.
    await f.runtime.dispose();
    const { SubagentRuntime } = await import('../src/runtime.ts');
    const { openStore } = await import('../src/storage.ts');
    const runtime = await SubagentRuntime.open(await openStore(f.agentDir, join(f.dir, 'parent.jsonl'), 'parent', f.cwd),
      { parentId: 'parent', cwd: f.cwd, models: f.models, allow: () => {}, changed: () => {}, error: () => {} });
    try {
      const run = await runtime.spawn(f.options({ isolation: 'worktree' }), 'inside-pi', 'inside-pi'); await runtime.wait(run.id, 5000);
      expect(run.worktree!.path.startsWith(join(f.cwd, '.pi', 'subagents', 'worktrees') + '/')).toBe(true);
      expect(await git(f.cwd, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(await git(f.cwd, ['check-ignore', run.worktree!.path])).toBe(run.worktree!.path);
    } finally { await runtime.dispose(); }
  } finally { await f.cleanup(); }
});

test('parallel children edit the same relative file in separate worktrees', async () => {
  const f = await fixture(true);
  try {
    await repository(f.cwd);
    f.respond(...Array.from({ length: 4 }, () => (context: any) => {
      const messages = context.messages as any[];
      if (messages.some(message => message.role === 'toolResult')) return answer('Isolated edit done');
      const owner = JSON.stringify(context).includes('Child A') ? 'A' : 'B';
      return answer(fauxToolCall('write', { path: 'same.txt', content: owner }), { stopReason: 'toolUse' });
    }));
    const [a, b] = await Promise.all([
      f.spawn({ definition: worker, tools: worker.tools, isolation: 'worktree', task: 'Child A' }, 'a'),
      f.spawn({ definition: worker, tools: worker.tools, isolation: 'worktree', task: 'Child B' }, 'b'),
    ]);
    expect((await Promise.all([f.runtime.wait(a.id, 5000), f.runtime.wait(b.id, 5000)])).map(run => run.status)).toEqual(['completed', 'completed']);
    expect(a.cwd).not.toBe(b.cwd);
    expect(await readFile(join(a.cwd!, 'same.txt'), 'utf8')).toBe('A');
    expect(await readFile(join(b.cwd!, 'same.txt'), 'utf8')).toBe('B');
    await expect(readFile(join(f.cwd, 'same.txt'))).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test('worktree checks match Pi home, at-prefix, and file-URL resolution before file effects', async () => {
  const f = await fixture();
  try {
    await repository(f.cwd);
    f.respond(answer('Ready'), answer(fauxToolCall('write', { path: pathToFileURL(join(f.cwd, 'baseline.txt')).href, content: 'Forbidden' }), { stopReason: 'toolUse' }), answer('Blocked'));
    const run = await f.spawn({ definition: worker, tools: worker.tools, isolation: 'worktree' }); await f.runtime.wait(run.id, 3000);
    const child = await f.runtime.saved(run.id);
    for (const path of ['~/pi-subagents-path-test', '@' + join(f.cwd, 'baseline.txt'), pathToFileURL(join(f.cwd, 'baseline.txt')).href]) {
      await expect(checkWorktreePath(child.worktree!, child.cwd, path)).rejects.toThrow('outside');
    }
    await f.runtime.send(run.id, 'Try a file URL', 'file-url', 'file-url'); await f.runtime.wait(run.id, 3000);
    expect(await readFile(join(f.cwd, 'baseline.txt'), 'utf8')).toBe('Committed baseline');
    expect(await f.runtime.transcript(run.id)).toContain('outside the child worktree');
  } finally { await f.cleanup(); }
});
