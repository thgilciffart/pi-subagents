import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function run(dir: string, mode: string, phase: string): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./process/nested-crash.ts', import.meta.url)), dir, mode, phase], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Nested crash fixture timed out: ${stderr}`)); }, 12000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
}

test.each(['spawn', 'cancel', 'close'])('nested %s survives SIGKILL without duplicate creation or orphan recovery', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-nested-crash-'));
  await mkdir(join(dir, 'project')); await mkdir(join(dir, 'agent'));
  try {
    const crash = await run(dir, mode, 'crash');
    expect(crash.signal, crash.stderr).toBe('SIGKILL');
    const recovery = await run(dir, mode, 'recover');
    expect(recovery.code, recovery.stderr).toBe(0);
    const report = JSON.parse(await readFile(join(dir, 'nested-recovered.json'), 'utf8'));
    // Closed owners are retained in storage but omitted from list().
    expect(report.children).toHaveLength(mode === 'close' ? 1 : 2);
    if (mode === 'spawn') {
      expect(report.result.output).toBe('Root incorporated saved nested result');
      expect(report.pending).toHaveLength(1);
      expect(report.children.every((child: any) => child.status === 'completed')).toBe(true);
      const nested = report.children.find((child: any) => child.parentChildId);
      expect(report.policies.some((policy: any) => policy.delegation?.ownerId === nested.parentChildId)).toBe(true);
    } else {
      expect(report.calls).toBe(0);
      expect(report.children.every((child: any) => child.status === 'cancelled')).toBe(true);
    }
    const again = await run(dir, mode, 'recover');
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'nested-recovered.json'), 'utf8')).calls).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);
