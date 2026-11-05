import { Input, Key, SelectList, SettingsList, matchesKey, truncateToWidth, type Component, type SettingItem } from '@earendil-works/pi-tui';
import { getSelectListTheme, getSettingsListTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { DEFAULT_SUBAGENT_SETTINGS, validateSubagentSettings, type SubagentSettings } from './config.ts';
import { type Thinking } from './agents.ts';
import { oneLine } from './ui.ts';

export type SettingsModel = { id: string; thinking: readonly Thinking[] };
type Field = keyof SubagentSettings;
type Choice = { value: string; label: string };
const numeric = { maxConcurrent: 16, maxDepth: 8, maxTurns: 100, timeoutSeconds: 3600 } as const;
const labels: Record<Field, string> = { indicatorPosition: 'Indicator position', indicatorAnimation: 'Indicator animation',
  model: 'Default model', thinking: 'Default thinking', context: 'Conversation context', isolation: 'Workspace',
  maxConcurrent: 'Parallel agents', maxDepth: 'Delegation depth', maxTurns: 'Model request limit', timeoutSeconds: 'Task timeout (seconds)' };
const descriptions: Record<Field, string> = {
  indicatorPosition: 'Place the shared indicator at the right of the first footer line or in the extension status row.',
  indicatorAnimation: 'Animate while agents work. Paused agents stay still; completion and failure appear briefly.',
  model: 'Default for new children. The parent can override this for each task. Agent definitions can set their own default.',
  thinking: 'Effort for new children. Inherit uses a supported parent level. Launch overrides take precedence.',
  context: 'Start with a fresh conversation or fork the parent model-visible history.',
  isolation: 'Use the shared directory or create a separate Git worktree for a new child.',
  maxConcurrent: 'Maximum active children across the entire delegation tree. Range: 1 to 16.',
  maxDepth: 'Maximum delegation layers, including top-level children. Range: 1 to 8.',
  maxTurns: 'Maximum model requests per task, including compaction and recovery. Range: 1 to 100.',
  timeoutSeconds: 'Task deadline includes downtime and paused recovery. Range: 1 to 3600 seconds.',
};

class NumberSetting implements Component {
  private input = new Input();
  private error = '';
  focused = true;
  constructor(private field: keyof typeof numeric, value: string, private theme: Theme, done: (value?: string) => void) {
    this.input.handleInput(value);
    this.input.onEscape = () => done();
    this.input.onSubmit = value => {
      const number = Number(value.trim());
      if (!/^\d+$/.test(value.trim()) || !Number.isInteger(number) || number < 1 || number > numeric[field]) {
        this.error = `Enter a whole number from 1 to ${numeric[field]}.`; return;
      }
      done(String(number));
    };
  }
  handleInput(data: string): void { this.input.handleInput(data); }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return [this.theme.fg('accent', labels[this.field]), '', ...this.input.render(width),
      this.theme.fg(this.error ? 'error' : 'muted', this.error || 'Ctrl+U replace · Enter apply · Esc back')].map(line => truncateToWidth(line, width));
  }
  invalidate(): void { this.input.invalidate(); }
}

class ChoiceSetting implements Component {
  private input = new Input({ placeholder: 'Search choices…' });
  private list: SelectList;
  focused = true;
  constructor(private title: string, choices: Choice[], current: string, private theme: Theme, done: (value?: string) => void, rows: number) {
    this.list = new SelectList(choices.map(item => ({ ...item, label: oneLine(item.label) })), Math.max(1, Math.min(10, rows - 10)), getSelectListTheme());
    this.list.setSelectedIndex(Math.max(0, choices.findIndex(item => item.value === current)));
    this.list.onSelect = item => done(item.value); this.list.onCancel = () => done();
    this.input.onEscape = () => done();
  }
  handleInput(data: string): void {
    if ([Key.up, Key.down, Key.enter, Key.escape, Key.pageUp, Key.pageDown].some(key => matchesKey(data, key))) this.list.handleInput(data);
    else { this.input.handleInput(data); this.list.setFilter(this.input.getValue()); }
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return [this.theme.fg('accent', this.title), ...this.input.render(width), '', ...this.list.render(width),
      this.theme.fg('muted', '↑↓ choose · Enter apply · Esc back')].map(line => truncateToWidth(line, width));
  }
  invalidate(): void { this.list.invalidate(); this.input.invalidate(); }
}

