import { expect, test, vi } from 'vitest';
import { initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Container, Input, ScrollView, Text, TuiAltScreen, TuiMainScreen, VStack, stripTerminalSequences, visibleWidth,
  type Component, type OverlayHandle, type Terminal } from '@earendil-works/pi-tui';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { chatItems, SubagentChat } from '../src/chat.ts';
import { SubagentBrowser } from '../src/browser.ts';
import type { ChildChatSnapshot } from '../src/runtime.ts';

initTheme('dark', false);
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const entry = (id: number, message: unknown, kind = 'pi.user') => ({ id, conversationId: 9, kind, model: [message] }) as unknown as EntryRecord;
const user = (text: string) => ({ role: 'user', content: text, timestamp: 1 });
const result = (text: string) => ({ role: 'toolResult', toolCallId: 'read', toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 1 });
const snapshot = (status = 'running'): ChildChatSnapshot => ({ run: { id: '9', agent: 'Explore', task: 'Inspect', status,
  run: 1, model: 'local/fixture', thinking: 'off', tools: ['read'], startedAt: 1, turns: 2, toolCalls: 1,
  output: '', tokens: 10, cost: 0, receipt: 'p:9:1', delivered: false } as any,
  entries: [entry(1, { role: 'system', content: 'PRIVATE_SYSTEM_INSTRUCTIONS' }), entry(2, user('Assigned task:\n\nInspect the code.')),
    entry(3, answer(fauxToolCall('read', { path: '/project/file.ts' }, { id: 'read' }), { stopReason: 'toolUse' }), 'pi.assistant'),
    entry(4, result('LARGE_TOOL_OUTPUT\n'.repeat(50)), 'pi.tool'),
    entry(5, answer('## Findings\n\nReadable **assistant** evidence.\n\n- One finding\n- Another finding'), 'pi.assistant')] });
const rendered = (chat: SubagentChat, width = 100) => chat.render(width).map(stripTerminalSequences).join('\n');

