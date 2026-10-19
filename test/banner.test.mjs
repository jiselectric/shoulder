import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freshFixture, attachedFixture, records, tmux, until } from './runtime-fixture.mjs';
import { loadState, openScratchpad } from '../dist/runtime.js';

async function bannerFixture(t, oldMarker = false, directKeys = true) {
  return attachedFixture(t, async f => {
    f.options.publicCli = true;
    f.options.showBanner = true;
    f.options.directKeys = directKeys;
    f.options.nativeArgs.unshift('resume', f.options.sessionId);
    await symlink(f.options.codexPath, join(f.dir, 'codex'));
    const previousPath = process.env.PATH;
    process.env.PATH = `${f.dir}:${previousPath ?? ''}`;
    t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
    if (oldMarker) {
      await mkdir(join(f.dir, 'state', 'shldr'), { recursive: true });
      await writeFile(join(f.dir, 'state', 'shldr', 'welcome-v1'), '1\n');
    }
  });
}

for (const oldMarker of [false, true]) test(`the header sits above an immediately usable CLI${oldMarker ? ' with old welcome state present' : ''}`, async t => {
  const f = await bannerFixture(t, oldMarker);
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status-position'), 'top');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), '5');
  await until(async () => {
    const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
    const rows = screen.split('\n');
    return /Room for a side question\./.test(rows.slice(0, 5).join('\n')) && rows.slice(5).join('\n').includes('NATIVE_READY');
  }, 'banner and native CLI visible together');
  const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
  assert.match(screen.split('\n').slice(0, 5).join('\n'), /\/ ___\//);
  assert.ok(screen.split('\n')[4].startsWith('/____'), 'wordmark begins at the left edge');
  assert.match(screen.split('\n')[5], /^.{0,3} Main\s*$/, 'quiet role row separates header from native chat');
  assert.doesNotMatch(screen, /MAIN ROAD|\[\?\]|Enter.*open|Ctrl-C.*cancel/);
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', 'IMMEDIATE_NATIVE_DRAFT');
  await until(async () => (await readFile(join(f.logs, 'main-0.draft'), 'utf8')).includes('IMMEDIATE_NATIVE_DRAFT'), 'typing reaches native input directly');
  await assert.rejects(access(join(f.logs, 'main.transcript')), 'no implicit submission');
  assert.equal(await tmux(f.outerState, 'display-message', '-p', '-t', '%0', '#{cursor_flag}'), '1');
  assert.ok(Number(await tmux(f.outerState, 'display-message', '-p', '-t', '%0', '#{cursor_y}')) >= 5, 'cursor belongs to chat below header');
});

test('the header collapses on small terminals and expands again without interrupting native input', async t => {
  const f = await bannerFixture(t);
  const mainPid = f.main.pid;
  await tmux(f.outerState, 'resize-window', '-x', '80', '-y', '24');
  await until(async () => (await tmux(f.state, 'show-options', '-gv', 'status')) === 'on', 'compact header');
  await until(async () => (await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')).split('\n')[0].includes('[Clear side]'), 'compact controls visible');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', 'AFTER_RESIZE');
  await until(async () => (await readFile(join(f.logs, 'main-0.draft'), 'utf8')).includes('AFTER_RESIZE'), 'same native input after resize');
  await tmux(f.outerState, 'resize-window', '-x', '120', '-y', '40');
  await until(async () => (await tmux(f.state, 'show-options', '-gv', 'status')) === '5', 'expanded header returns');
  assert.equal((await records(f.logs, 'main'))[0].pid, mainPid);
});

test('mouse actions in the header preserve side drafts and clear without submission', async t => {
  const f = await bannerFixture(t);
  await openScratchpad(f.state, 'HEADER_CONTROL_QUOTE');
  const before = await loadState(f.state.directory);
  async function click(label) {
    const rows = await until(async () => {
      const rows = (await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')).split('\n');
      return rows.some(row => row.includes(label)) && rows;
    }, label);
    const row = rows.findIndex(text => text.includes(label));
    const col = rows[row].indexOf(label) + 3;
    for (const event of [`\x1b[<0;${col};${row + 1}M`, `\x1b[<0;${col};${row + 1}m`]) await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', event);
  }
  await click('[Close side]');
  await until(async () => (await loadState(f.state.directory)).sideHidden, 'header closes side');
  await click('[Reopen side]');
  await until(async () => !(await loadState(f.state.directory)).sideHidden, 'header reopens side');
  assert.equal((await loadState(f.state.directory)).sidePane, before.sidePane);
  await click('[Clear side]');
  await until(async () => (await records(f.logs, 'fork')).length === 2, 'header clears side');
  assert.equal((await loadState(f.state.directory)).sidePane, before.sidePane);
  await assert.rejects(access(join(f.logs, 'main.transcript')));
  await assert.rejects(access(join(f.logs, 'fork.transcript')));
});

test('--no-banner retains direct startup with the compact bottom bar', async t => {
  const f = await freshFixture(t);
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status-position'), 'bottom');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), 'on');
  const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
  assert.doesNotMatch(screen, /MAIN ROAD|SHOULDER/);
  assert.doesNotMatch(JSON.stringify(f.main.args), /--no-banner/);
  await tmux(f.outerState, 'send-keys', '-t', '%0', 'C-b', 'b');
  await until(async () => await tmux(f.state, 'show-options', '-gv', 'status') === '5', 'opt-out can show banner live');
});


test('banner hide and show buttons preserve the live chat and draft across resize', async t => {
  const f = await bannerFixture(t);
  const pid = f.main.pid;
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', 'BANNER_TOGGLE_DRAFT');
  async function click(label) {
    const rows = await until(async () => {
      const rows = (await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')).split('\n');
      return rows.some(row => row.includes(label)) && rows;
    }, label);
    const y = rows.findIndex(row => row.includes(label));
    const x = rows[y].indexOf(label) + 3;
    for (const end of ['M', 'm']) await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', `\x1b[<0;${x};${y + 1}${end}`);
  }
  await click('[Hide banner]');
  await until(async () => await tmux(f.state, 'show-options', '-gv', 'status-position') === 'bottom', 'banner hidden');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), 'on');
  await tmux(f.outerState, 'resize-window', '-x', '140', '-y', '42');
  await until(async () => await tmux(f.state, 'display-message', '-p', '#{client_width}') === '140', 'hidden banner resized');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), 'on');
  await click('[Show banner]');
  await until(async () => await tmux(f.state, 'show-options', '-gv', 'status') === '5', 'banner shown again');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status-position'), 'top');
  await tmux(f.outerState, 'send-keys', '-t', '%0', 'C-b', 'b');
  await until(async () => await tmux(f.state, 'show-options', '-gv', 'status-position') === 'bottom', 'keyboard hides banner');
  await tmux(f.outerState, 'resize-window', '-x', '80', '-y', '24');
  await until(async () => await tmux(f.state, 'display-message', '-p', '#{client_width}') === '80', 'small hidden layout');
  await tmux(f.outerState, 'send-keys', '-t', '%0', 'C-b', 'b');
  await until(async () => await tmux(f.state, 'show-options', '-gv', 'status-position') === 'top', 'keyboard shows compact banner');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), 'on');
  await tmux(f.outerState, 'resize-window', '-x', '120', '-y', '40');
  await until(async () => await tmux(f.state, 'show-options', '-gv', 'status') === '5', 'shown banner expands after resize');
  assert.equal((await records(f.logs, 'main'))[0].pid, pid);
  assert.match(await readFile(join(f.logs, 'main-0.draft'), 'utf8'), /BANNER_TOGGLE_DRAFT/);
  await assert.rejects(access(join(f.logs, 'main.transcript')));
});


test('public direct-key opt-out restores the prefix descriptions and native control bytes', async t => {
  const f = await bannerFixture(t, false, false);
  const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
  assert.match(screen, /Ctrl-b o.*switch panes/);
  assert.doesNotMatch(screen, /Ctrl\+Q/);
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x11\x1c');
  await until(async () => (await readFile(join(f.logs, 'main-0.draft'), 'utf8')).includes('\x11\x1c'), 'public opt-out preserves native keys');
  assert.doesNotMatch(JSON.stringify(f.main.args), /--no-direct-keys/);
});
