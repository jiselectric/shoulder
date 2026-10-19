#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime, cleanup } from '../dist/runtime.js';
import { SESSION_FOOTER } from '../dist/codex.js';
import { exec, until } from '../test/runtime-fixture.mjs';

// This is an acceptance harness, not a provider performance benchmark.
const dimensions = { columns: 120, rows: 40 };
process.stdout.columns = dimensions.columns;
process.stdout.rows = dimensions.rows;
const directory = await mkdtemp('/tmp/shoulder-bench-');
const provider = join(directory, 'fixed provider.mjs');
let work = join(directory, 'work');
const id = '12345678-1234-4234-8234-123456789abc';
const nativeArgs = ['--no-alt-screen'];
const previous = process.env.SIDE_ASK_BENCH_RECORD;
let activeState;
let baselineSocket;
await mkdir(work);
work = await realpath(work);
await writeFile(provider, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const launched = process.hrtime.bigint();
for (let n=0;n<32;n++) console.log('fixed output '+n);
console.log('SIDE_ASK_BENCH_READY');
const ready = process.hrtime.bigint();
writeFileSync(process.env.SIDE_ASK_BENCH_RECORD, JSON.stringify({launched:String(launched),ready:String(ready),args:process.argv.slice(2),cwd:process.cwd(),columns:process.stdout.columns,rows:process.stdout.rows}));
setInterval(()=>{},1000);
`, { mode: 0o755 });
const samples = [];
// Match Shoulder’s role-label row so the native processes get identical PTYs.
const baselineConfig = join(directory, 'baseline.conf');
await writeFile(baselineConfig, 'set-window-option -g pane-border-status bottom\n');
async function sample(kind, index) {
  const recordFile = join(directory, `${kind}-${index}.json`);
  process.env.SIDE_ASK_BENCH_RECORD = recordFile;
  const started = process.hrtime.bigint();
  let socket, pane;
  try {
    if (kind === 'baseline') {
      baselineSocket = socket = join(directory, 'baseline.sock');
      const result = await exec('tmux', ['-f', baselineConfig, '-S', socket, 'new-session', '-d', '-s', 'baseline', '-x', String(dimensions.columns), '-y', String(dimensions.rows), '-P', '-F', '#{pane_id}', '-c', work, provider, 'resume', id, ...nativeArgs, '--config', SESSION_FOOTER]);
      pane = result.stdout.trim();
      assert.match(pane, /^%\d+$/, 'Baseline must create a real tmux pane');
    } else {
      activeState = await createRuntime({ provider:'codex', sessionId: id, nativeArgs, cwd: work, codexPath: provider });
      socket = activeState.socket;
      pane = activeState.mainPane;
    }
    const returned = process.hrtime.bigint();
    const record = await until(async () => JSON.parse(await readFile(recordFile, 'utf8')), `${kind} ready output`);
    const { stdout } = await exec('tmux', ['-S', socket, 'capture-pane', '-p', '-t', pane]);
    assert.match(stdout, /SIDE_ASK_BENCH_READY/, 'Ready marker must reach tmux without a wrapper relay');
    assert.deepEqual(record.args, ['resume', id, '--no-alt-screen', '--config', SESSION_FOOTER]);
    assert.equal(record.cwd, work);
    assert.equal(record.columns, dimensions.columns);
    assert.equal(record.rows, dimensions.rows - 1, 'Both providers must receive the same tmux pane height after the role-label row');
    const milliseconds = value => Number(value - started) / 1e6;
    samples.push({ kind, sample: index + 1, launchMs: milliseconds(BigInt(record.launched)), readyMs: milliseconds(BigInt(record.ready)), orchestrationReturnMs: milliseconds(returned) });
  } finally {
    if (activeState) { await cleanup(activeState); activeState = undefined; }
    if (baselineSocket) { await exec('tmux', ['-S', baselineSocket, 'kill-server']).catch(() => {}); baselineSocket = undefined; }
  }
}
try {
  // Alternating first position reduces simple warm-cache/order bias.
  for (let index = 0; index < 5; index++) {
    for (const kind of index % 2 ? ['wrapper', 'baseline'] : ['baseline', 'wrapper']) await sample(kind, index);
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(['baseline', 'wrapper'].map(kind => {
    const rows = samples.filter(row => row.kind === kind);
    return [kind, Object.fromEntries(['launchMs', 'readyMs', 'orchestrationReturnMs'].map(key => [key, Number(median(rows.map(row => row[key])).toFixed(3))]))];
  }));
  console.log(JSON.stringify({ provider: 'deterministic fake; no model/network calls', dimensions, nativePane: { columns: dimensions.columns, rows: dimensions.rows - 1 }, samplesPerMode: 5, unit: 'milliseconds', median: summary, wrapperMinusBaselineReadyMs: Number((summary.wrapper.readyMs - summary.baseline.readyMs).toFixed(3)), samples: samples.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? Number(value.toFixed(3)) : value]))), limits: 'Headless real tmux; both modes include one role-label row. Readiness timestamp follows fixed output writes. Measures createRuntime setup/process startup; excludes public CLI/doctor preflight, attached client, authentication, model and network latency. No universal overhead claim.' }, null, 2));
} finally {
  if (activeState) await cleanup(activeState);
  if (baselineSocket) await exec('tmux', ['-S', baselineSocket, 'kill-server']).catch(() => {});
  if (previous === undefined) delete process.env.SIDE_ASK_BENCH_RECORD;
  else process.env.SIDE_ASK_BENCH_RECORD = previous;
  await rm(directory, { recursive: true, force: true });
}