test('a real TUI reveals parent prompts and returns through the chat and browser to the parent draft', () => {
  let send!: (data: string) => void;
  const terminal: Terminal = { rows: 12, columns: 120, kittyProtocolActive: false,
    start: onInput => { send = onInput; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const tui = new TuiMainScreen(terminal, true), slot = new Container(), draft = new Input();
  draft.setValue('Keep my parent draft');
  tui.addChild(new Text('Parent conversation', 0, 0)); tui.addChild(slot); tui.addChild(new Text('Parent footer', 0, 0));
  slot.addChild(draft); tui.setFocus(draft);
  const view = snapshot();
  let browser: SubagentBrowser | undefined, chat: SubagentChat | undefined, handle: OverlayHandle | undefined;
  const frame = () => { tui.renderNow(); return tui.captureRenderState().previousLines.slice(-terminal.rows).map(stripTerminalSequences).join('\n'); };
  const restoreDraft = () => { slot.clear(); slot.addChild(draft); tui.setFocus(draft); };
  const openBrowser = () => {
    browser = new SubagentBrowser([view.run], async () => [view.run], theme, id => {
      browser?.dispose(); restoreDraft();
      if (id) {
        chat = new SubagentChat(view, async () => view, async () => {}, theme,
          () => { handle?.hide(); chat?.dispose(); openBrowser(); }, () => tui.requestRender(), () => terminal.rows);
        handle = tui.showOverlay(chat, { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 });
      }
    }, () => tui.requestRender(), () => terminal.rows);
    slot.clear(); slot.addChild(browser); tui.setFocus(browser);
  };
  tui.start();
  try {
    openBrowser(); send('\r');
    expect(frame()).toContain('Explore #9'); expect(chat?.focused).toBe(true);
    send('S'); send('Child draft héllo');
    expect(frame()).toContain('Child draft héllo');
    expect(tui.captureRenderState().hardwareCursorRow).toBe(terminal.rows - 1);
    let answer = '';
    const question = new Input({ prompt: 'Approve parent action? ' });
    question.onSubmit = value => { answer = value; restoreDraft(); };
    slot.clear(); slot.addChild(question); tui.setFocus(question);
    expect(chat?.focused).toBe(false);
    const waiting = frame();
    expect(waiting).toContain('Approve parent action?'); expect(waiting).not.toContain('Explore #9');
    send('No'); send('\r');
    expect(answer).toBe('No'); expect(chat?.focused).toBe(true);
    expect(frame()).toContain('Explore #9');
    expect(frame()).toContain('Child draft héllo');
    send('\x1b');
    expect(frame()).toContain('Explore #9');
    send('\x1b');
    expect(frame()).toContain('Enter chat'); expect(tui.getFocusedComponent()).toBe(browser);
    send('\x1b');
    expect(tui.getFocusedComponent()).toBe(draft);
    expect(frame()).toContain('Keep my parent draft');
    expect(draft.getValue()).toBe('Keep my parent draft');
    expect(tui.hasOverlay()).toBe(false);
  } finally { handle?.hide(); chat?.dispose(); browser?.dispose(); tui.stop(); }
});

const MOUSE_MODE = /\x1b\[\?100[0-6][hl]/;
const wheelUp = '\x1b[<64;10;5M', wheelDown = '\x1b[<65;10;5M';
const longSnapshot = () => {
  const view = snapshot('completed');
  view.entries = [entry(1, answer(Array.from({ length: 100 }, (_, index) => `Message row ${index}`).join('\n')))];
  return view;
};
/** The parts of Pi's fullscreen layout that matter here: a primary transcript and an editor slot above the footer. */
function fullscreenParent() {
  let send!: (data: string) => void;
  const writes: string[] = [];
  const terminal: Terminal = { rows: 12, columns: 100, kittyProtocolActive: false,
    start: onInput => { send = onInput; }, stop() {}, async drainInput() {}, write: data => { writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const tui = new TuiAltScreen(terminal, true);
  const document = new Text(Array.from({ length: 40 }, (_, index) => `Parent conversation ${index}`).join('\n'), 0, 0);
  const transcript = new ScrollView(document, { follow: 'end', primary: true });
  const slot = new Container(), footer = new Text('Parent footer', 0, 0), draft = new Input();
  draft.setValue('Keep my parent draft');
  const root = new VStack([{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: new VStack([{ component: slot, shrink: 1, minSize: 3 }, { component: footer, shrink: 1, minSize: 0 }]), basis: 'auto', grow: 0, shrink: 1, minSize: 1 }]);
  tui.addChild(document); tui.addChild(slot); tui.addChild(footer); tui.setLayoutRoot(root);
  const show = (component: Component) => { slot.clear(); slot.addChild(component); tui.setFocus(component); };
  show(draft); tui.start();
  const started = writes.length;
  const frame = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences).join('\n'); };
  const root$ = () => (tui as unknown as { layoutRoot?: Component }).layoutRoot;
  return { tui, transcript, draft, root, show, frame, layoutRoot: root$, send: (data: string) => send(data),
    laterWrites: () => writes.slice(started).join('') };
}

test('Pi fullscreen gives the focused chat the whole screen and wheel scrolling, then restores the parent layout', () => {
  const parent = fullscreenParent(), view = longSnapshot();
  let closed = 0;
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {
    closed++; parent.show(parent.draft); chat.dispose();
  }, () => parent.tui.requestRender(), () => 6);
  try {
    expect(parent.frame()).toContain('Keep my parent draft');
    const parentScroll = parent.transcript.scrollTop;
    expect(chat.takeOverScreen(parent.tui)).toBe(true);
    parent.show(chat);
    let screen = parent.frame();
    expect(chat.ownsScreen).toBe(true);
    expect(parent.tui.getScreenLines()).toHaveLength(12);
    expect(screen).toContain('Explore #9'); expect(screen).toContain('Wheel ↑↓ scroll');
    expect(screen).toContain('Message row 99'); expect(screen).not.toContain('Parent footer'); expect(screen).not.toContain('Parent conversation');
    for (let i = 0; i < 10; i++) parent.send(wheelUp);
    screen = parent.frame();
    expect(screen).not.toContain('Message row 99'); expect(screen).toContain('Message row 89');
    expect(parent.transcript.scrollTop).toBe(parentScroll);
    for (let i = 0; i < 10; i++) parent.send(wheelDown);
    expect(parent.frame()).toContain('Message row 99');
    view.entries = [entry(1, answer(Array.from({ length: 101 }, (_, index) => `Message row ${index}`).join('\n')))];
    expect(parent.frame()).toContain('Message row 100');
    parent.send(wheelUp); parent.send(wheelUp);
    // Compare conversation rows only. Pi 1.5 can flash a copy notice over the header row.
    const conversation = () => parent.frame().split('\n').slice(3, -2);
    const scrolled = conversation();
    expect(scrolled.join('\n')).not.toContain('Message row 100');
    // Pi keeps click-and-drag selection over the chat.
    parent.send('\x1b[<0;3;6M'); parent.send('\x1b[<32;20;6M');
    expect(parent.tui.hasActiveSelection()).toBe(true);
    parent.send('\x1b[<0;20;6m'); parent.tui.resetTextSelection();
    expect(conversation()).toEqual(scrolled);

    // A parent prompt replaces the chat in the dialog slot. The parent layout returns so the prompt is visible.
    let reply = '';
    const question = new Input({ prompt: 'Approve parent action? ' });
    question.onSubmit = value => { reply = value; parent.show(chat); };
    parent.show(question);
    expect(chat.focused).toBe(false); expect(chat.ownsScreen).toBe(false); expect(parent.layoutRoot()).toBe(parent.root);
    screen = parent.frame();
    expect(screen).toContain('Approve parent action?'); expect(screen).toContain('Parent footer'); expect(screen).not.toContain('Explore #9');
    parent.send(wheelUp);
    parent.send('No'); parent.send('\r');
    expect(reply).toBe('No'); expect(chat.focused).toBe(true); expect(chat.ownsScreen).toBe(true);
    expect(conversation()).toEqual(scrolled);

    parent.send('\x1b');
    expect(closed).toBe(1); expect(parent.layoutRoot()).toBe(parent.root);
    screen = parent.frame();
    expect(screen).toContain('Keep my parent draft'); expect(screen).toContain('Parent footer'); expect(screen).not.toContain('Explore #9');
    expect(parent.tui.getFocusedComponent()).toBe(parent.draft); expect(parent.draft.getValue()).toBe('Keep my parent draft');
    expect(parent.laterWrites()).not.toMatch(MOUSE_MODE);
  } finally { chat.dispose(); parent.tui.stop(); }
});

test('a fullscreen overlay chat hides itself behind its takeover and regains it after a parent prompt', () => {
  const parent = fullscreenParent(), view = longSnapshot();
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => parent.tui.requestRender(), () => 12);
  let handle: OverlayHandle | undefined;
  try {
    expect(chat.takeOverScreen(parent.tui)).toBe(true);
    handle = parent.tui.showOverlay(chat, { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 });
    expect(chat.render(100)).toEqual([]);
    expect(parent.frame()).toContain('Explore #9');
    parent.send(wheelUp); parent.send(wheelUp);
    expect(parent.frame()).not.toContain('Message row 99');
    const question = new Input({ prompt: 'Approve parent action? ' });
    question.onSubmit = () => parent.show(parent.draft);
    parent.show(question);
    expect(parent.frame()).toContain('Approve parent action?'); expect(parent.layoutRoot()).toBe(parent.root);
    parent.send('\r');
    expect(parent.tui.getFocusedComponent()).toBe(chat); expect(chat.ownsScreen).toBe(true);
    expect(parent.frame()).toContain('Explore #9');
    handle.hide(); chat.dispose();
    expect(parent.layoutRoot()).toBe(parent.root);
    expect(parent.tui.getFocusedComponent()).toBe(parent.draft);
    expect(parent.frame()).toContain('Keep my parent draft');
    expect(parent.laterWrites()).not.toMatch(MOUSE_MODE);
  } finally { handle?.hide(); chat.dispose(); parent.tui.stop(); }
});

test('the regular renderer keeps the chat in place, and only focused wheel events scroll it', () => {
  const view = longSnapshot();
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => 24);
  const tui = new TuiMainScreen({ rows: 24, columns: 80 } as Terminal, true);
  const wheel = (wheelDelta: number, type: 'wheel' | 'press' = 'wheel') => chat.handleMouse({ type, button: 'none', x: 0, y: 0, screenX: 0, screenY: 0,
    width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta });
  const content = () => chat.render(80).map(stripTerminalSequences).join('\n');
  try {
    expect(chat.takeOverScreen(tui)).toBe(false); expect(chat.ownsScreen).toBe(false);
    expect(content()).toContain('Message row 99'); expect(content()).not.toContain('Wheel');
    expect(wheel(-3, 'press')).toBeUndefined();
    expect(wheel(-3)).toEqual({ handled: true });
    expect(content()).not.toContain('Message row 99'); expect(content()).toContain('Message row 96');
    chat.focused = false; expect(wheel(-3)).toBeUndefined(); chat.focused = true;
    expect(content()).toContain('Message row 96');
    expect(wheel(50)).toEqual({ handled: true });
    view.entries = [entry(1, answer(Array.from({ length: 101 }, (_, index) => `Message row ${index}`).join('\n')))];
    expect(content()).toContain('Message row 100');
    chat.dispose(); expect(wheel(-1)).toBeUndefined();
  } finally { chat.dispose(); }
});

