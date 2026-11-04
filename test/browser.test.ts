import { expect, test, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { SubagentBrowser, taskCategory, taskTrees } from '../src/browser.ts';
import type { RunSnapshot } from '../src/runtime.ts';

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const run = (id: string, extra: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id, agent: 'Explore', task: `Investigate task ${id}`, run: 1, status: 'running', model: 'local/fixture', thinking: 'high',
  tools: ['read'], startedAt: 1000, turns: 2, toolCalls: 1, output: '', tokens: 2300, cost: 0.001,
  receipt: `parent:${id}:1`, delivered: false, cwd: '/project', ...extra,
});
const runs = () => [run('1'), run('2', { parentChildId: '1', status: 'completed' }), run('3', { status: 'completed' }),
  run('4', { status: 'failed', error: 'Check failed' }), run('5', { status: 'cancelled' })];

test('categories keep descendants under their owning task and tolerate missing or cyclic owners', () => {
  const trees = taskTrees(runs());
  expect(trees).toHaveLength(4);
  expect(trees[0].children[0].run.id).toBe('2');
  expect(trees.map(taskCategory)).toEqual(['Running', 'Completed', 'Needs attention', 'Cancelled']);
  expect(taskCategory(taskTrees([run('1', { status: 'completed' }), run('2', { parentChildId: '1', status: 'failed' })])[0])).toBe('Needs attention');
  expect(taskTrees([run('9', { parentChildId: 'missing' })])).toHaveLength(1);
  expect(taskTrees([run('1', { run: 2 }), run('2', { parentChildId: '1', parentRun: 1, status: 'completed' })])).toHaveLength(2);
  expect(taskTrees([run('1', { parentChildId: '2' }), run('2', { parentChildId: '1' })])).toHaveLength(2);
});

test('the browser renders categorized task trees and expands sanitized details within the terminal width', () => {
  const browser = new SubagentBrowser(runs(), async () => [], theme, () => {}, () => {}, () => 45, () => 5000);
  try {
    let rows = browser.render(160);
    expect(rows.join('\n')).toContain('Running · 1 task · 2 agents');
    expect(rows.join('\n')).toContain('Needs attention');
    expect(rows.join('\n')).toContain('Completed');
    expect(rows.join('\n')).toContain('Cancelled');
    expect(rows.some(row => / {4}└─ ▸ #2/.test(row))).toBe(true);
    expect(rows.join('\n')).not.toContain('local/fixture');
    browser.handleInput('\x1b[C');
    rows = browser.render(160);
    expect(rows.join('\n')).toContain('local/fixture · thinking high');
    expect(rows.join('\n')).toContain('2.3k tokens');
    expect(rows.join('\n')).toContain('Workspace: /project');
    expect(rows.join('\n')).toContain('4.0s');
    for (const width of [0, 1, 10, 40, 80]) expect(browser.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
  } finally { browser.dispose(); }
});

test('sections collapse and expand while transcript navigation follows the selected child', () => {
  let action: string | undefined;
  const browser = new SubagentBrowser(runs(), async () => [], theme, value => { action = value; }, () => {}, () => 45);
  try {
    browser.render(120);
    browser.handleInput('\x1b[A'); // The category above the selected root.
    browser.handleInput('\x1b[D');
    expect(browser.render(120).join('\n')).not.toContain('#2 Explore');
    browser.handleInput('\x1b[C');
    expect(browser.render(120).join('\n')).toContain('#2 Explore');
    browser.handleInput('\x1b[B'); browser.handleInput('\x1b[B');
    browser.handleInput('t'); expect(action).toBe('2');
    browser.handleInput('S'); expect(action).toBe('steer:2');
    browser.handleInput('\r'); expect(action).toBe('2');
    browser.handleInput('\x1b[F'); browser.handleInput('\r'); expect(action).toBe('resume');
    browser.handleInput('\x1b[1;2D'); expect(action).toBeUndefined();
  } finally { browser.dispose(); }
});

test('nested siblings keep continuous connectors and only root tasks receive spacing', () => {
  const browser = new SubagentBrowser([run('1'), run('2', { parentChildId: '1' }), run('3', { parentChildId: '1' }), run('4')],
    async () => [], theme, () => {}, () => {}, () => 60);
  try {
    const rows = browser.render(140);
    const child = rows.findIndex(row => row.includes('├─ ▸ #2'));
    const sibling = rows.findIndex(row => row.includes('└─ ▸ #3'));
    expect(child).toBeGreaterThan(0); expect(sibling).toBeGreaterThan(child);
    expect(rows.slice(child, sibling).every(row => row.trim())).toBe(true);
    const nextRoot = rows.findIndex(row => row.includes('▸ #4'));
    expect(rows[nextRoot - 1].trim()).toBe(''); expect(rows[nextRoot - 2].trim()).not.toBe('');
  } finally { browser.dispose(); }
});

test('a live status change preserves selection when a task moves categories', async () => {
  let action = '';
  const browser = new SubagentBrowser([run('1'), run('3')], async () => [run('1', { status: 'completed' }), run('3')],
    theme, value => { action = value ?? ''; }, () => {});
  try {
    browser.render(120); await browser.refresh();
    expect(browser.render(120).join('\n')).toContain('Completed');
    browser.handleInput('t'); expect(action).toBe('1');
  } finally { browser.dispose(); }
});

test('live reads run only while the browser is open and never overlap', async () => {
  vi.useFakeTimers();
  let reads = 0, rendered = 0, release!: (runs: RunSnapshot[]) => void;
  const browser = new SubagentBrowser([], () => { reads++; return new Promise(resolve => { release = resolve; }); }, theme,
    () => {}, () => { rendered++; });
  try {
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(reads).toBe(1);
    browser.dispose(); release(runs());
    await vi.advanceTimersByTimeAsync(1500);
    expect(reads).toBe(1); expect(rendered).toBe(0);
  } finally { browser.dispose(); vi.useRealTimers(); }
});

test('large lists remain scrollable and empty sessions keep management actions available', () => {
  let action = '';
  const browser = new SubagentBrowser(Array.from({ length: 60 }, (_, index) => run(String(index + 1))), async () => [], theme,
    value => { action = value ?? ''; }, () => {}, () => 16);
  try {
    expect(browser.render(80).length).toBeLessThanOrEqual(16);
    browser.handleInput('\x1b[F');
    expect(browser.render(80).join('\n')).toContain('Resume unfinished tasks');
    browser.handleInput('\r'); expect(action).toBe('resume');
  } finally { browser.dispose(); }
  const empty = new SubagentBrowser([], async () => [], theme, () => {}, () => {});
  try { expect(empty.render(120).join('\n')).toContain('No subagents yet'); }
  finally { empty.dispose(); }
});
