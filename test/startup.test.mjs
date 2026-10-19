import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRuntime, openScratchpad, clearScratchpad } from '../dist/runtime.js';
import { tmux as nativeTmux, tmuxBatch } from '../dist/tmux.js';
import { exec, fixture, until, records } from './runtime-fixture.mjs';

test('native startup observes complete configuration and literal trailing-semicolon project data', async t => {
  const f = await fixture(t, {}, false);
  const cwd = join(f.dir, 'literal project;');
  await mkdir(cwd);
  const snapshot = join(f.logs, 'startup.json');
  const executable = join(f.dir, 'startup-native.mjs');
  await writeFile(executable, `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const socket = process.env.TMUX.split(',')[0];
const query = (...args) => execFileSync('tmux', ['-S', socket, ...args], {encoding:'utf8'}).trim();
writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify({
  project:query('show-options','-gv','@shoulder_project'),
  title:query('display-message','-p','-t',process.env.TMUX_PANE,'#{pane_title}'),
  borders:query('show-window-options','-gv','pane-border-status'),
  mouse:query('show-options','-gv','mouse'),
  clipboard:query('show-options','-gv','set-clipboard'),
  prefix:query('list-keys','-T','prefix'),
  root:query('list-keys','-T','root'),
  emacs:query('list-keys','-T','copy-mode'),
  vi:query('list-keys','-T','copy-mode-vi')
}));
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const state = await createRuntime({ ...f.options, cwd, codexPath: executable });
  f.trackState(state);
  const observed = await until(async () => JSON.parse(await readFile(snapshot, 'utf8')), 'native startup configuration');
  assert.equal(observed.project, 'literal project;');
  assert.equal(observed.title, 'Main');
  assert.equal(observed.borders, 'bottom');
  assert.equal(observed.mouse, 'on');
  assert.equal(observed.clipboard, 'off');
  assert.match(observed.prefix, /\bC\s+run-shell[^\n]*control[^\n]*clear/);
  assert.match(observed.prefix, /\bX\s+run-shell[^\n]*control[^\n]*toggle/);
  assert.match(observed.prefix, /\be\s+if-shell[^\n]*selection_present[^\n]*copy-pipe-and-cancel/);
  assert.match(observed.root, /MouseDrag1Pane\s+copy-mode -M/);
  assert.match(observed.root, /MouseDown1Status[^\n]*side-close[^\n]*side-clear/);
  for (const bindings of [observed.emacs, observed.vi]) {
    assert.match(bindings, /MouseDown1Pane[^\n]*cancel[^\n]*;[^\n]*select-pane/);
    assert.match(bindings, /MouseDragEnd1Pane[^\n]*stop-selection/);
    assert.match(bindings, /\be\s+if-shell[^\n]*selection_present[^\n]*copy-pipe-and-cancel/);
  }
});

test('configuration failure stops startup and removes its private server and waiting helper', async t => {
  const f = await fixture(t, {}, false);
  const realTmux = (await exec('which', ['tmux'])).stdout.trim();
  const trace = join(f.logs, 'failed-setup.json');
  const bin = join(f.dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync, execFileSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const args=process.argv.slice(2),index=args.indexOf('set-clipboard');
if(index>=0) {
  const socket=args[args.indexOf('-S')+1];
  const pids=execFileSync(${JSON.stringify(realTmux)},['-S',socket,'list-panes','-a','-F','#{pane_pid}'],{encoding:'utf8'}).trim().split('\\n').map(Number);
  writeFileSync(${JSON.stringify(trace)},JSON.stringify({socket,pids,ready:existsSync(join(dirname(socket),'ready'))}));
  args[index]='shoulder-test-invalid-option';
}
const result=spawnSync(${JSON.stringify(realTmux)},args,{stdio:'inherit'});
process.exit(result.status??1);
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  await assert.rejects(createRuntime(f.options), /tmux operation failed.*invalid option/s);
  const failed = JSON.parse(await readFile(trace, 'utf8'));
  assert.equal(failed.ready, false, 'provider must wait until every configuration command succeeds');
  await assert.rejects(access(dirname(failed.socket)), error => error.code === 'ENOENT');
  await assert.rejects(exec(realTmux, ['-S', failed.socket, 'list-panes', '-a']));
  await until(async () => failed.pids.every(pid => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }), 'waiting native helper released after configuration failure');
  await assert.rejects(access(join(f.logs, 'main-0.json')), 'native provider did not start before configuration failure');
});


test('ordinary tmux commands preserve literal individual and trailing semicolons', async t => {
  const f = await fixture(t);
  for (const value of [';', 'trailing;', 'backslash\\;', 'two;;']) {
    await nativeTmux(f.state, ['set-option', '-g', '@literal', value]);
    assert.equal(await nativeTmux(f.state, ['show-options', '-gv', '@literal']), value);
  }
});

test('side open and Clear preserve a saved working directory ending in a semicolon', async t => {
  const f = await fixture(t);
  const cwd = join(f.dir, 'saved working directory;');
  await mkdir(cwd);
  await f.metadata({ cwd });
  await openScratchpad(f.state, 'LITERAL_CWD_QUOTE');
  await until(async () => (await records(f.logs, 'fork')).length === 1, 'side starts in literal cwd');
  assert.equal((await records(f.logs, 'fork'))[0].cwd, await realpath(cwd));
  await clearScratchpad(f.state);
  await until(async () => (await records(f.logs, 'fork')).length === 2, 'Clear respawns in literal cwd');
  assert.equal((await records(f.logs, 'fork'))[1].cwd, await realpath(cwd));
});


test('tmux queue preserves literal data and rejects empty commands without executing defaults', async t => {
  const f = await fixture(t);
  await tmuxBatch(f.state, [
    ['set-option', '-g', '@queue_first', ';'],
    ['set-option', '-g', '@queue_second', 'last;'],
  ]);
  assert.equal(await nativeTmux(f.state, ['show-options', '-gv', '@queue_first']), ';');
  assert.equal(await nativeTmux(f.state, ['show-options', '-gv', '@queue_second']), 'last;');
  await assert.rejects(tmuxBatch(f.state, []), /nonempty/);
  await assert.rejects(tmuxBatch(f.state, [[]]), /nonempty/);
});
