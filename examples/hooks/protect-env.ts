import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerChildHook } from '../../index.ts';

/** Load this extension in the parent. The parent can select protect-env at spawn. */
export default function protectEnv(pi: ExtensionAPI): void {
  registerChildHook(pi, {
    name: 'protect-env', version: '1', permissions: 'read-only', replay: 'safe', project: true,
    beforeTool(call) {
      if (!['write', 'edit'].includes(call.name)) return;
      const path = (call.args as { path?: string }).path;
      if (path?.split(/[\\/]/).at(-1)?.startsWith('.env')) return { block: 'Keep environment files unchanged.' };
    },
  });
}
