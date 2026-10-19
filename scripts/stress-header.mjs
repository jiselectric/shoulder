#!/usr/bin/env node
// Build once before running. Real attached terminal, deterministic native CLI.
import assert from 'node:assert/strict';
import { access, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { attachedFixture, tmux, until, records } from '../test/runtime-fixture.mjs';
import { openScratchpad, loadState } from '../dist/runtime.js';
import { shellQuote } from '../dist/tmux.js';
import { parseComposerFooter } from '../dist/session.js';
import { selectionDraft } from '../dist/draft.js';

const cycles = Number(process.argv[2] ?? 50);
assert.ok(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= 1000, 'Usage: node scripts/stress-header.mjs [50]');
const hooks = [], oldPath = process.env.PATH, started = performance.now();
const counts = { completedCycles: 0, directFocus: 0, directToggle: 0, bannerToggles: 0, clears: 0, mouseSelections: 0, resizes: 0 };
let f, currentCycle = -1;
async function failureEvidence() {
  const state = await loadState(f.state.directory).catch(error => ({ error: error.message }));
  const inventory = await readdir(f.logs);
  const forkFiles = await Promise.all(inventory.filter(name => /^fork-.*\.json$/.test(name)).sort().map(async name => {
    try {
      const raw = await readFile(join(f.logs, name), 'utf8');
      try { const record = JSON.parse(raw); return { name, bytes: Buffer.byteLength(raw), pid: record.pid }; }
      catch (error) { return { name, bytes: Buffer.byteLength(raw), parseError: error.message, raw: raw.slice(0, 512) }; }
    } catch (error) { return { name, readError: error.message }; }
  }));
  const markers = {};
  for (const name of ['closing', 'opening.lock']) {
    try {
      await access(join(f.state.directory, name));
      markers[name] = name === 'closing' ? await readFile(join(f.state.directory, name), 'utf8') : 'present';
    } catch (error) { markers[name] = error.code; }
  }
  const frames = {};
  for (const [role, id] of [['main', state.mainPane], ['side', state.sidePane]]) {
    if (!id) continue;
    const screen = await tmux(f.state, 'capture-pane', '-p', '-t', id).catch(error => error.message);
    let identity;
    try { identity = parseComposerFooter(screen); } catch (error) { identity = error.message; }
    frames[role] = { pane: id, identity, screen };
  }
  return { cycle: currentCycle, expectedForkRecordsAfterClear: currentCycle + 2, actualForkFileCount: forkFiles.length, forkFiles, inventory,
    state: { mainPane: state.mainPane, sidePane: state.sidePane, sideSessionId: state.sideSessionId, sidePreviousSessionId: state.sidePreviousSessionId,
      sideParentId: state.sideParentId, sideHidden: state.sideHidden, sideUnsaved: state.sideUnsaved, error: state.error }, markers, frames };
}
// tmux 3.6a groups presses of the same button, even at different coordinates,
// for 300 ms. A second press can emit a delayed DoubleClick at the pane and
// cancel a subsequent selection. These are distinct gestures, not multi-clicks.
// https://github.com/tmux/tmux/blob/3.6a/tmux.h (KEYC_CLICK_TIMEOUT)
const gestureGapMs = 350;
let lastMouseGestureEnded = -Infinity;
async function separateMouseGesture() {
  const remaining = lastMouseGestureEnded + gestureGapMs - performance.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  // Also let the inner server handle its expired click timer before new input.
  await tmux(f.state, 'display-message', '-p', '#{session_id}');
}
async function mouseGesture(events) {
  await separateMouseGesture();
  for (const event of events) await control(event);
  lastMouseGestureEnded = performance.now();
}
async function nativeFramesReady() {
  let previous;
  await until(async () => {
    const current = await loadState(f.state.directory);
    try { await access(join(f.state.directory, 'opening.lock')); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const main = await tmux(f.state, 'capture-pane', '-p', '-t', current.mainPane);
    if (!main.startsWith('SELECT passage') || parseComposerFooter(main) !== f.options.sessionId) return false;
    let side = '';
    if (current.sidePane) {
      side = await tmux(f.state, 'capture-pane', '-p', '-t', current.sidePane);
      if (!current.sideSessionId || parseComposerFooter(side) !== current.sideSessionId) return false;
    }
    const frame = JSON.stringify([main, side]);
    const stable = frame === previous;
    previous = frame;
    return stable;
  }, 'complete stable native composer frames after resize', 15000);
}
async function click(label) {
  await separateMouseGesture();
  const rows = await until(async () => {
    const rows = (await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')).split('\n');
    return rows.some(row => row.includes(label)) && rows;
  }, label);
  const y = rows.findIndex(row => row.includes(label)), x = rows[y].indexOf(label) + 3;
  for (const end of ['M', 'm']) await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', `\x1b[<0;${x};${y + 1}${end}`);
  lastMouseGestureEnded = performance.now();
  counts.bannerToggles++;
}
const pane = (id, format) => tmux(f.state, 'display-message', '-p', '-t', id, format);
const control = value => tmux(f.outerState, 'send-keys', '-t', '%0', '-l', value);
try {
  f = await attachedFixture({ after: fn => hooks.push(fn) }, async fixture => {
    fixture.options.publicCli = true;
    fixture.options.showBanner = true;
    fixture.options.nativeArgs.unshift('resume', fixture.options.sessionId);
    await symlink(fixture.options.codexPath, join(fixture.dir, 'codex'));
    process.env.PATH = `${fixture.dir}:${oldPath ?? ''}`;
  });
  const mainPid = f.main.pid;
  for (let i = 0; i < cycles; i++) {
    currentCycle = i;
    await nativeFramesReady();
    await openScratchpad(f.state, `HEADER_STRESS_QUOTE_${i}`);
    const before = await loadState(f.state.directory), draftPath = join(f.logs, `fork-${i}.draft`);
    const draft = ` HEADER_STRESS_UNSENT_${i}`;
    await control(draft);
    await until(async () => (await readFile(draftPath, 'utf8')).includes(draft), 'typed draft');
    await control('\x1c'); counts.directFocus++;
    await until(async () => await pane(before.mainPane, '#{pane_active}') === '1', 'direct main focus');
    await control('\x1c'); counts.directFocus++;
    await until(async () => await pane(before.sidePane, '#{pane_active}') === '1', 'direct side focus');
    await click('[Hide banner]');
    await until(async () => await tmux(f.state, 'show-options', '-gv', 'status-position') === 'bottom', 'banner hidden');
    await control('\x11'); counts.directToggle++;
    await until(async () => (await loadState(f.state.directory)).sideHidden, 'direct close');
    await click('[Show banner]');
    await until(async () => await tmux(f.state, 'show-options', '-gv', 'status') === '5', 'banner shown');
    await control('\x11'); counts.directToggle++;
    await until(async () => !(await loadState(f.state.directory)).sideHidden, 'direct reopen');
    assert.equal((await loadState(f.state.directory)).sidePane, before.sidePane);
    assert.match(await readFile(draftPath, 'utf8'), new RegExp(`HEADER_STRESS_UNSENT_${i}`));
    await tmux(f.outerState, 'send-keys', '-t', '%0', 'C-b', 'c'); counts.clears++;
    await until(async () => (await records(f.logs, 'fork')).length === i + 2, 'keyboard clear');
    await until(async () => {
      const screen = await tmux(f.state, 'capture-pane', '-p', '-t', before.sidePane);
      return screen.includes('FORK_READY') && parseComposerFooter(screen);
    }, 'fresh side composer');
    const headerRows = await tmux(f.state, 'show-options', '-gv', 'status-position') === 'top' ? Number(await tmux(f.state, 'show-options', '-gv', 'status')) : 0;
    const top = Number(await pane(before.mainPane, '#{pane_top}')) + headerRows + 1;
    const left = Number(await pane(before.mainPane, '#{pane_left}')) + 1;
    await until(async () => (await tmux(f.state, 'capture-pane', '-p', '-t', before.mainPane)).startsWith('SELECT passage'), 'source paint');
    await mouseGesture([`\x1b[<0;${left};${top}M`, `\x1b[<32;${left + 23};${top}M`, `\x1b[<0;${left + 23};${top}m`]);
    await until(async () => await pane(before.mainPane, '#{selection_present}') === '1', 'header-offset mouse selection');
    const capture = join(f.dir, `selected-${i}.txt`);
    await tmux(f.state, 'send-keys', '-X', '-t', before.mainPane, 'copy-pipe-no-clear', '-CP', `cat > ${shellQuote(capture)}`);
    const selected = await until(async () => await readFile(capture, 'utf8'), 'selected text trace');
    assert.ok(selected.startsWith('SELECT passage'), 'actual selection contains the source passage');
    await control('e'); counts.mouseSelections++;
    await until(async () => (await readFile(join(f.logs, `fork-${i + 1}.draft`), 'utf8')).includes('SELECT passage'), 'post-clear mouse quote');
    assert.equal(await readFile(join(f.logs, `fork-${i + 1}.draft`), 'utf8'), selectionDraft(selected), 'staged draft exactly matches the actual selection');
    await until(async () => !(await readdir(f.state.directory)).some(name => /\.txt$|^request-|^quote-|^opening\.lock$/.test(name)), 'private transfer cleanup');
    assert.equal(await tmux(f.state, 'list-buffers', '-F', '#{buffer_name}'), '', 'no quote paste buffers');
    for (const [x, y, status] of [[80, 24, 'on'], [120, 40, '5']]) {
      await tmux(f.outerState, 'resize-window', '-x', String(x), '-y', String(y)); counts.resizes++;
      await until(async () => await tmux(f.state, 'show-options', '-gv', 'status') === status, 'responsive header');
    }
    await nativeFramesReady();
    assert.equal((await records(f.logs, 'main'))[0].pid, mainPid);
    for (const kind of ['main', 'fork']) await assert.rejects(access(join(f.logs, `${kind}.transcript`)));
    counts.completedCycles++;
    if ((i + 1) % 10 === 0 || i + 1 === cycles) console.error(`header stress: ${i + 1}/${cycles} passed`);
  }
  const providerPids = [...await records(f.logs, 'main'), ...await records(f.logs, 'fork')].map(record => record.pid);
  await tmux(f.state, 'send-keys', '-t', f.state.mainPane, 'C-u', '/exit', 'Enter');
  await until(async () => await readFile(f.result, 'utf8') === '0', 'native exit');
  await assert.rejects(access(f.state.directory), { code: 'ENOENT' });
  await until(() => providerPids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }), 'owned providers exited');
  console.log(JSON.stringify({ status: 'passed', cycles, counts, elapsedMs: Math.round(performance.now() - started), terminal: 'real attached tmux PTYs, public CLI, raw control/SGR bytes', provider: 'deterministic fake; no model/network requests', providerProcesses: providerPids.length, runtimeRemoved: true, unexpectedSubmissions: 0 }, null, 2));
} catch (error) {
  if (f) console.error(JSON.stringify({counts, evidence: await failureEvidence().catch(error => ({ error: error.message })), panes: await tmux(f.state, 'list-panes', '-F', '#{pane_id} top=#{pane_top} left=#{pane_left} selected=#{selection_present}').catch(() => ''), status: await tmux(f.state, 'show-options', '-gv', 'status').catch(() => ''), messages: await tmux(f.state, 'show-messages').catch(() => ''), screen: await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0').catch(() => '')}, null, 2));
  throw error;
} finally {
  for (const hook of hooks) await hook();
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
}