test('short terminals drop header details before hiding conversation text', () => {
  const view = snapshot('completed'); let rows = 5;
  view.entries = [entry(1, answer('Saved reply'))];
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => rows);
  try {
    for (rows of [7, 6, 5, 4, 3, 2]) {
      expect(chat.render(100)).toHaveLength(rows);
      expect(rendered(chat)).toContain('Saved reply');
    }
    view.run.status = 'running'; chat.handleInput('S');
    for (rows of [7, 6, 5, 4, 3, 2]) {
      expect(chat.render(100)).toHaveLength(rows);
      expect(rendered(chat)).toContain('Saved reply');
    }
  } finally { chat.dispose(); }
});

test('short and long chats fill the terminal and keep controls at the bottom after resize', () => {
  const view = snapshot('completed'); let rows = 32;
  view.entries = [entry(1, answer('Saved reply'))];
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => rows);
  try {
    for (rows of [32, 50, 12, 4, 1]) {
      const lines = chat.render(80);
      expect(lines).toHaveLength(rows);
      expect(stripTerminalSequences(lines.at(-1)!)).toContain('Esc back');
      if (rows >= 12) expect(lines.join('\n')).toContain('Saved reply');
    }
    view.run.status = 'running'; rows = 24;
    view.entries = [entry(1, answer(Array.from({ length: 100 }, (_, index) => `Message row ${index}`).join('\n\n')))];
    chat.handleInput('S'); chat.handleInput('A direction');
    for (rows of [24, 40, 10, 2, 1]) {
      const lines = chat.render(80);
      expect(lines).toHaveLength(rows);
      expect(stripTerminalSequences(lines.at(-1)!)).toContain('A direction');
    }
  } finally { chat.dispose(); }
});

