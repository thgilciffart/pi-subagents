import { randomUUID } from 'node:crypto';
import { Input, Key, Markdown, Text, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { isRunning, type ChildChatSnapshot } from './runtime.ts';
import { oneLine } from './ui.ts';

export type ChatItem = { id: string; role: 'parent' | 'assistant' | 'steering' | 'tool'; text: string; label: string;
  imported: boolean; args?: string; pending?: boolean; error?: boolean };
const clean = (text: string) => stripTerminalSequences(text).replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
function contentText(content: unknown): string {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return content.map(part => part?.type === 'text' ? clean(String(part.text ?? '')) : part?.type === 'image' ? '[Image attachment]' : '').filter(Boolean).join('\n');
}

/** Present actual conversation messages, never system prompts or checkpoint JSON. */
export function chatItems(entries: EntryRecord[], inherited = false): ChatItem[] {
  const items: ChatItem[] = [], tools = new Map<string, ChatItem>();
  for (const entry of entries) {
    const imported = entry.kind === 'pi-subagents.fork';
    if (imported && !inherited) continue;
    for (const [index, message] of (entry.model ?? []).entries()) {
      const id = `${entry.id}:${index}`;
      if (message.role === 'system') continue;
      if (message.role === 'user') {
        let text = contentText(message.content), label = imported ? 'Inherited parent context' : 'Parent';
        const steering = /^(User|Parent) steering:\n\n/.exec(text);
        if (steering) { label = steering[1] === 'User' ? 'You · steering' : 'Parent · steering'; text = text.slice(steering[0].length); }
        else text = text.replace(/^Assigned task:\n\n/, '');
        if (text) items.push({ id, role: steering ? 'steering' : 'parent', label, text, imported });
      } else if (message.role === 'assistant') {
        const text = contentText(message.content);
        if (text) items.push({ id, role: 'assistant', label: 'Assistant', text, imported });
        for (const [partIndex, part] of message.content.entries()) if (part.type === 'toolCall') {
          const args = part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments) ? part.arguments as Record<string, unknown> : undefined;
          const summary = args?.command ?? args?.path ?? args?.tool ?? args?.skill ?? part.arguments;
          const text = typeof summary === 'string' ? summary : JSON.stringify(summary) ?? String(summary);
          const item: ChatItem = { id: `${id}:tool:${partIndex}`, role: 'tool', label: oneLine(String(part.name)), text: '', args: oneLine(text).slice(0, 400), pending: true, imported };
          items.push(item); tools.set(part.id, item);
        }
      } else if (message.role === 'toolResult') {
        const item = tools.get(message.toolCallId);
        if (item) { item.text = contentText(message.content); item.pending = false; item.error = message.isError; }
        else items.push({ id, role: 'tool', label: oneLine(String(message.toolName)), text: contentText(message.content), error: message.isError, imported, pending: false });
      }
    }
  }
  return items;
}

type Steer = (text: string, requestId: string, expectedRun: number) => Promise<void>;

