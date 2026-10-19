import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { attachedFixture, tmux, until, records } from './runtime-fixture.mjs';
import { clearScratchpad, closeScratchpad } from '../dist/runtime.js';

async function select(f) {
  for (const event of ['\x1b[<0;1;1M', '\x1b[<32;24;1M', '\x1b[<0;24;1m']) await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', event);
  await until(async () => await tmux(f.state, 'display-message', '-p', '-t', f.state.mainPane, '#{selection_present}') === '1', 'passage selected');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', 'e');
}

for (const mode of ['emacs', 'vi']) test(`selection forwarding leaves no quote paste buffer with ${mode} keys`, async t => {
  const f = await attachedFixture(t);
  await tmux(f.state, 'set-window-option', 'mode-keys', mode);
  await tmux(f.state, 'set-buffer', '-b', 'unrelated-user-buffer', 'KEEP_EXISTING_USER_BUFFER');
  await select(f);
  await until(async () => (await readFile(join(f.logs, 'fork-0.draft'), 'utf8')).includes('SELECT passage'), 'quote staged unsent');
  await until(async () => !(await readdir(f.state.directory)).some(name => /\.txt$|^quote-|^request-|^opening\.lock$/.test(name)), 'transfer files removed');
  assert.equal(await tmux(f.state, 'list-buffers', '-F', '#{buffer_name}'), 'unrelated-user-buffer');
  await closeScratchpad(f.state);
  await clearScratchpad(f.state);
  assert.equal(await tmux(f.state, 'list-buffers', '-F', '#{buffer_name}'), 'unrelated-user-buffer');
  assert.equal(await tmux(f.state, 'show-buffer', '-b', 'unrelated-user-buffer'), 'KEEP_EXISTING_USER_BUFFER');
  await assert.rejects(access(join(f.logs, 'main.transcript')));
  await assert.rejects(access(join(f.logs, 'fork.transcript')));
});

test('rejected selection leaves no automatic paste buffer', async t => {
  const f = await attachedFixture(t);
  await f.metadata({ active: true });
  await select(f);
  await until(async () => (await tmux(f.state, 'show-messages')).includes('active'), 'active parent rejected');
  assert.equal(await tmux(f.state, 'list-buffers', '-F', '#{buffer_name}'), '');
  assert.equal((await records(f.logs, 'fork')).length, 0);
});

test('helper diagnostic text displays tmux-looking native flags literally', async t => {
  const flag = '--audit-#{session_name}';
  const f = await attachedFixture(t, async f => { f.options.nativeArgs.push(flag); });
  await select(f);
  const message = await until(async () => {
    const log = (await tmux(f.state, 'show-messages')).split('\n').filter(line => line.includes(' message: ')).join('\n');
    return log.includes('cannot preserve native option') && log;
  }, 'unsupported flag diagnostic');
  assert.ok(message.includes(flag), 'diagnostic must not expand tmux formats');
  assert.equal((await records(f.logs, 'fork')).length, 0);
});
