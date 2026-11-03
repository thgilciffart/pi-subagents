import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

const exec = promisify(execFile);
test('the package uses host APIs through both SDK and bundled CLI loaders without local host peers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-package-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', dir]);
    const packed = JSON.parse(stdout)[0];
    expect(packed.files.map((file: any) => file.path)).toContain('index.ts');
    expect(packed.files.some((file: any) => /(?:test\/|auth\.json|children\.sqlite)/.test(file.path))).toBe(false);
    await exec('tar', ['-xzf', join(dir, packed.filename), '-C', dir]);
    // GitHub installs contain runtime dependencies but omit the peers supplied by Pi.
    const dependencies = JSON.parse(await readFile(join(dir, 'package', 'package.json'), 'utf8')).dependencies;
    for (const name of Object.keys(dependencies)) {
      const destination = join(dir, 'package', 'node_modules', name);
      await mkdir(join(destination, '..'), { recursive: true });
      await symlink(join(process.cwd(), 'node_modules', name), destination, 'dir');
    }
    await expect(access(join(dir, 'package', 'node_modules', '@earendil-works', 'pi-coding-agent'))).rejects.toMatchObject({ code: 'ENOENT' });
    const consumer = join(dir, 'consumer');
    await mkdir(join(consumer, 'node_modules', '@thgilciffart'), { recursive: true });
    await symlink(join(dir, 'package'), join(consumer, 'node_modules', '@thgilciffart', 'pi-subagents'), 'dir');
    const hook = join(consumer, 'hook.ts');
    await writeFile(hook, `import { registerChildHook } from '@thgilciffart/pi-subagents';
import { checkWorktreePath } from '../package/src/worktrees.ts';
export default function (pi) {
  registerChildHook(pi, { name: 'package-hook', version: '1', permissions: 'read-only', project: false, replay: 'safe',
    async onStart(child) {
      const resolved = await checkWorktreePath({ path: child.cwd }, child.cwd, '.', true);
      if (resolved !== child.cwd) throw new Error('Packaged host path resolver did not preserve the child directory');
      const key = Symbol.for('pi-subagents-package-hook'); Reflect.set(globalThis, key, (Reflect.get(globalThis, key) ?? 0) + 1);
    }
  });
}
`);
    const script = fileURLToPath(new URL('./process/package.ts', import.meta.url));
    await exec(process.execPath, ['--import', 'tsx', script, join(dir, 'package', 'index.ts'), dir, hook], { timeout: 15000 });
    const cliAgentDir = join(dir, 'cli-agent');
    await mkdir(cliAgentDir);
    const cli = exec(process.execPath, [join(getPackageDir(), 'dist/bundle/cli.js'),
      '--print', '--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp',
      '--model', 'faux/faux-1', '-e', join(dir, 'package', 'index.ts'),
      '-e', fileURLToPath(new URL('./process/package-cli.ts', import.meta.url)), 'List subagents'],
      { cwd: join(dir, 'project'), env: { ...process.env, PI_CODING_AGENT_DIR: cliAgentDir }, timeout: 15000 });
    cli.child.stdin?.end();
    const { stdout: output } = await cli;
    expect(output).toContain('Packaged CLI list succeeded');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 40000);
