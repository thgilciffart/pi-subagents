import { Key, matchesKey, stripTerminalSequences, Text, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { CustomEditor, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { relative, isAbsolute, sep } from 'node:path';
import { isRunning, type RunSnapshot } from './runtime.ts';

export const cleanText = (value: string): string => stripTerminalSequences(value).replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export function oneLine(value: string): string { return cleanText(value).replace(/\s+/g, ' ').trim(); }

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function formatSubagentStatus(runs: RunSnapshot[], frame?: number): string | undefined {
  const active = runs.filter(isRunning);
  if (!active.length) return undefined;
  const paused = active.filter(run => run.recoveryError).length;
  const counts = new Map<string, number>();
  for (const run of active) {
    const state = run.recoveryError ? 'paused' : run.activity?.startsWith('tool:') ? 'tools' : run.activity ?? (run.status === 'starting' ? 'starting' : 'working');
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const icon = paused === active.length ? 'Ⅱ' : frame === undefined ? '●' : frames[frame % frames.length];
  return `${icon} Subagents ${active.length} · ${[...counts].map(([state, count]) => `${state} ${count}`).join(' · ')}`;
}

/** Animation uses cached summaries. It performs no runtime reads or writes. */
export class SubagentIndicator {
  private runs: RunSnapshot[] = [];
  private previous = new Map<string, boolean>();
  private frame = 0;
  private animated = true;
  private timer?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  private terminal?: string;
  constructor(private publish: (text: string | undefined) => void) {}
  setAnimated(animated: boolean): void { this.animated = animated; this.redraw(); }
  update(runs: RunSnapshot[]): void {
    const finished = runs.filter(run => this.previous.get(run.receipt) && !isRunning(run));
    this.previous = new Map(runs.map(run => [run.receipt, isRunning(run)])); this.runs = runs;
    if (finished.length) {
      clearTimeout(this.expiry);
      const failed = finished.filter(run => run.status === 'failed').length, cancelled = finished.filter(run => run.status === 'cancelled').length;
      this.terminal = failed ? `✗ Subagents · ${failed} failed` : cancelled ? `⊘ Subagents · ${cancelled} cancelled` : `✓ Subagents · ${finished.length} completed`;
      this.expiry = setTimeout(() => { this.terminal = undefined; this.redraw(); }, 3500); this.expiry.unref();
    }
    this.redraw();
  }
  private redraw(): void {
    const moving = this.animated && this.runs.some(run => isRunning(run) && !run.recoveryError);
    if (moving && !this.timer) { this.timer = setInterval(() => { this.frame++; this.draw(); }, 120); this.timer.unref(); }
    else if (!moving && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.draw();
  }
  private draw(): void { this.publish(formatSubagentStatus(this.runs, this.animated ? this.frame : undefined) ?? this.terminal); }
  dispose(): void { clearInterval(this.timer); clearTimeout(this.expiry); this.timer = undefined; this.expiry = undefined; this.runs = []; this.previous.clear(); this.terminal = undefined; }
}

export const SUBAGENT_SHORTCUT = 'shift+left';

type EditorFactory = NonNullable<Parameters<ExtensionContext['ui']['setEditorComponent']>[0]>;

/** Intercept only input delivered to the composer, leaving dialogs and typed text alone. */
export function editorPickerShortcut(open: (context: ExtensionContext) => Promise<void>, report: (error: unknown) => void) {
  let installed: { factory: EditorFactory; previous?: EditorFactory; enabled: boolean } | undefined;
  let opening = false;
  function dispose(context: ExtensionContext): void {
    if (!installed) return;
    installed.enabled = false;
    if (context.ui.getEditorComponent() === installed.factory) context.ui.setEditorComponent(installed.previous);
    installed = undefined;
  }
  function install(context: ExtensionContext): void {
    if (!context.hasUI || context.mode !== 'tui') return;
    dispose(context);
    const previous = context.ui.getEditorComponent();
    const current: NonNullable<typeof installed> = { previous, enabled: true, factory: (tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = data => {
        if (current.enabled && matchesKey(data, SUBAGENT_SHORTCUT)) {
          if (!opening) {
            opening = true;
            void Promise.resolve().then(() => current.enabled ? open(context) : undefined).catch(report).finally(() => { opening = false; });
          }
          return;
        }
        handleInput(data);
      };
      return editor;
    } };
    installed = current;
    context.ui.setEditorComponent(current.factory);
  }
  return { install, dispose };
}

/** Keep the right-hand label visible, shortening the left side first. */
export function footerRow(left: string, right: string, width: number): string {
  if (width < 1) return '';
  if (!visibleWidth(right)) return truncateToWidth(left, width);
  const label = truncateToWidth(right, width);
  const space = Math.max(0, width - visibleWidth(label) - 2);
  const start = space ? truncateToWidth(left, space) : '';
  return start + ' '.repeat(Math.max(0, width - visibleWidth(start) - visibleWidth(label))) + label;
}

export function subagentFooter(context: () => ExtensionContext, data: ReadonlyFooterDataProvider, theme: Theme,
  render: () => void, autoCompact: () => boolean): Component & { dispose(): void } {
  const unsubscribe = data.onBranchChange(render);
  const count = (value: number) => value < 1000 ? String(value) : value < 1000000 ? `${Number((value / 1000).toFixed(1))}k` : `${Number((value / 1000000).toFixed(1))}M`;
  let cacheKey = '', totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHit: number | undefined, lastModel: { provider: string; model: string } | undefined;
  return {
    dispose: unsubscribe, invalidate() {},
    render(width) {
      if (width < 1) return [];
      const ctx = context(), session = ctx.sessionManager;
      const key = `${session.getSessionId()}:${session.getLeafId()}:${session.getEntries().length}`;
      if (cacheKey !== key) {
        cacheKey = key; totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; cacheHit = undefined; lastModel = undefined;
        for (const entry of session.getEntries()) {
          const usage = entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage :
            entry.type === 'message' && (entry.message.role === 'assistant' || entry.message.role === 'toolResult') ? entry.message.usage : undefined;
          if (!usage) continue;
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
            cacheHit = prompt ? usage.cacheRead / prompt * 100 : undefined;
            lastModel = entry.message;
          }
          for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) totals[field] += usage[field];
          totals.cost += usage.cost.total;
        }
      }
      const offset = relative(homedir(), ctx.cwd);
      const home = !offset || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
      let directory = home ? `~${offset ? sep + offset : ''}` : ctx.cwd;
      const branch = data.getGitBranch(), name = session.getSessionName();
      if (branch) directory += ` (${oneLine(branch)})`;
      if (name) directory += ` · ${oneLine(name)}`;
      const statuses = data.getExtensionStatuses();
      const first = footerRow(theme.fg('dim', oneLine(directory)), theme.fg('accent', statuses.get('pi-subagents') ?? ''), width);
      const usage = ctx.getContextUsage();
      const contextLabel = `${usage?.percent == null ? '?' : usage.percent.toFixed(1)}%/${count(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)}${autoCompact() ? ' (auto)' : ''}`;
      const runtime = (ctx.modelRegistry as unknown as { runtime?: { isUsingSubscription?: (provider: string) => boolean } } | undefined)?.runtime;
      const subscribed = ctx.model && (ctx.model.provider === 'kimi-coding' || runtime?.isUsingSubscription?.(ctx.model.provider));
      const stats = [`↑${count(totals.input)}`, `↓${count(totals.output)}`, `R${count(totals.cacheRead)}`, `W${count(totals.cacheWrite)}`,
        ...(cacheHit !== undefined && (totals.cacheRead || totals.cacheWrite) ? [`CH${cacheHit.toFixed(1)}%`] : []),
        `$${totals.cost.toFixed(3)}${subscribed ? ' (sub)' : ''}`,
        theme.fg((usage?.percent ?? 0) > 90 ? 'error' : (usage?.percent ?? 0) > 70 ? 'warning' : 'dim', contextLabel)].join(' ');
      let model = `${ctx.model?.id ?? 'no-model'}${ctx.model?.reasoning ? ` · ${ctx.thinkingLevel ?? 'off'}` : ''}`;
      if (ctx.model?.api === 'pi-virtual' && lastModel) model += ` → ${lastModel.provider}/${lastModel.model}`;
      if (ctx.model && data.getAvailableProviderCount() > 1) {
        const withProvider = `(${ctx.model.provider}) ${model}`;
        if (visibleWidth(stats) + visibleWidth(withProvider) + 2 <= width) model = withProvider;
      }
      const rows = [first, footerRow(theme.fg('dim', stats), theme.fg('dim', oneLine(model)), width)];
      const others = [...statuses].filter(([key]) => key !== 'pi-subagents').sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => {
        // Preserve extension colors, allowing only SGR sequences through the sanitizer.
        const colors: string[] = [];
        const text = value.replace(/\x1b\[[0-9;:]*m/g, color => { colors.push(color); return `\uE000${colors.length - 1}\uE001`; });
        return oneLine(text).replace(/\uE000(\d+)\uE001/g, (_match, index: string) => colors[Number(index)] ?? '');
      });
      if (others.length) rows.push(truncateToWidth(theme.fg('dim', others.join(' ')), width));
      return rows;
    },
  };
}

export function compactText(value: string): Component {
  return { render: width => width > 0 ? [truncateToWidth(value.replace(/[\r\n]/g, ' '), width)] : [], invalidate: () => {} };
}

export function runSummary(run: RunSnapshot): string {
  return `#${run.id} ${run.agent}${run.parentChildId ? ` · parent #${run.parentChildId}` : ''} · ${run.status} · ${run.toolCalls} tool calls${run.recoveryError ? ` · recovery paused: ${oneLine(run.recoveryError)}` : run.error ? ` · ${oneLine(run.error)}` : ''}`;
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