test('page scrolling uses the full chat viewport', () => {
  const view = snapshot('completed');
  view.entries = [entry(1, answer(Array.from({ length: 100 }, (_, index) => `Message row ${index}`).join('\n')))];
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => 24);
  try {
    chat.handleInput('\x1b[H');
    const first = chat.render(80).map(stripTerminalSequences).slice(3, -2);
    chat.handleInput('\x1b[6~');
    const next = chat.render(80).map(stripTerminalSequences).slice(3, -2);
    expect(first).toHaveLength(19);
    expect(first[1]).toContain('Message row 0');
    expect(next[0]).toContain('Message row 18');
    chat.handleInput('\x1b[5~');
    expect(chat.render(80).map(stripTerminalSequences).slice(3, -2)).toEqual(first);
  } finally { chat.dispose(); }
});

test('resizing a scrolled chat preserves its position and uses the new page height', () => {
  const view = snapshot('completed'); let rows = 24;
  view.entries = [entry(1, answer(Array.from({ length: 100 }, (_, index) => `Message row ${index}`).join('\n')))];
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => rows);
  const content = () => chat.render(80).map(stripTerminalSequences).slice(3, -2);
  try {
    chat.handleInput('\x1b[H'); content();
    chat.handleInput('\x1b[B'); chat.handleInput('\x1b[B');
    expect(content()[0]).toContain('Message row 1');
    rows = 12;
    expect(content()).toHaveLength(7); expect(content()[0]).toContain('Message row 1');
    chat.handleInput('\x1b[6~'); expect(content()[0]).toContain('Message row 8');
    chat.handleInput('\x1b[5~'); expect(content()[0]).toContain('Message row 1');
    rows = 150;
    expect(content()[0]).toContain('Explore'); expect(content()[1]).toContain('Message row 0');
  } finally { chat.dispose(); }
});

