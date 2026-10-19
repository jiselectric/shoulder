#!/usr/bin/env node
// Source-repository acceptance harness: real PTYs/tmux; deterministic fake Codex.
// Build once before running. Do not rebuild dist while this harness is active.
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { attachedFixture, exec, records, tmux, until } from '../test/runtime-fixture.mjs';
import { clearScratchpad, closeScratchpad, loadState, openScratchpad, toggleScratchpad } from '../dist/runtime.js';
import { parseComposerFooter } from '../dist/session.js';
import { selectionDraft } from '../dist/draft.js';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--cycles'), 'Usage: node scripts/stress.mjs [--cycles 40]');
const cycles = args.length ? Number(args[1]) : 40;
assert.ok(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 1000, 'cycles must be an integer from 1 to 1000');
await access(resolve('test/fixtures/fake-codex.mjs'));
const started = performance.now();
const hooks = [], ownedPids = new Set(), retiredPids = new Set();
const mouseEvidence = [];
const counts = { quoteStages: 0, typedDrafts: 0, closes: 0, reopens: 0, clears: 0, mouseSelections: 0, resizeRecoveries: 0, rejectedNarrowReopens: 0, completedCycles: 0 };
let f, summary, failure;
const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function text(path) { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }
const paneValue = (pane, format) => tmux(f.state, 'display-message', '-p', '-t', pane, format);
const snapshot = async () => {
  const current = await loadState(f.state.directory);
  const helper = Number(await paneValue(current.sidePane, '#{pane_pid}'));
  const forks = await records(f.logs, 'fork');
  // readdir is lexical: fork-9 sorts after fork-10. Read the known index.
  const provider = JSON.parse(await readFile(join(f.logs, `fork-${counts.clears}.json`), 'utf8')).pid;
  ownedPids.add(helper); ownedPids.add(provider);
  return { current, pane: current.sidePane, helper, provider, width: await paneValue(current.sidePane, '#{pane_width}'), forkCount: forks.length };
};
async function settled(label) {
  await until(async () => {
    const names = await readdir(f.state.directory);
    return !names.some(name => /^(?:request-|quote-|state-)|^shoulder-.*\.txt$|^(?:opening\.lock|closing)$/.test(name));
  }, `${label}: no action/request/quote residue`);
  assert.equal(await exists(join(f.logs, 'main.transcript')), false, `${label}: no main submission`);
  assert.equal(await exists(join(f.logs, 'fork.transcript')), false, `${label}: no side submission`);
  assert.equal((await records(f.logs, 'main')).length, 1, `${label}: one original main process`);
  assert.equal(Number(await paneValue(f.state.mainPane, '#{pane_pid}')), mainHelper, `${label}: original main helper`);
  assert.equal(await paneValue(f.state.mainPane, '#{pane_in_mode}'), '0', `${label}: main input restored`);
  assert.equal(retiredPids.size === 0 || [...retiredPids].every(gone), true, `${label}: all retired processes gone`);
}
async function sameSide(before, label) {
  const after = await snapshot();
  assert.equal(after.pane, before.pane, `${label}: pane`);
  assert.equal(after.helper, before.helper, `${label}: helper`);
  assert.equal(after.provider, before.provider, `${label}: provider`);
  assert.equal(after.current.sideSessionId, before.current.sideSessionId, `${label}: identity`);
  assert.equal(after.width, before.width, `${label}: divider width`);
  assert.equal(after.forkCount, before.forkCount, `${label}: no restart`);
}
async function selectedQuote(index) {
  // Exercise the attached terminal input path immediately after Clear returns.
  // Mouse reporting is enabled by the fake native process, as in a native TUI.
  await tmux(f.state, 'select-pane', '-t', f.state.mainPane);
  const trace = { cycle: index, startedMs: Number((performance.now() - started).toFixed(3)) };
  mouseEvidence.push(trace);
  // Repeated split/join/resize can expose a partial fake-native repaint. Wait
  // for the actual source text and native idle footer, never a guessed delay.
  trace.beforeMouseScreen = await until(async () => {
    const screen = await tmux(f.state, 'capture-pane', '-p', '-t', f.state.mainPane);
    return screen.startsWith('SELECT passage') && parseComposerFooter(screen) === f.options.sessionId && screen.endsWith('? for shortcuts') && screen;
  }, `cycle ${index}: source repaint ready`);
  for (const event of ['\x1b[<0;1;1M', '\x1b[<32;24;1M']) await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', event);
  await until(async () => (await paneValue(f.state.mainPane, '#{pane_in_mode} #{selection_present}')) === '1 1', `cycle ${index}: drag entered selection mode`);
  trace.beforeRelease = await paneValue(f.state.mainPane, '#{selection_start_x},#{selection_start_y}:#{selection_end_x},#{selection_end_y}:#{copy_cursor_x},#{copy_cursor_y}');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', '\x1b[<0;24;1m');
  await until(async () => (await paneValue(f.state.mainPane, '#{selection_present}')) === '1', `cycle ${index}: direct drag selection`);
  trace.afterRelease = await paneValue(f.state.mainPane, '#{selection_start_x},#{selection_start_y}:#{selection_end_x},#{selection_end_y}:#{copy_cursor_x},#{copy_cursor_y}');
  trace.copyModeScreen = await tmux(f.state, 'capture-pane', '-p', '-M', '-t', f.state.mainPane);
  await tmux(f.state, 'send-keys', '-X', '-t', f.state.mainPane, 'copy-selection-no-clear');
  trace.selectedText = await tmux(f.state, 'show-buffer');
  await tmux(f.outerState, 'send-keys', '-t', '%0', '-l', 'e');
  await until(async () => (await text(join(f.logs, `fork-${index}.draft`))).includes('SELECT passage'), `cycle ${index}: selected quote staged`, 15000);
  await until(async () => (await loadState(f.state.directory)).sideSessionId && !(await exists(join(f.state.directory, 'opening.lock'))), `cycle ${index}: selection action committed`, 15000);
  assert.equal(await text(join(f.logs, `fork-${index}.draft`)), selectionDraft(trace.selectedText), `cycle ${index}: staged quote exactly matches actual tmux selection`);
  counts.mouseSelections++; counts.quoteStages++;
}
let mainHelper;
try {
  f = await attachedFixture({ after: fn => hooks.push(fn) });
  mainHelper = Number(await paneValue(f.state.mainPane, '#{pane_pid}'));
  ownedPids.add(mainHelper); ownedPids.add(f.main.pid);
  ownedPids.add(Number(await readFile(`${f.result}.pid`, 'utf8')));
  await until(async () => (await tmux(f.state, 'capture-pane', '-p', '-t', f.state.mainPane)).includes('NATIVE_READY'), 'main rendered');
  const originalMain = await paneValue(f.state.mainPane, '#{pane_id} #{pane_pid}');
  const mainIdentity = parseComposerFooter(await tmux(f.state, 'capture-pane', '-p', '-t', f.state.mainPane));
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const index = cycle - 1, quote = `CYCLE_${cycle}_ORIGINAL 日本語 \" ' $(touch SHOULD_NOT_EXIST)`;
    const question = `CYCLE_${cycle}_UNSENT_QUESTION`, appended = `CYCLE_${cycle}_APPENDED_QUOTE`;
    await openScratchpad(f.state, quote); counts.quoteStages++;
    const current = await loadState(f.state.directory), pane = current.sidePane;
    await tmux(f.state, 'resize-pane', '-t', pane, '-x', String(49 + cycle % 7));
    await tmux(f.state, 'send-keys', '-t', pane, '-l', question); counts.typedDrafts++;
    await until(async () => (await text(join(f.logs, `fork-${index}.draft`))).includes(question), `cycle ${cycle}: unsent typed question`);
    const before = await snapshot(), draftBefore = await text(join(f.logs, `fork-${index}.draft`));
    await settled(`cycle ${cycle}: initial quote and draft`);
    await closeScratchpad(f.state); counts.closes++;
    assert.equal(await tmux(f.state, 'list-panes', '-t', f.state.mainPane, '-F', '#{pane_id}'), f.state.mainPane);
    assert.equal((await loadState(f.state.directory)).sideHidden, true);
    assert.equal(gone(before.helper), false); assert.equal(gone(before.provider), false);
    await settled(`cycle ${cycle}: closed`);
    if (cycle % 5 === 0) {
      await tmux(f.outerState, 'resize-window', '-x', '90', '-y', '40');
      await until(async () => (await paneValue(f.state.mainPane, '#{window_width}')) === '90', `cycle ${cycle}: narrow terminal`);
      await assert.rejects(toggleScratchpad(f.state), /100|columns/); counts.rejectedNarrowReopens++;
      assert.equal((await loadState(f.state.directory)).sideHidden, true);
      assert.equal(await text(join(f.logs, `fork-${index}.draft`)), draftBefore);
      await tmux(f.outerState, 'resize-window', '-x', '120', '-y', '40');
      await until(async () => (await paneValue(f.state.mainPane, '#{window_width}')) === '120', `cycle ${cycle}: wide terminal restored`);
      counts.resizeRecoveries++;
    }
    await toggleScratchpad(f.state); counts.reopens++;
    await sameSide(before, `cycle ${cycle}: reopen`);
    assert.equal(await text(join(f.logs, `fork-${index}.draft`)), draftBefore);
    await settled(`cycle ${cycle}: reopened`);
    await openScratchpad(f.state, appended); counts.quoteStages++;
    await until(async () => (await text(join(f.logs, `fork-${index}.draft`))).includes(appended), `cycle ${cycle}: appended quote received`);
    const appendedDraft = await text(join(f.logs, `fork-${index}.draft`));
    assert.ok(appendedDraft.includes(quote) && appendedDraft.includes(question) && appendedDraft.includes(appended));
    assert.ok(appendedDraft.indexOf(question) < appendedDraft.indexOf(appended));
    await sameSide(before, `cycle ${cycle}: append`);
    await settled(`cycle ${cycle}: appended`);
    await clearScratchpad(f.state); counts.clears++;
    // Do not wait for the fresh provider before selecting: cover startup handoff.
    await selectedQuote(cycle);
    const after = await snapshot();
    assert.equal(after.pane, before.pane, `cycle ${cycle}: clear retains pane`);
    assert.equal(after.width, before.width, `cycle ${cycle}: clear retains divider width`);
    assert.notEqual(after.helper, before.helper, `cycle ${cycle}: fresh helper`);
    assert.notEqual(after.provider, before.provider, `cycle ${cycle}: fresh provider`);
    assert.notEqual(after.current.sideSessionId, before.current.sideSessionId, `cycle ${cycle}: fresh UUID`);
    assert.ok(after.current.sideSessionId, `cycle ${cycle}: identity after immediate selection`);
    assert.equal(after.forkCount, cycle + 1, `cycle ${cycle}: exactly one process per clear`);
    retiredPids.add(before.helper); retiredPids.add(before.provider);
    await until(() => [...retiredPids].every(gone), `cycle ${cycle}: cleared helpers/providers gone`);
    const freshDraft = await text(join(f.logs, `fork-${cycle}.draft`));
    assert.ok(!freshDraft.includes(quote) && !freshDraft.includes(question) && !freshDraft.includes(appended), `cycle ${cycle}: discarded draft absent`);
    assert.equal(await paneValue(f.state.mainPane, '#{pane_id} #{pane_pid}'), originalMain);
    assert.equal(parseComposerFooter(await tmux(f.state, 'capture-pane', '-p', '-t', f.state.mainPane)), mainIdentity);
    assert.equal(await exists(join(f.work, 'SHOULD_NOT_EXIST')), false, 'shell-looking quote remains data');
    await settled(`cycle ${cycle}: clear and immediate selection`);
    counts.completedCycles++;
    if (cycle % 5 === 0 || cycle === cycles) console.error(`stress: ${cycle}/${cycles} cycles passed (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  }
  await snapshot();
  // Final cleanup starts with the side hidden, exercising parked-pane ownership.
  await closeScratchpad(f.state); counts.closes++;
  await settled('final hidden side');
  // The deterministic console fixture records native forwarded mouse reports
  // as raw draft bytes instead of consuming them as a real TUI would.
  assert.equal(await text(join(f.logs, 'main-0.draft')), '\x1b[<0;1;1M'.repeat(cycles), 'main received only expected native mouse-down reports');
  // Native main exit is the public successful-exit path. Direct kill-server
  // teardown deliberately need not give the attached launcher a zero status.
  await tmux(f.state, 'send-keys', '-t', f.state.mainPane, 'C-u', '/exit', 'Enter');
  await until(() => [...ownedPids].every(gone), 'all observed helpers/providers/launcher exited', 10000);
  assert.equal(await exists(f.state.directory), false, 'private runtime removed');
  await until(async () => (await text(f.result)) === '0', 'attached launcher completion');
  assert.equal(await text(join(f.logs, 'main.transcript')), '/exit\n', 'only the intentional native exit command reached main');
  assert.equal(await exists(join(f.logs, 'fork.transcript')), false, 'no side submission even during cleanup');
  summary = {
    status: 'passed', provider: 'deterministic fake Codex; no model/network calls',
    terminal: 'real isolated tmux server, nested attached PTYs, literal SGR mouse input',
    node: process.version, platform: process.platform, tmux: (await exec('tmux', ['-V'])).stdout.trim(),
    dimensions: { columns: 120, rows: 40, narrowColumns: 90 }, cycles, counts,
    observedProcesses: ownedPids.size, retiredProcesses: retiredPids.size,
    mainProcesses: 1, sideProcesses: cycles + 1, unexpectedSubmissions: 0, intentionalMainExitCommands: 1,
    selectionSamples: mouseEvidence.map(({ cycle, beforeRelease, afterRelease, selectedText }) => ({ cycle, beforeRelease, afterRelease, selectedText })),
    postCleanupProcessesAlive: 0, runtimeDirectoryRemoved: true,
    limits: 'Lifecycle/input acceptance against fake native processes; does not validate real provider layout, authentication, model answers, or network performance.',
  };
} catch (error) {
  failure = error;
  if (f) {
    const evidence = {};
    for (const [label, capture] of [
      ['state', () => loadState(f.state.directory)],
      ['runtimeFiles', () => readdir(f.state.directory)],
      ['panes', () => tmux(f.state, 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_in_mode} #{selection_present} #{pane_width}x#{pane_height}')],
      ['mainScreen', () => tmux(f.state, 'capture-pane', '-p', '-t', f.state.mainPane)],
      ['sideScreen', () => tmux(f.state, 'capture-pane', '-p', '-t', f.state.sidePane)],
      ['outerScreen', () => tmux(f.outerState, 'capture-pane', '-p', '-t', '%0')],
      ['currentDraft', () => text(join(f.logs, `fork-${counts.clears}.draft`))],
      ['mainTranscript', () => text(join(f.logs, 'main.transcript'))],
      ['sideTranscript', () => text(join(f.logs, 'fork.transcript'))],
      ['messages', async () => (await tmux(f.state, 'show-messages')).split('\n').slice(0, 70).join('\n')],
      ['mouseEvidence', () => mouseEvidence],
    ]) { try { evidence[label] = await capture(); } catch (diagnosticError) { evidence[label] = diagnosticError.message; } }
    console.error(JSON.stringify({ failureEvidence: evidence }, null, 2));
  }
}
finally {
  // Fixture hooks only touch their own runtime/socket/temp directories.
  for (const hook of hooks) { try { await hook(); } catch (error) { failure ??= error; } }
}
if (failure) {
  console.error(JSON.stringify({ status: 'failed', cyclesRequested: cycles, counts, durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)), error: failure.stack }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ...summary, durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }, null, 2));
}
