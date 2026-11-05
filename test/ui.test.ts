import { expect, test, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { editorPickerShortcut, formatSubagentStatus, footerRow, subagentFooter, SUBAGENT_SHORTCUT, SubagentIndicator } from '../src/ui.ts';

test('the indicator shows only Subagents and the active count', () => {
  expect(SUBAGENT_SHORTCUT).toBe('shift+left');
  const runs = [{ status: 'running', activity: 'tool:read' }, { status: 'starting' }, { status: 'running', recoveryError: 'Trust required' },
    { status: 'running', parentChildId: '1' }, { status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }] as any;
  expect(formatSubagentStatus(runs)).toBe('Subagents 4');
  expect(formatSubagentStatus([{ status: 'completed' }] as any)).toBeUndefined();
  expect(formatSubagentStatus([])).toBeUndefined();
});

test('the indicator publishes count changes only, with no timers or completion flashes', () => {
  vi.useFakeTimers();
  const publish = vi.fn(), indicator = new SubagentIndicator(publish);
  const run = { id: '1', run: 1, receipt: 'parent:1:1', status: 'running', activity: 'thinking' } as any;
  try {
    indicator.update([run]); expect(publish.mock.calls).toEqual([['Subagents 1']]);
    expect(vi.getTimerCount()).toBe(0);
    indicator.update([{ ...run, activity: 'tool:read' }]); expect(publish).toHaveBeenCalledTimes(1);
    indicator.update([run, { ...run, id: '2', receipt: 'parent:2:1' }]); expect(publish.mock.lastCall).toEqual(['Subagents 2']);
    indicator.update([{ ...run, status: 'failed' }]); expect(publish.mock.lastCall).toEqual([undefined]);
    vi.advanceTimersByTime(5000); expect(publish).toHaveBeenCalledTimes(3);
    indicator.dispose(); indicator.update([]); expect(publish.mock.lastCall).toEqual([undefined]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { indicator.dispose(); vi.useRealTimers(); }
});

test('the picker shortcut preserves a custom editor and suppresses repeated openings', async () => {
  let value = ' ', opened = 0, release!: () => void;
  const forwarded: string[] = [];
  const editor = { getText: () => value, handleInput: (data: string) => forwarded.push(data), render: () => ['CUSTOM_EDITOR'] };
  const previous = () => editor;
  let factory: any = previous;
  const context = { hasUI: true, mode: 'tui', ui: { getEditorComponent: () => factory,
    setEditorComponent: (next: any) => { factory = next; next?.({}, {}, {}); } } } as any;
  const shortcut = editorPickerShortcut(async () => { opened++; await new Promise<void>(resolve => { release = resolve; }); }, error => { throw error; });
  shortcut.install(context);
  editor.handleInput('\x1b[1;3D');
  expect(forwarded).toEqual(['\x1b[1;3D']);
  expect(editor.render()).toEqual(['CUSTOM_EDITOR']);
  value = '';
  editor.handleInput('\x1b[1;2D'); editor.handleInput('\x1b[1;2D');
  await Promise.resolve();
  expect(opened).toBe(1);
  shortcut.dispose(context);
  expect(factory).toBe(previous);
  editor.handleInput('\x1b[1;2D');
  expect(forwarded).toHaveLength(2);
  release();
});

test('disposing before a queued key action prevents a stale picker', async () => {
  let opened = false;
  const editor = { getText: () => '', handleInput: (_data: string) => {} };
  const previous = () => editor;
  let factory: any = previous;
  const context = { hasUI: true, mode: 'tui', ui: { getEditorComponent: () => factory,
    setEditorComponent: (next: any) => { factory = next; next?.({}, {}, {}); } } } as any;
  const shortcut = editorPickerShortcut(async () => { opened = true; }, () => {});
  shortcut.install(context);
  editor.handleInput('\x1b[1;2D');
  const otherExtension = () => editor;
  factory = otherExtension;
  shortcut.dispose(context);
  await Promise.resolve();
  expect(factory).toBe(otherExtension);
  expect(opened).toBe(false);
});

test('footer rows preserve right alignment within narrow and wide terminals', () => {
  for (const width of [0, 1, 10, 40, 80]) {
    const row = footerRow('a very long working directory', 'Subagents 3', width);
    expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    if (width >= 12) expect(row.endsWith('Subagents 3')).toBe(true);
  }
});

test('the indicator occupies the first footer line and keeps other statuses and usage', () => {
  const theme = { fg: (_color: string, text: string) => text };
  const statuses = new Map([['pi-subagents', 'Subagents 2'], ['another-extension', 'Other extension status']]);
  let disposed = false;
  const manager = SessionManager.inMemory('/project');
  const ctx = { cwd: '/project', sessionManager: manager, model: { id: 'local-model', contextWindow: 10000 }, thinkingLevel: 'high', getContextUsage: () => ({ percent: 12.5, contextWindow: 10000 }) } as any;
  const footer = subagentFooter(() => ctx, { getGitBranch: () => 'main', getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1, onBranchChange: () => () => { disposed = true; } }, theme as any, () => {}, () => true);
  try {
    const rows = footer.render(100).map(stripTerminalSequences);
    expect(rows[0]).toContain('/project (main)');
    expect(rows[0].endsWith('Subagents 2')).toBe(true);
    expect(rows[1]).toContain('12.5%/10k (auto)');
    expect(rows[1]).toContain('local-model');
    expect(rows[2]).toBe('Other extension status');
    expect(rows.join('\n').match(/Subagents/g)).toHaveLength(1);
    for (const width of [0, 1, 10, 80]) expect(footer.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
    statuses.delete('pi-subagents');
    expect(footer.render(80).join('\n')).not.toContain('Subagents');
  } finally { footer.dispose(); }
  expect(disposed).toBe(true);
});

test('footer retains usage warnings, subscription and routing information, and safe status colors', () => {
  const manager = SessionManager.inMemory('/project');
  const message = fauxAssistantMessage('Answer');
  message.provider = 'physical'; message.model = 'physical-model';
  message.usage = { ...message.usage, input: 1000000, cacheRead: 1000000, output: 12, totalTokens: 2000012 };
  manager.appendMessage(message);
  let percent = 95;
  const theme = { fg: (name: string, text: string) => name === 'error' ? `\x1b[31m${text}\x1b[0m` : name === 'warning' ? `\x1b[33m${text}\x1b[0m` : text };
  const statuses = new Map([['other', '\x1b[32mColored status\x1b[0m\x1b]0;bad\x07']]);
  const ctx = { cwd: '/project', sessionManager: manager, model: { provider: 'virtual', id: 'router', api: 'pi-virtual', reasoning: true },
    modelRegistry: { runtime: { isUsingSubscription: () => true } }, thinkingLevel: 'high',
    getContextUsage: () => ({ percent, contextWindow: 2000000 }) } as any;
  const footer = subagentFooter(() => ctx, { getGitBranch: () => null, getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 2, onBranchChange: () => () => {} }, theme as any, () => {}, () => true);
  try {
    const rows = footer.render(240), plain = rows.map(stripTerminalSequences).join('\n');
    expect(plain).toContain('↑1M'); expect(plain).toContain('CH50.0%'); expect(plain).toContain('(sub)');
    expect(plain).toContain('(virtual) router · high → physical/physical-model');
    expect(rows[1]).toContain('\x1b[31m95.0%/2M (auto)');
    expect(rows[2]).toContain('\x1b[32mColored status'); expect(rows[2]).not.toContain('\x1b]');
    percent = 80; expect(footer.render(240)[1]).toContain('\x1b[33m80.0%');
    ctx.model.reasoning = false; expect(stripTerminalSequences(footer.render(240)[1])).not.toContain('· high');
  } finally { footer.dispose(); }
});
