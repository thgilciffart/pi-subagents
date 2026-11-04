import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir, type ExtensionAPI, type ExtensionContext, type McpServerEntry, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Tool, CallToolResult } from '@earendil-works/pi-mcp';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { Check } from 'typebox/value';
import type { TSchema } from 'typebox';
import { digest, isProjectPath, mcpSignature, type McpBridge, type McpSnapshot } from './capabilities.ts';

// Pi 1.4 exports the config types but not its connection/auth helpers. Keep this
// version-specific bridge in one module and use the host's implementation.
interface Connection {
  tools: Tool[]; timeoutMs: number;
  getClient(): Promise<unknown>;
  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<CallToolResult>;
  close(): Promise<void>;
}
interface PiMcp {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): { servers: McpServerEntry[]; errors: string[] };
  McpServerConnection: new (options: { entry: McpServerEntry; cwd: string; createTransport: unknown; credentials: unknown;
    providerToken: (provider: string) => Promise<string | undefined>; onTools: () => void }) => Connection;
  createDefaultTransport: unknown;
  McpOAuthCredentialStore: new (backend: unknown, lockDir: string) => unknown;
  FileAuthStorageBackend: new (path: string) => unknown;
  createMcpToolName(server: string, tool: string, taken?: (name: string) => boolean): string;
  createMcpToolDefinition(options: { server: string; tool: Tool; name: string; exposure: 'direct'; namespace: { name: string }; timeoutMs: number; getClient: () => Promise<Connection> }): ToolDefinition;
  getMcpToolExposure(config: McpServerEntry['config'], tool: string): string;
  convertMcpResult(server: string, tool: string, result: CallToolResult): Promise<{ content: NonNullable<ToolExecutionResult['output']> }>;
}
let modules: Promise<PiMcp> | undefined;
async function internals(): Promise<PiMcp> {
  return modules ??= (async () => {
    // Pi supplies public imports through its loader, without local host peers.
    // Use that host's directory rather than resolving from the extension.
    const paths = ['extensions/mcp/config.js', 'extensions/mcp/runtime.js', 'extensions/mcp/tools.js', 'core/auth-storage.js'];
    const parts = await Promise.all(paths.map(path => import(pathToFileURL(join(getPackageDir(), 'dist', path)).href)));
    const api = Object.assign({}, ...parts) as PiMcp;
    for (const name of ['loadMcpConfig', 'McpServerConnection', 'McpOAuthCredentialStore', 'FileAuthStorageBackend', 'createMcpToolDefinition', 'convertMcpResult'] as const) {
      if (typeof api[name] !== 'function') throw new Error(`Pi 1.4 MCP compatibility helper unavailable: ${name}.`);
    }
    return api;
  })();
}
const namespace = (server: string) => `mcp__${server.replace(/-/g, '_')}`;

