import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
const effect = process.argv[2];
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result: unknown;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [
    { name: 'inspect', description: 'Inspect local fixture', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'append', description: 'Append local fixture', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
  ] };
  else if (message.method === 'tools/call') {
    if (message.params.name === 'append') await appendFile(effect, 'x');
    result = { content: [{ type: 'text', text: `Local MCP ${message.params.name} in ${process.cwd()} · pid ${process.pid}` }] };
  } else if (message.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
