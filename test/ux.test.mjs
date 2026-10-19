import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, attachedFixture, tmux, until, records } from './runtime-fixture.mjs';
import { createRuntime, openScratchpad, loadState } from '../dist/runtime.js';

test('the working interface always keeps a compact footer', async t => {
  const f = await attachedFixture(t);
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), 'on');
  const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
  assert.doesNotMatch(screen, /Room for a side question\./);
  assert.match(screen, /shoulder/);
});

test('short terminals keep the compact footer and support side chats', async t => {
  const f = await attachedFixture(t, async f => { f.rows = 22; });
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'status'), 'on');
  await until(async () => (await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')).includes('[Clear side]'), 'short-terminal controls');
  await openScratchpad(f.state, 'SHORT_TERMINAL_QUOTE');
  assert.equal((await tmux(f.state, 'list-panes', '-F', '#{pane_id}')).split('\n').length, 2);
});

test('NO_COLOR removes Shoulder accents while keeping readable controls', async t => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  const f = await attachedFixture(t);
  assert.doesNotMatch(await tmux(f.state, 'show-options', '-gv', 'status-format[0]'), /fg=(?!default)/);
  assert.doesNotMatch(await tmux(f.state, 'show-window-options', '-gv', 'pane-active-border-style'), /cyan|green/);
  await until(async () => (await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')).includes('[Clear side]'), 'uncolored controls visible');
});

test('the footer uses the terminal background and keeps mouse actions visible at narrow widths', async t => {
  const f = await attachedFixture(t);
  assert.match(await tmux(f.state, 'show-options', '-gv', 'status-style'), /bg=default/);
  for (const width of [120, 80, 60]) {
    await tmux(f.outerState, 'resize-window', '-x', String(width), '-y', '40');
    await until(async () => (await tmux(f.state, 'display-message', '-p', '#{client_width}')) === String(width), 'attached terminal resized');
    const footer = await until(async () => {
      const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
      const last = screen.split('\n').at(-1);
      return last.includes('[Clear side]') && last.includes('[Open side]') && last;
    }, `actions visible at ${width} columns`);
    assert.doesNotMatch(footer, /Finish a main answer.*\[Clear side\]/);
    if (width === 120) {
      assert.match(footer, /shoulder.*drag \+ e.*Finish a main answer/);
    } else {
      assert.doesNotMatch(footer, /drag \+ e|Finish a main answer/);
    }
  }
});

test('Shoulder labels managed surfaces and keeps session UUIDs out of its footer', async t => {
  const f = await attachedFixture(t);
  assert.equal(await tmux(f.state, 'display-message', '-p', '-t', f.state.mainPane, '#{window_name}'), 'Shoulder');
  assert.equal(await tmux(f.state, 'display-message', '-p', '-t', f.state.mainPane, '#{pane_title}'), 'Main');
  assert.equal(await tmux(f.state, 'show-options', '-gv', 'set-titles'), 'on');
  assert.match(await tmux(f.state, 'show-options', '-gv', 'set-titles-string'), /^Shoulder · /);
  await until(async () => (await tmux(f.outerState, 'display-message', '-p', '-t', '%0', '#{pane_title}')).startsWith('Shoulder · '), 'managed title reaches attached terminal');
  assert.doesNotMatch(await tmux(f.state, 'show-options', '-gv', 'status-right'), /[a-f\d]{8}-[a-f\d-]{27}/i);
  await openScratchpad(f.state, 'ROLE_LABEL_QUOTE');
  const state = await loadState(f.state.directory);
  assert.equal(await tmux(state, 'display-message', '-p', '-t', state.sidePane, '#{pane_title}'), 'Side chat');
  assert.equal(await tmux(state, 'show-options', '-gv', 'status-right'), 'Source linked · read on demand');
  assert.equal(await tmux(state, 'show-window-options', '-gv', 'pane-border-status'), 'bottom');
  assert.match(await tmux(state, 'show-window-options', '-gv', 'pane-border-format'), /pane_title/);
});

test('project text cannot inject terminal controls or tmux title formats and native titles cannot replace pane roles', async t => {
  const f = await fixture(t, {}, false);
  const marker = join(f.dir, 'TITLE_INJECTION');
  // A project name is filesystem data even when it resembles tmux formatting.
  const project = `日本語 #[fg=red] #{pane_id} #(touch TITLE_INJECTION)\x1b\n`;
  const cwd = join(f.dir, project);
  await mkdir(cwd);
  const executable = join(f.dir, 'title-native.mjs');
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write('\\x1b]0;NATIVE_TITLE\\x07\\x1bkNATIVE_WINDOW\\x1b\\\\');\nawait import(${JSON.stringify(pathToFileURL(resolve('test/fixtures/fake-codex.mjs')).href)});\n`, { mode: 0o755 });
  const state = await createRuntime({ ...f.options, codexPath: executable, cwd });
  f.trackState(state);
  await until(async () => (await tmux(state, 'capture-pane', '-p', '-t', state.mainPane)).includes('NATIVE_READY'));
  assert.equal(await tmux(state, 'display-message', '-p', '-t', state.mainPane, '#{pane_title}'), 'Main');
  assert.equal(await tmux(state, 'display-message', '-p', '-t', state.mainPane, '#{window_name}'), 'Shoulder');
  const format = await tmux(state, 'show-options', '-gv', 'set-titles-string');
  assert.doesNotMatch(format, /[\x00-\x1f\x7f-\x9f]/);
  // Ask tmux itself to expand the configured title, as it would for a client.
  const expanded = await tmux(state, 'display-message', '-p', '-t', state.mainPane, format);
  assert.match(expanded, /^Shoulder · 日本語 #\[fg=red\] #\{pane_id\} #\(touch/);
  assert.doesNotMatch(expanded, /NATIVE_TITLE|NATIVE_WINDOW|%0/);
  await assert.rejects(access(marker));
});

for (const [clearKey, toggleKey] of [['C', 'X'], ['c', 'x']]) test(`keyboard ${clearKey}/${toggleKey} controls hide, reopen and clear without submitting input`, async t => {
  const f = await attachedFixture(t);
  await openScratchpad(f.state, 'KEYBOARD_CONTROL_QUOTE');
  const before = await loadState(f.state.directory);
  const keys = await tmux(f.state, 'list-keys', '-T', 'prefix');
  assert.match(keys, /\bC\s+run-shell[^\n]*control[^\n]*clear/);
  assert.match(keys, /\bX\s+run-shell[^\n]*control[^\n]*toggle/);
  const send = async key => { await tmux(f.outerState, 'send-keys', '-t', '%0', 'C-b', key); };
  await send('o');
  await until(async () => (await tmux(f.state, 'display-message', '-p', '#{pane_id}')) === before.mainPane, 'keyboard switches focus to main');
  await send(toggleKey);
  await until(async () => (await loadState(f.state.directory)).sideHidden, 'keyboard hides side');
  await send(toggleKey);
  await until(async () => !(await loadState(f.state.directory)).sideHidden, 'keyboard reopens side');
  assert.equal((await loadState(f.state.directory)).sidePane, before.sidePane);
  await send(clearKey);
  await until(async () => (await records(f.logs, 'fork')).length === 2, 'keyboard resets draft');
  await until(async () => (await tmux(f.state, 'capture-pane', '-p', '-t', before.sidePane)).includes('FORK_READY'), 'fresh side ready');
  assert.equal(await tmux(f.state, 'display-message', '-p', '-t', before.sidePane, '#{pane_title}'), 'Side chat');
  await assert.rejects(access(join(f.logs, 'fork-1.draft')), 'fresh side starts without inserted input');
  await assert.rejects(access(join(f.logs, 'fork.transcript')), 'no control submits a provider turn');
});


test('direct control chords switch focus and hide/reopen without submitting native input', async t => {
  const f = await attachedFixture(t);
  await openScratchpad(f.state, 'DIRECT_CONTROL_QUOTE');
  const before = await loadState(f.state.directory);
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', 'DIRECT_CONTROL_DRAFT');
  await until(async () => (await readFile(join(f.logs, 'fork-0.draft'), 'utf8')).includes('DIRECT_CONTROL_DRAFT'), 'direct key fixture draft');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x1c');
  await until(async () => await tmux(f.state, 'display-message', '-p', '#{pane_id}') === before.mainPane, 'Ctrl+backslash focuses main');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x1c');
  await until(async () => await tmux(f.state, 'display-message', '-p', '#{pane_id}') === before.sidePane, 'Ctrl+backslash focuses side');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x11');
  await until(async () => (await loadState(f.state.directory)).sideHidden, 'Ctrl+Q hides side');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x11');
  await until(async () => !(await loadState(f.state.directory)).sideHidden, 'Ctrl+Q reopens side');
  assert.equal((await loadState(f.state.directory)).sidePane, before.sidePane);
  assert.match(await readFile(join(f.logs, 'fork-0.draft'), 'utf8'), /DIRECT_CONTROL_DRAFT/);
  assert.doesNotMatch(await readFile(join(f.logs, 'fork-0.draft'), 'utf8'), /[\x11\x1c]/);
  await assert.rejects(access(join(f.logs, 'main.transcript')));
  await assert.rejects(access(join(f.logs, 'fork.transcript')));
});

for (const provider of ['codex', 'generic']) test(`direct chords can remain native for ${provider}`, async t => {
  const f = await attachedFixture(t, async f => { f.options.provider = provider; f.options.directKeys = false; });
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x11\x1c');
  await until(async () => (await readFile(join(f.logs, 'main-0.draft'), 'utf8')).includes('\x11\x1c'), 'opt-out forwards control bytes unchanged');
});
