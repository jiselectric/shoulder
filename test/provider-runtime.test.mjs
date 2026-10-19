import test from 'node:test';
import assert from 'node:assert/strict';
import { openScratchpad } from '../dist/runtime.js';
import { fixture, records, tmux } from './runtime-fixture.mjs';

test('unavailable Claude side insertion refuses before launching an unusable side', async t => {
  const f = await fixture(t, { provider: 'claude' });
  await assert.rejects(openScratchpad(f.state, 'A selected passage'), /Claude side drafts are not yet supported/);
  assert.equal(await tmux(f.state, 'list-panes', '-a', '-F', '#{pane_id}'), f.state.mainPane);
  assert.equal((await records(f.logs, 'fork')).length, 0);
});
