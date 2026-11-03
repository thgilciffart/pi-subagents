import { Key, matchesKey, stripTerminalSequences, Text, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { isRunning, type RunSnapshot } from './runtime.ts';

export function oneLine(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatSubagentStatus(runs: RunSnapshot[]): string | undefined {
  const active = runs.filter(isRunning);
  if (!active.length) return undefined;
  const names = active.slice(0, 3).map(run => `${oneLine(run.agent).slice(0, 20)}${run.activity ? `:${oneLine(run.activity)}` : ''}`).join(', ');
  return `Agents ${active.length} · ${names}${active.length > 3 ? ` +${active.length - 3}` : ''} · /agents`;
}

export function compactText(value: string): Component {
  return { render: width => width > 0 ? [truncateToWidth(value.replace(/[\r\n]/g, ' '), width)] : [], invalidate: () => {} };
}

export function runSummary(run: RunSnapshot): string {
  return `${run.id} ${run.agent} · ${run.status} · ${run.toolCalls} tools${run.error ? ` · ${oneLine(run.error)}` : ''}`;
}

/** Opens only on request. The ordinary conversation has no per-child panels. */
export class SubagentInspector implements Component {
  private offset = 0;
  private height: number;
  private timer: ReturnType<typeof setInterval>;
  constructor(private title: string, private content: () => string, private done: () => void,
    requestRender: () => void, rows = 24) {
    this.height = Math.max(1, rows - 5);
    this.timer = setInterval(requestRender, 500);
    this.timer.unref();
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data === 'q') this.done();
    else if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down)) this.offset++;
    else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.height);
    else if (matchesKey(data, Key.pageDown)) this.offset += this.height;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const content = stripTerminalSequences(this.content()).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    const lines = new Text(content, 0, 0).render(width);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - this.height));
    return [truncateToWidth(oneLine(this.title), width), ...lines.slice(this.offset, this.offset + this.height),
      truncateToWidth('↑↓ scroll · PgUp/PgDn · Esc close', width)];
  }
  invalidate(): void {}
  dispose(): void { clearInterval(this.timer); }
}
