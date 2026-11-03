import { describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fauxAssistantMessage as answer } from './fixtures.ts';
import { openStore } from '../src/storage.ts';
import { PERMISSION_TOOLS } from '../src/agents.ts';

const script = fileURLToPath(new URL('./process/crash.ts', import.meta.url));
function processFixture(dir: string, mode: string, phase: string): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, dir, mode, phase], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Fixture timed out: ${stderr}`)); }, 12000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
}

describe('recovery after SIGKILL in another Node process', () => {
  test.each(['model', 'read', 'write', 'edit', 'bash', 'cancel', 'close', 'admission', 'submission', 'steering', 'worktree-intent', 'worktree-created', 'worktree-active', 'mcp', 'hook-before', 'hook-after', 'hook-completed', 'lifecycle-start', 'lifecycle-safe-start', 'lifecycle-stop', 'lifecycle-close', 'lifecycle-resume', 'untrusted'])('%s checkpoint survives a process crash', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-crash-'));
    await mkdir(join(dir, 'project')); await mkdir(join(dir, 'agent'));
    const effect = join(dir, 'project', 'effect');
    await writeFile(effect, mode === 'edit' ? 'old' : mode === 'read' ? 'saved-read-evidence' : '');
    try {
      const crashed = await processFixture(dir, mode, 'crash');
      expect(crashed.signal, crashed.stderr).toBe('SIGKILL');
      if (mode === 'lifecycle-resume') {
        const interruptedResume = await processFixture(dir, mode, 'recover');
        expect(interruptedResume.signal, interruptedResume.stderr).toBe('SIGKILL');
      }
      const recovered = await processFixture(dir, mode, mode === 'lifecycle-resume' ? 'recover-final' : 'recover');
      expect(recovered.code, recovered.stderr).toBe(0);
      const result = JSON.parse(await readFile(join(dir, 'recovered.json'), 'utf8'));
      expect(result.child.runs).toHaveLength(1);
      expect(result.child.runs[0].task).toBe('Keep this original task and conversation');
      expect(result.child.tools).toEqual(mode === 'untrusted' ? ['read'] : [...PERMISSION_TOOLS.full, ...(mode === 'mcp' ? ['mcp'] : [])]);
      if (mode === 'untrusted') {
        expect(result.child.trust).toBe('untrusted'); expect(result.child.policy.trust).toBe('untrusted');
        expect(result.child.policy.tools).toEqual(['read']); expect(result.child.runs[0].trust).toBe('untrusted');
      }
      if (mode === 'mcp') expect(result.child.capabilities.mcpTools).toHaveLength(1);
      if (mode.startsWith('hook-')) expect(result.child.capabilities.hooks[0].replay).toBe('unsafe');
      expect(result.child.model).toBe('faux/faux-1');
      expect(result.child.thinking).toBe('off');
      if (mode === 'cancel' || mode === 'close' || mode === 'lifecycle-close') {
        expect(result.calls).toBe(0);
        expect(result.child.runs[0].status).toBe('cancelled');
        expect(result.child.closed).toBe(mode === 'close' || mode === 'lifecycle-close');
      } else if (mode === 'lifecycle-start' || mode === 'lifecycle-resume') {
        expect(result.child.runs[0].status).toBe('failed'); expect(result.calls).toBe(0);
        expect(result.child.runs[0].error).toContain('interrupted');
      } else if (mode === 'lifecycle-stop') {
        expect(result.child.runs[0].status).toBe('completed'); expect(result.calls).toBe(0);
        expect(result.child.runs[0].output).toBe('Finished before lifecycle hook');
        expect(result.child.runs[0].lifecycleErrors.join('')).toContain('interrupted');
      } else {
        expect(result.child.runs[0].status).toBe('completed');
        expect(result.child.runs[0].output).toBe('Recovered from saved progress');
        expect(result.calls).toBe(mode === 'steering' ? 2 : 1);
        if (mode === 'steering') { expect(result.child.runs[0].steering).toHaveLength(1); expect(JSON.stringify(result.contexts)).toContain('Preserve crash-safe steering'); }
        if (mode.startsWith('worktree-')) expect(result.child.worktree.ready).toBe(true);
        if (mode === 'worktree-active') expect(await readFile(join(result.child.cwd, 'progress.txt'), 'utf8')).toBe('Saved isolated progress');
        expect(JSON.stringify(result.contexts)).toContain('Keep this original task and conversation');
        if (mode === 'read') expect(JSON.stringify(result.contexts)).toContain('saved-read-evidence');
        if (['write', 'edit', 'bash', 'mcp', 'hook-before', 'hook-after'].includes(mode)) expect(JSON.stringify(result.contexts)).toContain('interrupted');
      }
      if (mode === 'write') expect(await readFile(effect, 'utf8')).toBe('written-once');
      if (mode === 'edit') expect(await readFile(effect, 'utf8')).toBe('new');
      if (['bash', 'mcp', 'hook-before', 'hook-after', 'hook-completed'].includes(mode)) expect(await readFile(effect, 'utf8')).toBe('x');
      if (mode.startsWith('lifecycle-')) expect(await readFile(effect, 'utf8')).toBe('x');
      // A second reopen cannot generate a second answer or restart cancellation.
      const again = await processFixture(dir, mode, 'recover');
      expect(again.code, again.stderr).toBe(0);
      expect(JSON.parse(await readFile(join(dir, 'recovered.json'), 'utf8')).calls).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 25000);
});

test('reload continues the saved conversation with its narrowed permissions', async () => {
  const f = await fixture(true);
  try {
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    f.respond(async (_context, options) => {
      started();
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return answer('', { stopReason: 'aborted' });
    });
    const run = await f.spawn({ tools: ['read'] }); await begun;
    const saved = await f.runtime.saved(run.id);
    await f.runtime.dispose();
    await f.open();
    f.respond(context => { expect(JSON.stringify(context)).toContain('Inspect the fixture'); return answer('Continued'); });
    await f.runtime.resume();
    expect((await f.runtime.wait(run.id, 3000)).output).toBe('Continued');
    expect((await f.runtime.saved(run.id)).tools).toEqual(['read']);
    expect((await f.runtime.saved(run.id)).anchor).toBe(saved.anchor);
    expect((await f.runtime.saved(run.id)).definition).toEqual(saved.definition);
  } finally { await f.cleanup(); }
});

test('a changed model scope blocks recovery before another model request', async () => {
  const f = await fixture(true);
  try {
    f.respond(answer('Done'));
    const run = await f.spawn(); await f.runtime.wait(run.id, 3000);
    f.allow(() => { throw new Error('Model scope changed'); });
    await expect(f.runtime.send(run.id, 'next', 'next', 'next')).rejects.toThrow('scope changed');
    expect(f.faux.state.callCount).toBe(1);
  } finally { await f.cleanup(); }
});

test('only one process can own the saved parent, and runtime storage cannot be inside the project', async () => {
  const f = await fixture(true);
  try {
    await expect(openStore(f.agentDir, join(f.dir, 'parent.jsonl'), 'parent', f.cwd)).rejects.toThrow('Another Pi process');
    await expect(openStore(join(f.cwd, '.pi'), join(f.dir, 'parent.jsonl'), 'parent', f.cwd)).rejects.toThrow('outside');
  } finally { await f.cleanup(); }
});

test('an answer saved before metadata settlement stays completed after its deadline', async () => {
  const f = await fixture(true);
  try {
    f.respond(answer('Saved final answer'));
    const run = await f.spawn(); await f.runtime.wait(run.id, 3000);
    const { Children } = await import('../src/runtime.ts');
    const { BACKGROUND_CONTEXT: C } = await import('@earendil-works/chord/context');
    // This is the state between Durable's answer commit and plugin result settlement.
    await f.runtime.harness.commit(async tx => {
      const saved = (await tx.doc(Children)).children[run.id].runs[0];
      saved.status = 'running'; saved.startedAt = 1; saved.output = ''; delete saved.finishedAt;
    }, C);
    await f.runtime.dispose(); await f.open(); await f.runtime.resume();
    const recovered = await f.runtime.get(run.id);
    expect(recovered.status).toBe('completed'); expect(recovered.output).toBe('Saved final answer');
    expect(f.faux.state.callCount).toBe(1);
  } finally { await f.cleanup(); }
});


test('parent path aliases keep the same ownership lock before the transcript exists', async () => {
  const f = await fixture();
  try {
    const actual = join(f.dir, 'actual-sessions'), alias = join(f.dir, 'session-alias');
    await mkdir(actual); await symlink(actual, alias, 'dir');
    const first = await openStore(f.agentDir, join(alias, 'parent.jsonl'), 'alias-parent', f.cwd);
    try {
      await writeFile(join(actual, 'parent.jsonl'), '');
      await expect(openStore(f.agentDir, join(actual, 'parent.jsonl'), 'alias-parent', f.cwd)).rejects.toThrow('Another Pi process');
    } finally { await first.storage.close((await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT); first.release(); }
  } finally { await f.cleanup(); }
});
