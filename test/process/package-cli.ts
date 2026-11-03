import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

export default function packageCliFixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('subagent', { action: 'list' }), { stopReason: 'toolUse' }),
    context => {
      const result = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'subagent');
      if (!result || result.role !== 'toolResult' || result.isError || !JSON.stringify(result).includes('Parent capabilities')) {
        throw new Error(`Packaged CLI list failed: ${JSON.stringify(result)}`);
      }
      return fauxAssistantMessage('Packaged CLI list succeeded');
    },
  ]);
  pi.registerProvider(faux.provider);
}