export class SubagentChat implements Component {
  private hasFocus = true;
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    if (this.hasFocus === value) return;
    this.hasFocus = value;
    this.input.focused = value;
    if (!this.disposed) this.requestRender();
  }
  private offset = 0;
  private viewportHeight = 1;
  private follow = true;
  private showTools = false;
  private showInherited = false;
  private composing = false;
  private composeRun = 0;
  private input = new Input({ prompt: '› ', placeholder: 'Give this child a new direction…' });
  private sending = false;
  private request?: { text: string; id: string; run: number };
  private notice = '';
  private failure = '';
  private loadFailure = '';
  private disposed = false;
  private pending = false;
  private timer: ReturnType<typeof setInterval>;
  private bodies = new Map<string, { text: string; width: number; rows: string[] }>();
  constructor(private snapshot: ChildChatSnapshot, private load: () => Promise<ChildChatSnapshot>, private steer: Steer,
    private theme: Theme, private done: () => void, private requestRender: () => void,
    private rows: () => number = () => 24, compose = false) {
    this.input.onSubmit = text => { void this.submit(text); };
    this.input.onEscape = () => { this.composing = false; this.requestRender(); };
    this.timer = setInterval(() => { void this.refresh(); }, 500); this.timer.unref();
    if (compose) this.startSteering();
  }
  async refresh(): Promise<void> {
    if (this.pending || this.disposed) return;
    this.pending = true;
    try { const snapshot = await this.load(); if (!this.disposed) { this.snapshot = snapshot; this.loadFailure = ''; } }
    catch (error) { if (!this.disposed) this.loadFailure = error instanceof Error ? error.message : String(error); }
    finally { this.pending = false; if (!this.disposed) this.requestRender(); }
  }
  private startSteering(): void {
    if (this.snapshot.run.status === 'starting') { this.notice = 'This child is starting. Wait until it is running before steering.'; return; }
    if (!isRunning(this.snapshot.run)) { this.notice = 'This task has finished. Ask the parent to start a follow-up.'; return; }
    this.composeRun = this.snapshot.run.run; this.composing = true; this.failure = ''; this.notice = '';
  }
  private async submit(value: string): Promise<void> {
    if (this.sending || this.disposed || !value.trim()) return;
    this.sending = true; this.failure = '';
    if (this.request?.text !== value || this.request.run !== this.composeRun) this.request = { text: value, run: this.composeRun, id: `user-steer:${randomUUID()}` };
    try {
      await this.steer(value, this.request.id, this.composeRun);
      if (!this.disposed) {
        this.input.setValue(''); this.request = undefined; this.composing = false; this.follow = true;
        this.notice = 'Direction queued. The child will receive it at the next model or tool boundary.';
        await this.refresh();
      }
    } catch (error) { if (!this.disposed) this.failure = error instanceof Error ? error.message : String(error); }
    finally { this.sending = false; if (!this.disposed) this.requestRender(); }
  }
  handleInput(data: string): void {
    if (this.composing) {
      if (this.sending && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')))) { this.done(); return; }
      if (!this.sending) this.input.handleInput(data);
      this.requestRender(); return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data === 'q') { this.done(); return; }
    const page = Math.max(1, this.viewportHeight);
    if (data === 's' || data === 'S') this.startSteering();
    else if (data === 'o' || data === 'O') { this.showTools = !this.showTools; this.bodies.clear(); }
    else if (data === 'i' || data === 'I') { this.showInherited = !this.showInherited; this.bodies.clear(); }
    else if (matchesKey(data, Key.up)) { this.follow = false; this.offset = Math.max(0, this.offset - 1); }
    else if (matchesKey(data, Key.down)) { this.follow = false; this.offset++; }
    else if (matchesKey(data, Key.pageUp)) { this.follow = false; this.offset = Math.max(0, this.offset - page); }
    else if (matchesKey(data, Key.pageDown)) { this.follow = false; this.offset += page; }
    else if (matchesKey(data, Key.home)) { this.follow = false; this.offset = 0; }
    else if (matchesKey(data, Key.end)) this.follow = true;
    this.requestRender();
  }
  private conversation(width: number): string[] {
    const lines: string[] = [], inner = Math.max(1, width - 4);
    const items = chatItems(this.snapshot.entries, this.showInherited);
    if (isRunning(this.snapshot.run)) {
      const start = this.snapshot.entries.findLastIndex(entry => entry.kind !== 'pi-subagents.fork' && entry.model?.some(message => message.role === 'user' && contentText(message.content).startsWith('Assigned task:')));
      const current = chatItems(this.snapshot.entries.slice(Math.max(0, start)));
      const delivered = new Map<string, number>();
      for (const item of current) if (item.role === 'steering') {
        const key = `${item.label}:${item.text}`; delivered.set(key, (delivered.get(key) ?? 0) + 1);
      }
      for (const direction of this.snapshot.run.steering ?? []) {
        const label = direction.source === 'user' ? 'You · steering' : 'Parent · steering';
        const key = `${label}:${clean(direction.task)}`, count = delivered.get(key) ?? 0;
        if (count) delivered.set(key, count - 1);
        else items.push({ id: `queued:${direction.id}`, role: 'steering', label: `${label} · queued`, text: clean(direction.task), imported: false });
      }
    }
    const imported = this.snapshot.entries.filter(entry => entry.kind === 'pi-subagents.fork').length;
    if (imported && !this.showInherited) lines.push(this.theme.fg('muted', `  ${imported} inherited context entries hidden · I to show`), '');
    for (const [index, item] of items.entries()) {
      if (index) lines.push('', this.theme.fg('borderMuted', '  ' + '─'.repeat(Math.max(0, width - 4))), '');
      const tool = item.role === 'tool';
      const color = tool ? item.error ? 'error' : item.pending ? 'warning' : 'success' : item.role === 'assistant' ? 'accent' : item.role === 'steering' ? 'warning' : 'userMessageText';
      const label = oneLine(tool ? `${item.pending ? '◌' : item.error ? '✗' : '✓'} ${item.label}` : item.role === 'assistant' ? this.snapshot.run.agent : item.label);
      lines.push(this.theme.fg(color, this.theme.bold(truncateToWidth(`  ${label}${item.imported ? ' · inherited' : ''}`, width))));
      if (tool && item.args) lines.push(this.theme.fg('muted', truncateToWidth(`  ${item.args}`, width)));
      let text = item.text;
      if (tool && !this.showTools) text = item.pending ? 'Running…' : item.error ? text.split('\n').slice(0, 2).join('\n') : 'Output collapsed · O to expand';
      if (tool && text.length > 16000) text = text.slice(0, 16000) + '\n[Output truncated]';
      if (text) {
        const key = item.id + (tool ? ':tool' : ':message');
        let cached = this.bodies.get(key);
        if (!cached || cached.text !== text || cached.width !== inner) {
          const body = tool ? new Text(text, 0, 0) : new Markdown(text, 0, 0, getMarkdownTheme(), { color: value => this.theme.fg('text', value) });
          cached = { text, width: inner, rows: body.render(inner) }; this.bodies.set(key, cached);
        }
        for (const line of cached.rows) lines.push(`  ${tool ? this.theme.fg(item.error ? 'error' : 'muted', line) : line}`);
      }
    }
    if (!items.length) lines.push(this.theme.fg('muted', '  Waiting for saved conversation messages…'));
    return lines.map(line => truncateToWidth(line, width));
  }
  render(width: number): string[] {
    // Leave the overlay registered so Pi can restore focus after the other dialog closes.
    // Rendering no rows reveals that dialog without interfering with its input or focus.
    if (width < 1 || !this.focused) return [];
    const run = this.snapshot.run, color = isRunning(run) ? 'accent' : run.status === 'failed' ? 'error' : run.status === 'completed' ? 'success' : 'muted';
    const header = this.theme.bold(this.theme.fg('text', ` ${oneLine(run.agent)} #${oneLine(run.id)}`)) + this.theme.fg(color, `  ${oneLine(run.status)}`);
    const meta = ` ${oneLine(`${run.model} · thinking ${run.thinking} · ${run.toolCalls} tool calls · task ${run.run}`)}`;
    const body = this.conversation(width);
    const bottom: string[] = [];
    if (this.failure || this.loadFailure || run.recoveryError) bottom.push(this.theme.fg('error', truncateToWidth(` ${this.failure || this.loadFailure || run.recoveryError}`, width)));
    else if (this.notice) bottom.push(this.theme.fg('success', truncateToWidth(` ${this.notice}`, width)));
    if (this.composing) {
      bottom.push(this.theme.fg('warning', truncateToWidth(this.sending ? ' Sending direction… · Esc back' : ` Steer task ${this.composeRun} · Enter send · Esc back`, width)));
      this.input.focused = this.focused;
      bottom.push(...this.input.render(width));
    } else bottom.push(this.theme.fg('muted', truncateToWidth(` ↑↓ scroll · End latest · O tool output · I inherited${run.status === 'running' ? ' · S steer' : ''} · Esc back`, width)));
    const rows = Math.max(1, this.rows());
    const border = this.theme.fg('borderAccent', '─'.repeat(width));
    const footerLimit = Math.max(1, rows - 1);
    if (bottom.length > footerLimit && (this.failure || this.loadFailure || this.notice)) bottom.splice(1, 1);
    const footer = [border, ...bottom].slice(-footerLimit);
    const top = [truncateToWidth(header, width), this.theme.fg('muted', truncateToWidth(meta, width)), border]
      .slice(0, Math.max(0, rows - footer.length - 1));
    const height = Math.max(0, rows - top.length - footer.length);
    this.viewportHeight = height;
    const maxOffset = Math.max(0, body.length - height);
    this.offset = this.follow ? maxOffset : Math.min(this.offset, maxOffset);
    const content = body.slice(this.offset, this.offset + height);
    while (content.length < height) content.push('');
    return [...top, ...content, ...footer].map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
  }
  invalidate(): void { this.bodies.clear(); }
  dispose(): void { this.disposed = true; clearInterval(this.timer); }
}
