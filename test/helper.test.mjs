import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { attachedFixture, tmux, until, records, exec } from './runtime-fixture.mjs';
import { openScratchpad } from '../dist/runtime.js';

test('native main exit still reaps its live side when outcome persistence fails',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'OUTCOME_WRITE_FAILURE');
  const helpers=(await tmux(f.state,'list-panes','-a','-F','#{pane_pid}')).split('\n').map(Number);
  const providers=[...(await records(f.logs,'main')),...(await records(f.logs,'fork'))].map(record=>record.pid);
  await rm(dirname(f.state.mainOutcomeFile),{recursive:true,force:true});
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/exit','Enter');
  await until(async()=>{try{await access(f.state.directory);return false;}catch(error){return error.code==='ENOENT';}},'runtime reaped after outcome failure');
  await until(async()=>helpers.every(pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}}),'both helpers released after outcome failure');
  await until(async()=>providers.every(pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}}),'both providers released after outcome failure');
  await until(async()=>{try{return await readFile(f.result,'utf8');}catch{return false;}},'launcher returns after outcome failure');
  assert.notEqual(await readFile(f.result,'utf8'),'0','a missing native outcome cannot report success');
});

test('main helper exits when PTY teardown races removal of its outcome owner',async t=>{
  const f=await attachedFixture(t);
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('NATIVE_READY'));
  const pid=Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_pid}'));
  assert.ok(Number.isInteger(pid)&&pid>0);
  await rm(dirname(f.state.mainOutcomeFile),{recursive:true,force:true});
  await tmux(f.outerState,'kill-server');
  await until(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}},'main helper exits after failed outcome write',3000);
});

test('generic native main failures identify the executable without a Codex resume hint',async t=>{
  const f=await attachedFixture(t,async f=>{f.options.provider='generic';});
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/exit7','Enter');
  await until(async()=>{try{return await readFile(f.result,'utf8');}catch{return false;}},'generic native failure result');
  assert.equal(await readFile(f.result,'utf8'),'7');
  const screen=await tmux(f.outerState,'capture-pane','-p','-t','%0');
  assert.match(screen,/shoulder: Native executable exited with status 7/);
  assert.doesNotMatch(screen,/Native Codex|codex resume/);
});

test('intentional attached client detach exits successfully and reaps the native runtime',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'DETACH_CLEANUP');
  const client=await tmux(f.state,'list-clients','-F','#{client_tty}');
  assert.ok(client);
  await tmux(f.state,'detach-client','-t',client);
  await until(async()=>{try{return await readFile(f.result,'utf8');}catch{return false;}},'intentional detach result');
  assert.equal(await readFile(f.result,'utf8'),'0');
  await assert.rejects(access(f.state.directory),{code:'ENOENT'});
});

test('an error pane left in raw mode stays readable until Enter is pressed',async t=>{
  const f=await attachedFixture(t);
  await writeFile(join(f.logs,'fail-fork'),'');
  await assert.rejects(openScratchpad(f.state,'FAILED_SIDE'),/ready|exited|native/i);
  const side=f.state.sidePane;
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',side)).replace(/\s+/g,' ').includes('Press Enter to close this pane.'),'readable side error');
  const tty=await tmux(f.state,'display-message','-p','-t',side,'#{pane_tty}');
  await exec('stty',[process.platform==='darwin'?'-f':'-F',tty,'raw','-echo']);
  await tmux(f.state,'send-keys','-t',side,'-l','x');
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.match((await tmux(f.state,'capture-pane','-p','-t',side)).replace(/\s+/g,' '),/Press Enter to close this pane\./);
  await tmux(f.state,'send-keys','-t',side,'Enter');
  await until(async()=>(await tmux(f.state,'list-panes','-F','#{pane_id}'))===f.state.mainPane,'Enter closes failed side');
});

test('intentional detach tolerates a real late outcome writer during directory removal', async t => {
  const f = await attachedFixture(t, async f => {
    const previousOptions = process.env.NODE_OPTIONS;
    const previousMarker = process.env.SHOULDER_TEST_LATE_OUTCOME_MARKER;
    process.env.NODE_OPTIONS = `${previousOptions ?? ''} --require=${JSON.stringify(resolve('test/fixtures/late-outcome-writer.cjs'))}`.trim();
    process.env.SHOULDER_TEST_LATE_OUTCOME_MARKER = join(f.logs, 'late-outcome-race.jsonl');
    t.after(() => {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
      if (previousMarker === undefined) delete process.env.SHOULDER_TEST_LATE_OUTCOME_MARKER; else process.env.SHOULDER_TEST_LATE_OUTCOME_MARKER = previousMarker;
    });
  });
  await openScratchpad(f.state, 'DETERMINISTIC_LATE_OUTCOME');
  const client = await tmux(f.state, 'list-clients', '-F', '#{client_tty}');
  await tmux(f.state, 'detach-client', '-t', client);
  await until(async () => await tmux(f.outerState, 'display-message', '-p', '-t', '%0', '#{pane_dead}') === '1', 'launcher exits after late outcome write');
  const evidence = (await readFile(join(f.logs, 'late-outcome-race.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  t.after(async () => {
    for (const entry of evidence) await rm(entry.directory, { recursive: true, force: true });
  });
  assert.ok(evidence.some(entry => entry.code === 'ENOTEMPTY' && entry.attempt === 2), 'real OS directory-removal race occurred');
  const result = await readFile(f.result, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const screen = await tmux(f.outerState, 'capture-pane', '-p', '-t', '%0');
  assert.equal(result, '0', `detach must restore the terminal and return success after transient outcome cleanup failure:\n${screen}`);
  await assert.rejects(access(f.state.directory), { code: 'ENOENT' });
  for (const entry of evidence) await assert.rejects(access(entry.directory), { code: 'ENOENT' });
});
