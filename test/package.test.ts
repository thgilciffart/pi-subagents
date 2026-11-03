import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
test('the npm tarball loads through Pi and runs a local child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-package-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', dir]);
    const packed = JSON.parse(stdout)[0];
    expect(packed.files.map((file: any) => file.path)).toContain('index.ts');
    expect(packed.files.some((file: any) => /(?:test\/|auth\.json|children\.sqlite)/.test(file.path))).toBe(false);
    await exec('tar', ['-xzf', join(dir, packed.filename), '-C', dir]);
    // Pi supplies host peers. Use this test installation's exact dependency tree without a network install.
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'package', 'node_modules'), 'dir');
    const consumer = join(dir, 'consumer');
    await mkdir(join(consumer, 'node_modules', '@thgilciffart'), { recursive: true });
    await symlink(join(dir, 'package'), join(consumer, 'node_modules', '@thgilciffart', 'pi-subagents'), 'dir');
    const hook = join(consumer, 'hook.ts');
    await writeFile(hook, `import { registerChildHook } from '@thgilciffart/pi-subagents';
export default function (pi) {
  registerChildHook(pi, { name: 'package-hook', version: '1', permissions: 'read-only', project: false, replay: 'safe',
    onStart() { const key = Symbol.for('pi-subagents-package-hook'); Reflect.set(globalThis, key, (Reflect.get(globalThis, key) ?? 0) + 1); }
  });
}
`);
    const script = fileURLToPath(new URL('./process/package.ts', import.meta.url));
    await exec(process.execPath, ['--import', 'tsx', script, join(dir, 'package', 'index.ts'), dir, hook], { timeout: 15000 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);