test('chat renders roles and Markdown while hiding raw system entries and large tool output', () => {
  const view = snapshot();
  const items = chatItems(view.entries);
  expect(items.map(item => item.role)).toEqual(['parent', 'tool', 'assistant']);
  expect(items[1].args).toBe('/project/file.ts'); expect(items[1].pending).toBe(false);
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => 80);
  try {
    let text = rendered(chat);
    expect(text).toContain('Parent'); expect(text).toContain('Explore'); expect(text).toContain('Readable assistant evidence');
    expect(text).not.toContain('PRIVATE_SYSTEM_INSTRUCTIONS'); expect(text).not.toContain('"model":');
    expect(text).not.toContain('LARGE_TOOL_OUTPUT'); expect(text).toContain('Output collapsed');
    chat.handleInput('o'); text = rendered(chat);
    expect(text).toContain('LARGE_TOOL_OUTPUT');
    for (const width of [0, 1, 10, 80]) expect(chat.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  } finally { chat.dispose(); }
});

test('inherited content is opt-in and terminal escapes cannot enter the rendered conversation', () => {
  const view = snapshot(); view.entries.push(entry(6, user('Inherited private notes'), 'pi-subagents.fork'), entry(7, answer('\x1b[31mSafe message\x1b[0m')));
  expect(chatItems(view.entries).some(item => item.imported)).toBe(false);
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => 80);
  try {
    expect(rendered(chat)).not.toContain('Inherited private notes');
    chat.handleInput('i'); expect(rendered(chat)).toContain('Inherited private notes');
    expect(chatItems(view.entries, true).at(-1)?.text).toBe('Safe message');
  } finally { chat.dispose(); }
});

test('S composes direction and repeated submit sends one request for the displayed task', async () => {
  const view = snapshot(); let release!: () => void;
  const sent: any[] = [];
  const chat = new SubagentChat(view, async () => view, async (...args) => { sent.push(args); await new Promise<void>(resolve => { release = resolve; }); }, theme, () => {}, () => {});
  try {
    chat.handleInput('S'); chat.handleInput('Focus on permissions'); chat.handleInput('\r'); chat.handleInput('\r');
    expect(sent).toHaveLength(1); expect(sent[0][0]).toBe('Focus on permissions'); expect(sent[0][2]).toBe(1);
    expect(rendered(chat)).toContain('Sending direction'); release();
    for (const width of [1, 10, 80]) expect(chat.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    await vi.waitFor(() => expect(rendered(chat)).toContain('Direction queued'));
    expect(rendered(chat)).not.toContain('› Focus on permissions');
  } finally { chat.dispose(); }
});

test('failed steering retains the draft and reuses its request key on retry', async () => {
  const view = snapshot(), sent: any[] = [];
  const chat = new SubagentChat(view, async () => view, async (...args) => { sent.push(args); throw new Error('Try again'); }, theme, () => {}, () => {});
  try {
    chat.handleInput('s'); chat.handleInput('Keep this draft'); chat.handleInput('\r');
    await vi.waitFor(() => expect(rendered(chat)).toContain('Try again'));
    expect(rendered(chat)).toContain('Keep this draft');
    chat.handleInput('\r'); await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1][1]).toBe(sent[0][1]);
  } finally { chat.dispose(); }
});

test('queued user directions appear once, and finished tasks reject steering', () => {
  const view = snapshot(); view.run.steering = [{ id: 20 as any, task: 'A queued direction', source: 'user' }];
  const sent = vi.fn(async () => {});
  const chat = new SubagentChat(view, async () => view, sent, theme, () => {}, () => {}, () => 80);
  try {
    expect(rendered(chat)).toContain('You · steering · queued');
    view.entries.push(entry(8, user('User steering:\n\nA queued direction')));
    expect(rendered(chat).match(/A queued direction/g)).toHaveLength(1);
    view.run.status = 'completed'; chat.handleInput('s');
    expect(rendered(chat)).toContain('This task has finished'); expect(sent).not.toHaveBeenCalled();
  } finally { chat.dispose(); }
});

