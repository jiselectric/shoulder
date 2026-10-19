import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, exec, tmux, records, until } from './runtime-fixture.mjs';
import { loadState } from '../dist/runtime.js';

test('installed paths with literal tmux formats, spaces and quotes keep selection and keyboard controls working', async t => {
  const f = await fixture(t, {}, false);
  const installed = join(f.dir, "Shoulder #{a:65} 日本語 ' build");
  await cp(resolve('dist'), join(installed, 'dist'), { recursive: true });
  await writeFile(join(installed, 'package.json'), '{"type":"module"}');
  const launcher = join(f.dir, 'launch-installed.mjs');
  const result = join(f.dir, 'installed-result');
  await writeFile(launcher, `import {launch} from ${JSON.stringify(pathToFileURL(join(installed, 'dist/runtime.js')).href)};
import {writeFile} from 'node:fs/promises';
delete process.env.TMUX;
await writeFile(${JSON.stringify(`${result}.pid`)}, String(process.pid));
const code = await launch(${JSON.stringify(f.options)});
await writeFile(${JSON.stringify(result)}, String(code));
process.exitCode = code;
`);
  const outer = await mkdtemp('/tmp/shoulder-installed-');
  const outerState = { socket: join(outer, 'client.sock') };
  f.beforeRemove(async () => {
    await exec('tmux', ['-S', outerState.socket, 'kill-server']).catch(() => {});
    try {
      const pid = Number(await readFile(`${result}.pid`, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0) await until(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      }, 'installed launcher exits before deleting its fixture directory');
    } finally { await rm(outer, { recursive: true, force: true }); }
  });
  await exec('tmux', ['-f', '/dev/null', '-S', outerState.socket, 'new-session', '-d', '-s', 'client', '-x', '160', '-y', '45', process.execPath, launcher]);
  await until(async () => (await records(f.logs, 'main')).length === 1, 'installed main starts');
  const [main] = await records(f.logs, 'main');
  const state = await loadState(main.tmux.split(',')[0].replace(/\/tmux\.sock$/, ''));
  f.trackState(state);
  await until(async () => (await tmux(state, 'capture-pane', '-p', '-t', state.mainPane)).includes('NATIVE_READY'));
  await tmux(state, 'copy-mode', '-t', state.mainPane);
  for (const action of ['history-top', 'start-of-line', 'begin-selection', 'end-of-line']) {
    await tmux(state, 'send-keys', '-t', state.mainPane, '-X', action);
  }
  await tmux(state, 'send-keys', '-t', state.mainPane, 'e');
  await until(async () => (await records(f.logs, 'fork')).length === 1, 'literal installed path selection dispatch');
  await until(async () => (await readFile(join(f.logs, 'fork-0.draft'), 'utf8')).includes('SELECT passage'), 'installed quote stays unsent');
  const before = await loadState(state.directory);
  for (const hidden of [true, false]) {
    await tmux(outerState, 'send-keys', '-t', '%0', 'C-b', 'X');
    await until(async () => Boolean((await loadState(state.directory)).sideHidden) === hidden, 'installed keyboard toggle');
    assert.equal((await loadState(state.directory)).sidePane, before.sidePane);
  }
  await tmux(outerState, 'send-keys', '-t', '%0', 'C-b', 'C');
  await until(async () => (await records(f.logs, 'fork')).length === 2, 'installed keyboard clear');
  assert.equal((await loadState(state.directory)).sidePane, before.sidePane);
  await assert.rejects(access(join(f.logs, 'fork.transcript')), 'controls and selection never submit a question');
});
