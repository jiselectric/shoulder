import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('welcome presentation ignores old first-launch state and does not write preferences', async t => {
  const { loadPresentation } = await import('../dist/presentation.js');
  const directory = await mkdtemp('/tmp/shoulder-welcome-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'shldr'));
  await writeFile(join(directory, 'shldr', 'welcome-v1'), 'old marker');
  const env = { XDG_STATE_HOME: directory, TERM: 'xterm-256color' };
  for (let i = 0; i < 2; i++) {
    const presentation = await loadPresentation(env);
    assert.equal(presentation.color, true);
    assert.match(presentation.version, /^\d+\.\d+\.\d+/);
    assert.equal(presentation.marker, undefined);
  }
  assert.deepEqual(await readdir(directory), ['shldr']);
  assert.equal(await readFile(join(directory, 'shldr', 'welcome-v1'), 'utf8'), 'old marker');
});

test('NO_COLOR and basic terminals disable Shoulder accents', async () => {
  const { loadPresentation } = await import('../dist/presentation.js');
  assert.equal((await loadPresentation({ NO_COLOR: '1', TERM: 'xterm-256color' })).color, false);
  assert.equal((await loadPresentation({ TERM: 'dumb' })).color, false);
});

test('the left-aligned header shows only the wordmark, version, intro and controls', async () => {
  const { startupHeader } = await import('../dist/presentation.js');
  const rows = startupHeader({ color: false, version: '1.2.3' }, 'codex');
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.startsWith('#[align=left]')));
  assert.match(rows.join('\n'), /Room for a side question\./);
  assert.ok(rows.join('\n').includes('Ctrl+\\  switch panes'));
  assert.match(rows.join('\n'), /Ctrl\+Q  open\/close/);
  assert.match(rows.join('\n'), /Ctrl-b c clear.*b banner/);
  assert.match(startupHeader({ color: false, version: '1.2.3' }, 'codex', false).join('\n'), /Ctrl-b o.*switch panes/);
  assert.doesNotMatch(rows.join('\n'), /MAIN ROAD|SHOULDER|\[\?\]|align=centre/);
  assert.match(rows.join('\n'), /v1\.2\.3/);
  assert.doesNotMatch(rows.join('\n'), /\x1b|fg=cyan|Enter.*open/);
  assert.match(startupHeader({ color: false, version: '1.2.3' }, 'claude').join('\n'), /main only/);
});