test('delivered directions preserve whitespace and repeated text has only the remaining queued copy', () => {
  const view = snapshot();
  const direction = '  stop now\n\n  Keep indentation';
  view.run.steering = [{ id: 20 as any, task: direction, source: 'user' }, { id: 21 as any, task: direction, source: 'user' }];
  view.entries.push(entry(8, user(`User steering:\n\n${direction}`)));
  expect(chatItems(view.entries).at(-1)?.text).toBe(direction);
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => 100);
  try {
    let text = rendered(chat);
    expect(text.match(/stop now/g)).toHaveLength(2);
    expect(text.match(/You · steering · queued/g)).toHaveLength(1);
    view.entries.push(entry(9, user(`User steering:\n\n${direction}`)));
    text = rendered(chat);
    expect(text.match(/stop now/g)).toHaveLength(2);
    expect(text).not.toContain('You · steering · queued');
  } finally { chat.dispose(); }
});

test('tool names and chat metadata cannot emit terminal control sequences', () => {
  const payload = '\x1b]0;pwned\x07', view = snapshot();
  view.run.model += payload; view.run.thinking = ('off' + payload) as any; view.run.agent += payload;
  view.entries.push(entry(8, answer(fauxToolCall('safe' + payload, {}, { id: 'hostile' })), 'pi.assistant'),
    entry(9, { ...result('Result'), toolCallId: 'orphan', toolName: 'orphan' + payload }, 'pi.tool'));
  const items = chatItems(view.entries);
  expect(items.find(item => item.label === 'safe')).toBeDefined();
  expect(items.find(item => item.label === 'orphan')).toBeDefined();
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {}, () => 100);
  try { expect(chat.render(140).join('\n')).not.toContain(payload); }
  finally { chat.dispose(); }
});

test('malformed tool arguments remain readable without crashing the chat', () => {
  const view = snapshot();
  view.entries = [entry(1, answer({ type: 'toolCall', id: 'null', name: 'bash', arguments: null } as any)),
    entry(2, answer({ type: 'toolCall', id: 'structured', name: 'bash', arguments: { command: { value: 'object' } } } as any))];
  const items = chatItems(view.entries);
  expect(items[0].args).toBe('null'); expect(items[1].args).toBe('{"value":"object"}');
  const chat = new SubagentChat(view, async () => view, async () => {}, theme, () => {}, () => {});
  try { expect(() => chat.render(80)).not.toThrow(); }
  finally { chat.dispose(); }
});

test('a starting child cannot compose direction, while leaving the composer preserves a draft', () => {
  const view = snapshot('starting'), sent = vi.fn(async () => {});
  const chat = new SubagentChat(view, async () => view, sent, theme, () => {}, () => {}, () => 80);
  try {
    chat.handleInput('S'); expect(rendered(chat)).toContain('This child is starting');
    expect(rendered(chat)).not.toContain('Enter send'); expect(sent).not.toHaveBeenCalled();
    view.run.status = 'running'; chat.handleInput('S'); chat.handleInput('Keep my draft'); chat.handleInput('\x1b');
    expect(rendered(chat)).not.toContain('Enter send');
    chat.handleInput('S'); expect(rendered(chat)).toContain('Keep my draft');
  } finally { chat.dispose(); }
});

test('Escape closes the chat during a slow send without repeating it or rendering after disposal', async () => {
  let release!: () => void, closed = 0;
  const draw = vi.fn(), load = vi.fn(async () => snapshot());
  const send = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); });
  const chat = new SubagentChat(snapshot(), load, send, theme, () => { closed++; }, draw);
  chat.handleInput('S'); chat.handleInput('Direction'); chat.handleInput('\r'); chat.handleInput('\x1b');
  expect(closed).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  chat.dispose(); draw.mockClear(); release();
  await Promise.resolve(); await Promise.resolve();
  expect(draw).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
});

test('closing a live chat stops refresh and leaves an in-flight read unrendered', async () => {
  vi.useFakeTimers();
  let release!: (snapshot: ChildChatSnapshot) => void;
  const load = vi.fn(() => new Promise<ChildChatSnapshot>(resolve => { release = resolve; })), draw = vi.fn();
  const chat = new SubagentChat(snapshot(), load, async () => {}, theme, () => {}, draw);
  try {
    await vi.advanceTimersByTimeAsync(1500); expect(load).toHaveBeenCalledTimes(1);
    chat.dispose(); release(snapshot()); await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1); expect(draw).not.toHaveBeenCalled();
  } finally { chat.dispose(); vi.useRealTimers(); }
});
