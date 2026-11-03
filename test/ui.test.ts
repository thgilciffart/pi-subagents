import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { editorPickerShortcut, formatSubagentStatus, footerRow, subagentFooter, SUBAGENT_SHORTCUT } from '../src/ui.ts';

test('the compact indicator uses Subagents and the picker shortcut', () => {
  expect(SUBAGENT_SHORTCUT).toBe('shift+left');
  expect(formatSubagentStatus([{ status: 'running' }, { status: 'completed' }] as any)).toBe('Subagents 1 · Shift+←');
  expect(formatSubagentStatus([])).toBeUndefined();
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
  const statuses = new Map([['pi-subagents', 'Subagents 2 · Shift+←'], ['another-extension', 'Other extension status']]);
  let disposed = false;
  const manager = SessionManager.inMemory('/project');
  const ctx = { cwd: '/project', sessionManager: manager, model: { id: 'local-model', contextWindow: 10000 }, thinkingLevel: 'high', getContextUsage: () => ({ percent: 12.5, contextWindow: 10000 }) } as any;
  const footer = subagentFooter(() => ctx, { getGitBranch: () => 'main', getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1, onBranchChange: () => () => { disposed = true; } }, theme as any, () => {}, () => true);
  try {
    const rows = footer.render(100).map(stripTerminalSequences);
    expect(rows[0]).toContain('/project (main)');
    expect(rows[0].endsWith('Subagents 2 · Shift+←')).toBe(true);
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
