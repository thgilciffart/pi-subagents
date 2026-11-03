import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { registerChildHook } from '../../index.ts';

/** Load in the parent. Compatible children inherit this read-only adapter. */
export default function lifecycle(pi: ExtensionAPI): void {
  registerChildHook(pi, {
    name: 'require-package', version: '1', permissions: 'read-only', project: true, replay: 'safe',
    async onStart(child) {
      // Throwing stops this task before its first model request.
      await access(join(child.cwd, 'package.json'));
    },
    async onResume(child) {
      // Recovery checks the same child checkout instead of creating a replacement.
      await access(join(child.cwd, 'package.json'));
    },
  });
}