/** Native Pi settings controls. Writes are serialized and failures keep the draft visible. */
export class SubagentSettingsEditor implements Component {
  focused = true;
  private draft: SubagentSettings;
  private list: SettingsList;
  private items: SettingItem[];
  private tail: Promise<void> = Promise.resolve();
  private saving = 0;
  private closing = false;
  private disposed = false;
  private message: string;
  private failed = false;
  private warning: string;
  private submenus = new Set<{ focused: boolean }>();
  private selected = 'indicatorPosition';
  private submenuOpen = false;
  private visible = 1;
  constructor(settings: SubagentSettings, private models: SettingsModel[], private theme: Theme,
    private save: (settings: SubagentSettings) => Promise<void>, private done: () => void, private draw: () => void,
    private rows: () => number = () => 24, warning = '') {
    this.draft = { ...settings }; this.warning = warning; this.message = '';
    this.items = (Object.keys(labels) as Field[]).map(id => ({ id, label: labels[id], description: descriptions[id],
      currentValue: this.display(id), submenu: (_value, close) => {
        this.submenuOpen = true;
        const back = (value?: string) => { this.submenuOpen = false; this.submenus.clear(); close(value); };
        const submenu = Object.hasOwn(numeric, id) ? new NumberSetting(id as keyof typeof numeric, String(this.draft[id]), theme, back) :
          new ChoiceSetting(labels[id], this.choices(id), String(this.draft[id]), theme, back, rows());
        this.submenus.clear(); this.submenus.add(submenu); return submenu;
      } }));
    this.items.push({ id: 'save', label: 'Save settings', currentValue: 'Enter', values: ['Save'], description: 'Save the displayed values, including repaired defaults or a previous failed save.' });
    this.list = this.createList();
  }
  private createList(): SettingsList {
    this.visible = Math.max(1, Math.min(this.items.length, this.rows() - 10));
    const list = new SettingsList(this.items, this.visible, getSettingsListTheme(),
      (id, value) => this.change(id, value), () => { void this.close(); });
    list.selectItem(this.selected); return list;
  }
  private choices(field: Field): Choice[] {
    if (field === 'model') return [{ value: 'current', label: 'Inherit parent' }, ...this.models.filter(item => item.id !== 'current').map(item => ({ value: item.id, label: item.id }))];
    if (field === 'thinking') {
      const available = this.models.find(item => item.id === this.draft.model)?.thinking ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      return [{ value: 'current', label: 'Inherit parent' }, ...available.map(value => ({ value, label: value }))];
    }
    const options: Partial<Record<Field, Choice[]>> = {
      indicatorPosition: [{ value: 'footer-right', label: 'First footer line · right' }, { value: 'status', label: 'Extension status row' }],
      indicatorAnimation: [{ value: 'true', label: 'Animated' }, { value: 'false', label: 'Static' }],
      context: [{ value: 'fresh', label: 'Fresh conversation' }, { value: 'fork', label: 'Fork parent context' }],
      isolation: [{ value: 'shared', label: 'Shared directory' }, { value: 'worktree', label: 'Isolated Git worktree' }],
    };
    return options[field] ?? [];
  }
  private display(field: Field): string { return oneLine(this.choices(field).find(item => item.value === String(this.draft[field]))?.label ?? String(this.draft[field])); }
  private change(id: string, value: string): void {
    this.submenus.clear();
    if (id !== 'save') {
      this.draft = validateSubagentSettings({ ...this.draft, [id]: Object.hasOwn(numeric, id) ? Number(value) : id === 'indicatorAnimation' ? value === 'true' : value });
      if (id === 'model' && !this.choices('thinking').some(choice => choice.value === this.draft.thinking)) this.draft.thinking = 'current';
      for (const item of this.items) if (item.id !== 'save') this.list.updateValue(item.id, this.display(item.id as Field));
    } else this.list.updateValue('save', 'Enter');
    const snapshot = { ...this.draft }; this.saving++; this.message = 'Saving…'; this.failed = false;
    this.tail = this.tail.then(async () => {
      try { await this.save(snapshot); this.message = 'Saved'; this.failed = false; this.warning = ''; }
      catch (error) { this.message = oneLine(error instanceof Error ? error.message : String(error)); this.failed = true; }
      finally { this.saving--; if (!this.disposed) this.draw(); }
    });
    this.draw();
  }
  private async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true; await this.tail;
    this.closing = false;
    if (this.disposed) return;
    if (this.failed) { this.message += ' · Enter Save settings to retry.'; this.draw(); return; }
    this.done();
  }
  handleInput(data: string): void {
    if (this.closing || this.disposed) return;
    if (matchesKey(data, Key.ctrl('c'))) { void this.close(); return; }
    if (!this.submenuOpen && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      const index = this.items.findIndex(item => item.id === this.selected), direction = matchesKey(data, Key.up) ? -1 : 1;
      this.selected = this.items[(index + direction + this.items.length) % this.items.length].id;
    }
    this.list.handleInput(data); this.draw();
  }
  render(width: number): string[] {
    if (width < 1 || !this.focused) return [];
    if (!this.submenuOpen && this.visible !== Math.max(1, Math.min(this.items.length, this.rows() - 10))) this.list = this.createList();
    for (const submenu of this.submenus) submenu.focused = this.focused;
    const header = [this.theme.bold(this.theme.fg('text', 'Subagent settings')), this.theme.fg('muted', 'Defaults for new children · display changes apply immediately'), ''];
    if (this.warning) header.push(this.theme.fg('warning', oneLine(this.warning)));
    const status = this.saving ? 'Saving…' : this.message || 'Changes save automatically · Esc back';
    const height = Math.max(1, this.rows() - 4), top = header.slice(0, Math.max(0, height - 2));
    const body = this.list.render(Math.max(4, width)).slice(0, Math.max(0, height - top.length - 1));
    return [...top, ...body, this.theme.fg(this.failed ? 'error' : 'muted', status)].map(line => truncateToWidth(line, width));
  }
  invalidate(): void { this.list.invalidate(); }
  dispose(): void { this.disposed = true; }
}
