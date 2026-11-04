import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { isRunning, type RunSnapshot } from './runtime.ts';
import { SUBAGENT_SHORTCUT } from './ui.ts';

type Category = 'Running' | 'Needs attention' | 'Completed' | 'Cancelled';
type TaskTree = { run: RunSnapshot; children: TaskTree[] };
type Row = { key?: string; text: string; color?: 'accent' | 'text' | 'muted' | 'dim' | 'error' | 'success' | 'warning'; run?: RunSnapshot; category?: Category; action?: string };
const categories: Category[] = ['Running', 'Needs attention', 'Completed', 'Cancelled'];

/** Group by saved ownership, keeping descendants with their root task. */
export function taskTrees(runs: RunSnapshot[]): TaskTree[] {
  const nodes = new Map(runs.map(run => [run.id, { run, children: [] as TaskTree[] }]));
  const roots: TaskTree[] = [];
  for (const node of nodes.values()) {
    const candidate = node.run.parentChildId ? nodes.get(node.run.parentChildId) : undefined;
    const parent = candidate && (node.run.parentRun === undefined || node.run.parentRun === candidate.run.run) ? candidate : undefined;
    const seen = new Set([node.run.id]);
    let ancestor = parent;
    while (ancestor && !seen.has(ancestor.run.id)) {
      seen.add(ancestor.run.id);
      ancestor = ancestor.run.parentChildId ? nodes.get(ancestor.run.parentChildId) : undefined;
    }
    if (parent && !ancestor) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
function flatten(tree: TaskTree): RunSnapshot[] { return [tree.run, ...tree.children.flatMap(flatten)]; }
export function taskCategory(tree: TaskTree): Category {
  const runs = flatten(tree);
  if (runs.some(isRunning)) return 'Running';
  if (runs.some(run => run.status === 'failed')) return 'Needs attention';
  return tree.run.status === 'cancelled' ? 'Cancelled' : 'Completed';
}
const tokens = (value: number) => value < 1000 ? String(value) : `${Number((value / 1000).toFixed(1))}k`;
const elapsed = (run: RunSnapshot, now: number) => `${Math.max(0, ((run.finishedAt ?? now) - run.startedAt) / 1000).toFixed(1)}s`;

/** A live component created only while the user has the browser open. */
export class SubagentBrowser implements Component {
  private selected = '';
  private offset = 0;
  private expanded = new Set<string>();
  private collapsed = new Set<Category>();
  private pending = false;
  private disposed = false;
  private error = '';
  private timer: ReturnType<typeof setInterval>;
  constructor(private runs: RunSnapshot[], private load: () => Promise<RunSnapshot[]>, private theme: Theme,
    private done: (action?: string) => void, private requestRender: () => void, private rows: () => number = () => 24,
    private now: () => number = Date.now) {
    this.timer = setInterval(() => { void this.refresh(); }, 500);
    this.timer.unref();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.pending) return;
    this.pending = true;
    try {
      const runs = await this.load();
      if (!this.disposed) { this.runs = runs; this.error = ''; }
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    } finally { this.pending = false; if (!this.disposed) this.requestRender(); }
  }
  private contents(): Row[] {
    const rows: Row[] = [];
    const trees = taskTrees(this.runs);
    const now = this.now();
    const add = (tree: TaskTree, prefix: string, connector: string) => {
      const run = tree.run, open = this.expanded.has(run.id);
      const descendants = flatten(tree).slice(1);
      const progress = descendants.length ? ` · ${descendants.filter(item => !isRunning(item)).length}/${descendants.length} children done` : '';
      const color = isRunning(run) ? 'accent' : run.status === 'failed' ? 'error' : run.status === 'completed' ? 'success' : 'dim';
      rows.push({ key: `run:${run.id}`, run, color, text: `${prefix}${connector}${open ? '▾' : '▸'} #${run.id} ${run.agent}${run.run > 1 ? ` · task ${run.run}` : ''} · ${run.status} · ${run.toolCalls} tool calls · ${elapsed(run, now)}${progress}` });
      const indent = prefix + (connector === '├─ ' ? '│  ' : connector ? '   ' : '');
      rows.push({ text: `${indent}  Task: ${run.task}`, color: 'text' });
      if (open) {
        rows.push({ text: `${indent}  ${run.model} · thinking ${run.thinking} · ${run.turns} requests · ${run.context ?? 'fresh'} context`, color: 'dim' });
        rows.push({ text: `${indent}  Conversation: ${tokens(run.tokens)} tokens · $${run.cost.toFixed(4)}${run.parentChildId ? ` · parent #${run.parentChildId}${run.parentRun ? ` task ${run.parentRun}` : ''}` : ''}`, color: 'dim' });
        if (run.cwd) rows.push({ text: `${indent}  Workspace: ${run.cwd}${run.worktree ? ` · ${run.worktree.branch}` : ''}`, color: 'dim' });
        if (run.activity) rows.push({ text: `${indent}  Current tool: ${run.activity}`, color: 'accent' });
        if (run.error) rows.push({ text: `${indent}  Error: ${run.error}`, color: 'error' });
        if (run.output) rows.push({ text: `${indent}  Result: ${run.output}`, color: 'dim' });
      }
      tree.children.forEach((child, index) => add(child, indent + '  ', index === tree.children.length - 1 ? '└─ ' : '├─ '));
    };
    for (const category of categories) {
      const group = trees.filter(tree => taskCategory(tree) === category);
      if (!group.length) continue;
      rows.push({ key: `group:${category}`, category, color: category === 'Needs attention' ? 'error' : category === 'Completed' ? 'success' : category === 'Cancelled' ? 'muted' : 'accent',
        text: `${this.collapsed.has(category) ? '▸' : '▾'} ${category} · ${group.length} ${group.length === 1 ? 'task' : 'tasks'} · ${group.flatMap(flatten).length} agents` });
      if (!this.collapsed.has(category)) group.forEach((tree, index) => {
        add(tree, '  ', '');
        if (index < group.length - 1) rows.push({ text: '' });
      });
      rows.push({ text: '' });
    }
    if (!trees.length) rows.push({ text: 'No subagents yet. Ask the parent to delegate a task.', color: 'dim' }, { text: '' });
    rows.push({ text: 'Manage', color: 'accent' },
      { key: 'action:list', text: 'Browse agent definitions', action: 'list' },
      { key: 'action:config', text: 'Edit settings', action: 'config' },
      { key: 'action:resume', text: 'Resume unfinished tasks', action: 'resume' });
    if (this.error) rows.push({ text: `Refresh failed: ${this.error}`, color: 'error' });
    return rows;
  }
  private selection(rows: Row[]): Row[] {
    const selectable = rows.filter(row => row.key);
    if (!selectable.some(row => row.key === this.selected)) this.selected = (selectable.find(row => row.run) ?? selectable[0])?.key ?? '';
    return selectable;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, SUBAGENT_SHORTCUT) || data === 'q') { this.done(); return; }
    const items = this.selection(this.contents());
    const index = items.findIndex(row => row.key === this.selected);
    const current = items[index];
    const height = Math.max(1, this.rows() - 8);
    if (matchesKey(data, Key.up)) this.selected = items[Math.max(0, index - 1)]?.key ?? '';
    else if (matchesKey(data, Key.down)) this.selected = items[Math.min(items.length - 1, index + 1)]?.key ?? '';
    else if (matchesKey(data, Key.pageUp)) this.selected = items[Math.max(0, index - Math.max(1, Math.floor(height / 2)))]?.key ?? '';
    else if (matchesKey(data, Key.pageDown)) this.selected = items[Math.min(items.length - 1, index + Math.max(1, Math.floor(height / 2)))]?.key ?? '';
    else if (matchesKey(data, Key.home)) this.selected = items[0]?.key ?? '';
    else if (matchesKey(data, Key.end)) this.selected = items.at(-1)?.key ?? '';
    else if ((data === 't' || matchesKey(data, Key.enter)) && current?.run) this.done(current.run.id);
    else if ((data === 's' || data === 'S') && current?.run) this.done(`steer:${current.run.id}`);
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || matchesKey(data, Key.left) || data === ' ') {
      const collapse = matchesKey(data, Key.left), expand = matchesKey(data, Key.right);
      if (current?.action && matchesKey(data, Key.enter)) this.done(current.action);
      else if (current?.run) {
        if (collapse || (!expand && this.expanded.has(current.run.id))) this.expanded.delete(current.run.id);
        else this.expanded.add(current.run.id);
      } else if (current?.category) {
        if (collapse || (!expand && !this.collapsed.has(current.category))) this.collapsed.add(current.category);
        else this.collapsed.delete(current.category);
      }
    }
    this.requestRender();
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const rows = this.contents(); this.selection(rows);
    const height = Math.max(1, this.rows() - 8);
    const selected = rows.findIndex(row => row.key === this.selected);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - height)));
    if (selected < this.offset) this.offset = selected;
    else if (selected >= this.offset + height) this.offset = selected - height + 1;
    const running = this.runs.filter(isRunning).length, completed = this.runs.filter(run => run.status === 'completed').length;
    const heading = `Subagents · ${running} running · ${completed} completed · ${this.runs.filter(run => run.status === 'failed').length} failed`;
    const visible = rows.slice(this.offset, this.offset + height).map(row => {
      const safe = stripTerminalSequences(row.text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
      const text = `${row.key === this.selected ? '→ ' : '  '}${safe}`;
      let content: string;
      if (row.run) {
        const marker = ` · ${row.run.status}`, at = text.indexOf(marker);
        content = this.theme.fg('text', this.theme.bold(text.slice(0, at))) + this.theme.fg(row.color ?? 'muted', marker) + this.theme.fg('muted', text.slice(at + marker.length));
      } else if (row.category) content = this.theme.bold(this.theme.fg(row.color ?? 'accent', text));
      else content = this.theme.fg(row.color ?? 'muted', text);
      content = truncateToWidth(content, width);
      return row.key === this.selected ? this.theme.bg('selectedBg', content + ' '.repeat(Math.max(0, width - visibleWidth(content)))) : content;
    });
    const range = rows.length > height ? ` · ${this.offset + 1}–${Math.min(rows.length, this.offset + height)}/${rows.length}` : '';
    return [this.theme.bold(this.theme.fg('text', truncateToWidth(heading, width))),
      this.theme.fg('borderAccent', '─'.repeat(width)), ...visible,
      this.theme.fg('borderAccent', '─'.repeat(width)),
      this.theme.fg('muted', truncateToWidth(`↑↓ navigate · Enter chat · → details · S steer · Esc back${range}`, width))];
  }
  invalidate(): void {}
  dispose(): void { this.disposed = true; clearInterval(this.timer); }
}
