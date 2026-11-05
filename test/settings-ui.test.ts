import { expect, test, vi } from 'vitest';
import { initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Input, TuiMainScreen, stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { SubagentSettingsEditor } from '../src/settings-ui.ts';
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from '../src/config.ts';

initTheme('dark', false);
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
const models = [{ id: 'current', thinking: ['off'] as const }, { id: 'local/reasoning', thinking: ['off', 'low', 'high'] as const }];
const text = (view: SubagentSettingsEditor) => view.render(120).map(stripTerminalSequences).join('\n');
const down = (view: SubagentSettingsEditor, count: number) => { for (let i = 0; i < count; i++) view.handleInput('\x1b[B'); };
const chooseNext = (view: SubagentSettingsEditor) => { view.handleInput('\r'); view.handleInput('\x1b[B'); view.handleInput('\r'); };

test('every setting is edited with pickers or a validated number input and saved without JSON', async () => {
  const saved: SubagentSettings[] = [];
  const view = new SubagentSettingsEditor({ ...DEFAULT_SUBAGENT_SETTINGS }, models, theme, async value => { saved.push(value); }, () => {}, () => {}, () => 40);
  try {
    chooseNext(view); // indicator position
    down(view, 1); chooseNext(view); // model
    down(view, 1); chooseNext(view); // effort: inherit -> off
    down(view, 1); chooseNext(view); // context
    down(view, 1); chooseNext(view); // workspace
    for (const value of ['3', '2', '40', '900']) {
      down(view, 1); view.handleInput('\r'); view.handleInput('\x15'); view.handleInput(value); view.handleInput('\r');
    }
    await vi.waitFor(() => expect(saved).toHaveLength(9));
    expect(saved.at(-1)).not.toHaveProperty('indicatorAnimation');
    expect(saved.at(-1)).toMatchObject({ indicatorPosition: 'status', model: 'local/reasoning', thinking: 'off',
      context: 'fork', isolation: 'worktree', maxConcurrent: 3, maxDepth: 2, maxTurns: 40, timeoutSeconds: 900 });
    expect(text(view)).toContain('Saved'); expect(text(view)).not.toContain('"maxConcurrent"');
    for (const width of [0, 1, 10, 80]) expect(view.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  } finally { view.dispose(); }
});

test('invalid numeric edits stay in the field and Escape cancels that field', async () => {
  const save = vi.fn(async () => {});
  const view = new SubagentSettingsEditor({ ...DEFAULT_SUBAGENT_SETTINGS }, models, theme, save, () => {}, () => {}, () => 40);
  try {
    down(view, 5); view.handleInput('\r'); view.handleInput('\x15'); view.handleInput('0'); view.handleInput('\r');
    expect(text(view)).toContain('whole number from 1 to 16'); expect(save).not.toHaveBeenCalled();
    view.handleInput('\x1b'); expect(text(view)).toContain('Parallel agents'); expect(save).not.toHaveBeenCalled();
    view.handleInput('\r'); view.handleInput('\x15'); view.handleInput('16'); view.handleInput('\r');
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 16 })));
  } finally { view.dispose(); }
});

test('failed saves retain displayed edits and can retry before closing', async () => {
  let failed = true, closed = 0;
  const save = vi.fn(async () => { if (failed) throw new Error('Disk unavailable'); });
  const view = new SubagentSettingsEditor({ ...DEFAULT_SUBAGENT_SETTINGS }, models, theme, save, () => { closed++; }, () => {}, () => 40);
  try {
    chooseNext(view); await vi.waitFor(() => expect(text(view)).toContain('Disk unavailable'));
    view.handleInput('\x1b'); await Promise.resolve(); expect(closed).toBe(0);
    expect(text(view)).toContain('Extension status row');
    failed = false; view.handleInput('\x1b[A'); view.handleInput('\r');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    view.handleInput('\x1b'); await vi.waitFor(() => expect(closed).toBe(1));
  } finally { view.dispose(); }
});

test('rapid edits serialize writes and Escape waits for the final save', async () => {
  let release!: () => void, closed = false;
  const completed: SubagentSettings[] = [], gate = new Promise<void>(resolve => { release = resolve; });
  const save = vi.fn(async (value: SubagentSettings) => { await gate; completed.push(value); });
  const view = new SubagentSettingsEditor({ ...DEFAULT_SUBAGENT_SETTINGS }, models, theme, save, () => { closed = true; }, () => {});
  try {
    chooseNext(view); down(view, 1); chooseNext(view); view.handleInput('\x1b');
    await Promise.resolve(); expect(closed).toBe(false); expect(save).toHaveBeenCalledTimes(1);
    release(); await vi.waitFor(() => expect(closed).toBe(true));
    expect(completed).toHaveLength(2); expect(completed.at(-1)?.model).toBe('local/reasoning');
  } finally { release?.(); view.dispose(); }
});

test('model selection offers configured models and resets unsupported effort to inheritance', async () => {
  const saved: SubagentSettings[] = [];
  const view = new SubagentSettingsEditor({ ...DEFAULT_SUBAGENT_SETTINGS, model: 'local/reasoning', thinking: 'high' }, models, theme,
    async value => { saved.push(value); }, () => {}, () => {}, () => 40);
  try {
    down(view, 1); view.handleInput('\r'); view.handleInput('\x1b[A'); view.handleInput('\r');
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ model: 'current', thinking: 'current' });
  } finally { view.dispose(); }
});

test('native TUI settings retain input focus and restore the parent draft when closed', async () => {
  let send!: (data: string) => void;
  let rows = 32, columns = 100;
  const terminal: Terminal = { get rows() { return rows; }, get columns() { return columns; }, kittyProtocolActive: false,
    start: onInput => { send = onInput; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const tui = new TuiMainScreen(terminal, true), parent = new Input(); parent.handleInput('Keep parent draft');
  const saved: SubagentSettings[] = [];
  const view = new SubagentSettingsEditor({ ...DEFAULT_SUBAGENT_SETTINGS }, models, theme, async settings => { saved.push(settings); },
    () => { tui.clear(); tui.addChild(parent); tui.setFocus(parent); }, () => tui.requestRender(), () => terminal.rows);
  tui.addChild(view); tui.setFocus(view); tui.start();
  const frame = () => { tui.renderNow(); return tui.captureRenderState().previousLines.map(stripTerminalSequences).join('\n'); };
  try {
    for (let i = 0; i < 5; i++) send('\x1b[B'); send('\r');
    expect(frame()).toContain('Ctrl+U replace');
    send('\x15'); send('6'); send('\r');
    await vi.waitFor(() => expect(saved[0]?.maxConcurrent).toBe(6));
    rows = 18; columns = 60;
    expect(frame()).toContain('Parallel agents');
    send('\x1b'); await vi.waitFor(() => expect(tui.getFocusedComponent()).toBe(parent));
    expect(frame()).toContain('Keep parent draft'); expect(parent.getValue()).toBe('Keep parent draft');
  } finally { view.dispose(); tui.stop(); }
});
