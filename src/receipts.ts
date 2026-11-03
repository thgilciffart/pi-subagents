import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const RESULT_MESSAGE = 'pi-subagents-results';

/** Only a persisted parent entry acknowledges delivery, never an in-memory queue. */
export function parentReceipts(context: ExtensionContext): string[] {
  const receipts = new Set<string>();
  for (const entry of context.sessionManager.getEntries()) {
    let details: unknown;
    if (entry.type === 'custom_message' && entry.customType === RESULT_MESSAGE) details = entry.details;
    if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'subagent') details = entry.message.details;
    if (!details || typeof details !== 'object' || !('receipts' in details) || !Array.isArray(details.receipts)) continue;
    for (const receipt of details.receipts) if (typeof receipt === 'string') receipts.add(receipt);
  }
  return [...receipts];
}