export class NativeMcpBridge implements McpBridge {
  private connections = new Map<string, Promise<Connection>>();
  private ended = false;
  constructor(private pi: Pick<ExtensionAPI, 'getAllTools' | 'getMcpServers' | 'getActiveTools'>,
    private context: () => ExtensionContext, private agentDir: string) {}
  private async entries(): Promise<McpServerEntry[]> {
    const native = await internals(), context = this.context();
    const loaded = native.loadMcpConfig({ agentDir: this.agentDir, cwd: context.cwd, projectTrusted: context.isProjectTrusted() });
    if (loaded.errors.length) throw new Error(`Invalid parent MCP configuration: ${loaded.errors.join('\n')}`);
    const entries = new Map(loaded.servers.map(entry => [entry.name, entry]));
    const namespaces = new Set(loaded.servers.map(entry => namespace(entry.name)));
    for (const entry of this.pi.getMcpServers()) if (!namespaces.has(namespace(entry.name))) {
      namespaces.add(namespace(entry.name));
      entries.set(entry.name, { name: entry.name, config: entry.config, source: entry.extensionPath, scope: 'extension' });
    }
    return [...entries.values()].filter(entry => entry.config.enabled !== false &&
      (!(entry.scope === 'project' || !!entry.override || isProjectPath(context.cwd, entry.source)) || context.isProjectTrusted()));
  }
  private configHash(entry: McpServerEntry): string { return digest([entry.name, entry.config, entry.source, entry.scope, entry.override]); }
  async catalog(): Promise<McpSnapshot[]> {
    const entries = await this.entries(), active = this.pi.getActiveTools();
    return this.pi.getAllTools().filter(tool => tool.name.startsWith('mcp__') && tool.exposure !== 'hidden' &&
      (tool.exposure !== 'direct' || active.includes(tool.name))).map(tool => {
        const matches = entries.filter(entry => tool.namespace?.name === namespace(entry.name));
        if (matches.length !== 1) throw new Error(`Cannot identify configured MCP server for ${tool.name}.`);
        const entry = matches[0];
        return { name: tool.name, server: entry.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)),
          readOnly: tool.annotations?.readOnlyHint === true, signature: mcpSignature(tool), configHash: this.configHash(entry),
          project: entry.scope === 'project' || !!entry.override || tool.sourceInfo.scope === 'project' || isProjectPath(this.context().cwd, entry.source) };
      });
  }
  async validate(tools: McpSnapshot[]): Promise<void> {
    if (!tools.length) return;
    const entries = await this.entries();
    for (const tool of tools) {
      const entry = entries.find(entry => entry.name === tool.server);
      if (!entry || this.configHash(entry) !== tool.configHash) throw new Error(`Saved MCP server changed or is unavailable: ${tool.server}.`);
      const current = this.pi.getAllTools().find(item => item.name === tool.name);
      // Startup reconnects tools asynchronously. The child connection validates the
      // saved schema before dispatch even when the parent's catalog is still empty.
      if (current && (current.exposure === 'hidden' || (current.exposure === 'direct' && !this.pi.getActiveTools().includes(current.name)) || mcpSignature(current) !== tool.signature)) throw new Error(`Saved MCP tool changed or is unavailable: ${tool.name}.`);
    }
  }
  async call(tool: McpSnapshot, childId: string, cwd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (this.ended) throw new Error('Child MCP connections are closed.');
    await this.validate([tool]);
    if (!Check(tool.parameters as TSchema, args)) throw new Error(`Arguments do not match the saved schema for ${tool.name}.`);
    signal?.throwIfAborted();
    const native = await internals();
    if (this.ended) throw new Error('Child MCP connections are closed.');
    const key = JSON.stringify([childId, cwd, tool.server, tool.configHash]);
    let pending = this.connections.get(key);
    if (!pending) {
      pending = (async () => {
        const entry = (await this.entries()).find(entry => entry.name === tool.server)!;
        const credentials = new native.McpOAuthCredentialStore(new native.FileAuthStorageBackend(join(this.agentDir, 'mcp-auth.json')), join(this.agentDir, 'mcp-auth-locks'));
        return new native.McpServerConnection({ entry, cwd, createTransport: native.createDefaultTransport, credentials,
          providerToken: provider => this.context().modelRegistry.getApiKeyForProvider(provider), onTools: () => {} });
      })();
      this.connections.set(key, pending);
    }
    let connection: Connection;
    try { connection = await pending; }
    catch (error) { if (this.connections.get(key) === pending) this.connections.delete(key); throw error; }
    await connection.getClient();
    if (this.ended || this.connections.get(key) !== pending) { await connection.close(); throw new Error('Child MCP connections are closed.'); }
    signal?.throwIfAborted();
    const matches = connection.tools.filter(candidate => native.createMcpToolName(tool.server, candidate.name) === tool.name ||
      native.createMcpToolName(tool.server, candidate.name, () => true) === tool.name);
    if (matches.length !== 1) throw new Error(`Saved MCP tool is absent or ambiguous: ${tool.name}.`);
    const remote = matches[0];
    const exposure = native.getMcpToolExposure((await this.entries()).find(entry => entry.name === tool.server)!.config, remote.name);
    if (exposure === 'hidden') throw new Error('The saved MCP tool is hidden.');
    if (exposure === 'direct') await this.waitForParentTool(tool.name, signal);
    const definition = native.createMcpToolDefinition({ server: tool.server, tool: remote, name: tool.name, exposure: 'direct',
      namespace: { name: namespace(tool.server) }, timeoutMs: connection.timeoutMs, getClient: async () => connection });
    if (mcpSignature(definition) !== tool.signature) throw new Error(`Remote MCP tool schema or permissions changed: ${tool.name}.`);
    await this.validate([tool]);
    signal?.throwIfAborted();
    const result = await connection.callTool(remote.name, args, { signal, timeoutMs: connection.timeoutMs });
    const converted = await native.convertMcpResult(tool.server, remote.name, result);
    return { output: converted.content, isError: result.isError ?? false };
  }
  private async waitForParentTool(name: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!this.pi.getAllTools().some(tool => tool.name === name)) {
      signal?.throwIfAborted();
      if (this.ended) throw new Error('Child MCP connections are closed.');
      if (Date.now() >= deadline) throw new Error(`Parent MCP tool did not register during startup: ${name}.`);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error('MCP wait aborted.')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 25);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (!this.pi.getActiveTools().includes(name)) throw new Error(`Parent MCP tool is inactive: ${name}.`);
  }
  async close(): Promise<void> {
    this.ended = true;
    await Promise.allSettled([...this.connections.values()].map(async connection => (await connection).close()));
    this.connections.clear();
  }
  async release(childId: string): Promise<void> {
    const selected = [...this.connections].filter(([key]) => JSON.parse(key)[0] === childId);
    for (const [key] of selected) this.connections.delete(key);
    await Promise.allSettled(selected.map(async ([, connection]) => (await connection).close()));
  }
}
