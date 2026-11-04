import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';

/** Import conversation content without the parent's tool declarations or executable instructions. */
export function forkMessages(history: readonly Message[], creatingCallId?: string): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (message.role === 'system' || message.role === 'toolResult') continue;
    if (message.role === 'user') { messages.push(JSON.parse(JSON.stringify(message))); continue; }
    const content = message.content.filter(part => part.type !== 'thinking');
    if (!content.length) continue;
    const calls = content.filter(part => part.type === 'toolCall');
    messages.push({ ...JSON.parse(JSON.stringify(message)), content, stopReason: calls.length ? 'toolUse' : 'stop' });
    const results = new Map<string, ToolResultMessage>();
    for (let next = index + 1; next < history.length && history[next].role === 'toolResult'; next++) {
      const result = history[next] as ToolResultMessage;
      results.set(result.toolCallId, result);
    }
    for (const call of calls) messages.push(results.get(call.id) ?? {
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: call.id === creatingCallId ? 'This parent delegation created you. Your assigned task follows. Do not repeat this delegation.' : 'This parent tool call had no saved result at the fork point. It was not executed in this child. Inspect its effects before requesting another operation.' }],
      isError: call.id !== creatingCallId, timestamp: Date.now(),
    });
  }
  return JSON.parse(JSON.stringify(messages));
}
