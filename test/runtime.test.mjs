import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, readdir, writeFile, access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRuntime, openScratchpad, cleanup } from '../dist/runtime.js';
import { parseComposerFooter } from '../dist/session.js';
import { fixture, launchFixture, attachedFixture, freshFixture, freshId, tmux, records, until, exec, id } from './runtime-fixture.mjs';

test('private production runtime launches native main with exact argv and full width',async t=>{
  const f=await fixture(t);
  const [main]=await records(f.logs,'main');
  assert.deepEqual(main.args,['resume',id,'--profile','name with 日本語','--no-alt-screen','--config','tui.status_line=["session-id","model-with-reasoning","context-remaining","current-dir"]']);
  assert.equal(main.cwd,await import('node:fs/promises').then(fs=>fs.realpath(f.dir)));
  assert.equal((await tmux(f.state,'list-panes','-F','#{pane_id}')).split('\n').length,1);
  assert.equal(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_width}'),'120');
  assert.equal((await stat(f.state.directory)).mode&0o777,0o700);
  for(const file of await readdir(f.state.directory)) assert.equal((await stat(join(f.state.directory,file))).mode&0o077,0);
  assert.equal(await tmux(f.state,'show-options','-gv','status-right'),'Finish a main answer');
  // No metadata scan before the first side action.
  await writeFile(f.file,'unsupported data\n');
  assert.equal((await records(f.logs,'main')).length,1);
});
test('native fork stages unsent quotes with saved settings/cwd; concurrent requests reuse one side',async t=>{
  const f=await fixture(t);
  const selection="SIDE_ONLY 日本語\n' \" `touch marker` $(touch marker) ; & | \\ ";
  await Promise.all(Array.from({length:6},()=>openScratchpad(f.state,selection)));
  await until(async()=>(await records(f.logs,'fork')).length===1,'one native fork');
  const [fork]=await records(f.logs,'fork');
  assert.ok(!fork.args.includes('fork')); assert.ok(fork.args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(id)));
  assert.equal(fork.args.includes('--last'),false);
  assert.equal(fork.args[fork.args.indexOf('--model')+1],'effective-current');
  assert.equal(fork.args[fork.args.indexOf('--config')+1],'model_reasoning_effort="high"');
  assert.equal(fork.cwd,await import('node:fs/promises').then(fs=>fs.realpath(f.work)));
  assert.equal(fork.args.some(arg=>arg.includes('SIDE_ONLY')),false);
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes(selection.trimEnd()),'literal selection staged without submission');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await openScratchpad(f.state,'A_DIFFERENT_QUOTE');
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('A_DIFFERENT_QUOTE'),'new quote appended to native draft');
  assert.ok((await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('SIDE_ONLY'));
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  assert.equal((await records(f.logs,'fork')).length,1);
  assert.equal((await tmux(f.state,'list-panes','-F','#{pane_id}')).split('\n').length,2);
  assert.equal(await tmux(f.state,'display-message','-p','-t',f.state.sidePane,'#{pane_width}'),'48');
  assert.equal((await readFile(join(f.state.directory,'state.json'),'utf8')).includes('SIDE_ONLY'),false);
  await assert.rejects(access(join(f.work,'marker')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
});
test('invalid selections and narrow windows leave main unchanged and do not fork',async t=>{
  const f=await fixture(t);
  for(const selection of ['   ','x'.repeat(16385),'\x1b[31m\x00']) await assert.rejects(openScratchpad(f.state,selection));
  for(const [x,y] of [['99','40'],['120','19']]) {
    await tmux(f.state,'resize-window','-x',x,'-y',y);
    await assert.rejects(openScratchpad(f.state,'quote'),/100|20|small|narrow/);
  }
  assert.equal((await records(f.logs,'fork')).length,0);
  assert.equal(await tmux(f.state,'list-panes','-F','#{pane_id}'),f.state.mainPane);
});
test('explicit fallback requires missing-settings plus verified cwd and never bypasses active or unknown state',async t=>{
  const f=await fixture(t,{sideModel:'explicit',sideEffort:'medium'});
  for(const shape of [{active:true},{identity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{missing:true,cwd:'relative'}]) {
    await f.metadata(shape); await assert.rejects(openScratchpad(f.state,'quote'));
  }
  await writeFile(f.file,'bad\n'); await assert.rejects(openScratchpad(f.state,'quote'));
  await f.metadata({missing:true}); await openScratchpad(f.state,'fallback');
  await until(async()=>(await records(f.logs,'fork')).length===1);
  const [fork]=await records(f.logs,'fork');
  assert.equal(fork.cwd,await import('node:fs/promises').then(fs=>fs.realpath(f.work)));
  assert.equal(fork.args[fork.args.indexOf('--model')+1],'explicit');
});
test('missing settings without both explicit values refuses to fork',async t=>{
  const f=await fixture(t,{sideModel:'explicit'}); await f.metadata({missing:true});
  await assert.rejects(openScratchpad(f.state,'quote'),/effort|settings/);
  assert.equal((await records(f.logs,'fork')).length,0);
});
test('scratchpad exit restores main width and permits a fresh independent fork',async t=>{
  const f=await fixture(t); await openScratchpad(f.state,'first');
  await until(async()=>(await records(f.logs,'fork')).length===1);
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/exit','Enter');
  await until(async()=>(await tmux(f.state,'list-panes','-F','#{pane_id}'))===f.state.mainPane,'side closure');
  assert.equal(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_width}'),'120');
  await openScratchpad(f.state,'second'); await until(async()=>(await records(f.logs,'fork')).length===2);
  assert.equal((await records(f.logs,'main')).length,1);
});
test('fork failure stays readable until acknowledged while main remains native',async t=>{
  const f=await fixture(t); await writeFile(join(f.logs,'fail-fork'),'');
  await assert.rejects(openScratchpad(f.state,'failure'),/ready|exited|idle|native/i);
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.sidePane)).includes('FAKE_PROVIDER_ERROR'),'provider failure visible');
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'main-still-works','Enter');
  await until(async()=>(await readFile(join(f.logs,'main.transcript'),'utf8')).includes('main-still-works'));
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'Enter');
  await until(async()=>(await tmux(f.state,'list-panes','-F','#{pane_id}'))===f.state.mainPane);
});
test('tmux forced side closure preserves main and forced main closure reaps its server',async t=>{
  const f=await fixture(t); await openScratchpad(f.state,'first');
  await until(async()=>(await records(f.logs,'fork')).length===1);
  await tmux(f.state,'kill-pane','-t',f.state.sidePane);
  assert.equal(await tmux(f.state,'list-panes','-F','#{pane_id}'),f.state.mainPane);
  // Killing the side resizes the native main asynchronously. Wait for its
  // complete input footer, rather than capturing a console-fixture repaint.
  await until(async()=>parseComposerFooter(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane))===id,'main input ready after resize');
  await openScratchpad(f.state,'second');
  await until(async()=>(await records(f.logs,'fork')).length===2);
  const all=[...(await records(f.logs,'main')),...(await records(f.logs,'fork'))];
  await tmux(f.state,'kill-pane','-t',f.state.mainPane);
  await until(async()=>{try{await access(f.state.directory);return false;}catch{return true;}},'forced main cleanup');
  await until(async()=>all.every(x=>{try{process.kill(x.pid,0);return false;}catch{return true;}}),'closed pane providers stopped');
});
test('main exit cleans owned runtime and repeated cleanup leaves unrelated server alive',async t=>{
  const f=await fixture(t);
  const socket=join(f.dir,'unrelated.sock');
  await exec('tmux',['-f','/dev/null','-S',socket,'new-session','-d','-s','unrelated']);
  t.after(()=>exec('tmux',['-S',socket,'kill-server']).catch(()=>{}));
  assert.match((await exec('tmux',['-S',socket,'list-panes'])).stdout,/0:/);
  await openScratchpad(f.state,'quote');
  await until(async()=>(await records(f.logs,'fork')).length===1);
  const all=[...(await records(f.logs,'main')),...(await records(f.logs,'fork'))];
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/exit','Enter');
  await until(async()=>{try{await access(f.state.directory);return false;}catch{return true;}},'runtime removal');
  await until(async()=>all.every(x=>{try{process.kill(x.pid,0);return false;}catch{return true;}}),'owned providers reaped');
  await cleanup(f.state); await cleanup(f.state);
  assert.match((await exec('tmux',['-S',socket,'list-panes'])).stdout,/0:/);
});
test('launch rejects non-TTY and nested tmux before starting provider',async()=>{
  const cli=resolve('dist/cli.js');
  for(const env of [{...process.env,TMUX:''},{...process.env,TMUX:'existing'}]) {
    await assert.rejects(exec(process.execPath,[cli,'codex','--session',id],{env}),error=>/TTY|terminal|tmux/i.test(error.stderr)&& !/not yet implemented/.test(error.stderr));
  }
});
test('independent selection helpers serialize simultaneous unsent drafts into one fork',async t=>{
  const f=await fixture(t);
  const helper=resolve('dist/helper.js');
  await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[helper,'selection',f.state.directory],{stdio:['pipe','pipe','pipe']});
    child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error(`helper ${code}`)));
    child.stdin.end(`concurrent selection ${i}`);
  })));
  await until(async()=>(await records(f.logs,'fork')).length===1);
  assert.equal((await tmux(f.state,'list-panes','-F','#{pane_id}')).split('\n').length,2);
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('concurrent selection'),'helper selection staged');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
});
test('failed reopening removes its private quote request even after an earlier side closed',async t=>{
  const f=await fixture(t); await openScratchpad(f.state,'first');
  await until(async()=>(await records(f.logs,'fork')).length===1);
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/exit','Enter');
  await until(async()=>(await tmux(f.state,'list-panes','-F','#{pane_id}'))===f.state.mainPane);
  const filler=await tmux(f.state,'split-window','-h','-l','118','-t',f.state.mainPane,'-P','-F','#{pane_id}','/bin/sleep','30');
  await assert.rejects(openScratchpad(f.state,'PRIVATE_FAILURE_QUOTE'));
  assert.equal((await readdir(f.state.directory)).filter(x=>x.startsWith('request-')).length,0);
  await tmux(f.state,'kill-pane','-t',filler); await openScratchpad(f.state,'recovered');
  await until(async()=>(await records(f.logs,'fork')).length===2);
});
for(const [signal,want] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',129]]) {
  test(`attached production launch handles ${signal} and reaps only its runtime`,async t=>{
    const f=await attachedFixture(t);
    assert.equal((await stat(dirname(f.state.mainOutcomeFile))).mode&0o777,0o700);
    const {state,main,result}=f;
    await openScratchpad(state,'signal test');
    await until(async()=>(await records(f.logs,'fork')).length===1);
    const [fork]=await records(f.logs,'fork');
    process.kill(Number(await readFile(`${result}.pid`,'utf8')),signal);
    await until(async()=>await readFile(result,'utf8')===String(want),'launcher signal exit');
    await assert.rejects(access(state.directory));
    await assert.rejects(access(dirname(state.mainOutcomeFile)));
    await until(async()=>[main,fork].every(x=>{try{process.kill(x.pid,0);return false;}catch{return true;}}),'provider processes stopped');
    assert.doesNotMatch(await tmux(f.outerState,'capture-pane','-p','-t','%0'),/shoulder: Native Codex exited with status/);
  });
}
for(const [command,want] of [['/exit7',7],['/exit',0]]) {
  test(`attached launch returns native main status ${want} after restoring the terminal`,async t=>{
    const f=await attachedFixture(t);
    await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('NATIVE_READY'));
    await tmux(f.state,'send-keys','-t',f.state.mainPane,command,'Enter');
    await until(async()=>{try{await access(f.result);return true;}catch{return false;}},'launcher native outcome');
    assert.equal(await readFile(f.result,'utf8'),String(want));
    await until(async()=>(await tmux(f.outerState,'display-message','-p','-t','%0','#{pane_dead}'))==='1','wrapper process exit');
    assert.equal(await tmux(f.outerState,'display-message','-p','-t','%0','#{pane_dead_status}'),String(want));
    const terminal=await tmux(f.outerState,'capture-pane','-p','-t','%0');
    if(want) assert.match(terminal,/shoulder: Native Codex exited with status 7\.[\s\S]*codex resume/);
    else assert.doesNotMatch(terminal,/shoulder:.*(?:failed|exited with status)/);
    await assert.rejects(access(f.state.directory));
    await assert.rejects(access(dirname(f.state.mainOutcomeFile)));
  });
}
test('attached native spawn failure returns nonzero with an actionable restored-terminal summary',async t=>{
  const f=await launchFixture(t,async f=>{
    await writeFile(join(f.logs,'remove-provider-after-doctor'),f.options.codexPath);
  });
  await until(async()=>{try{await access(f.result);return true;}catch{return false;}},'launcher spawn-failure outcome');
  assert.notEqual(await readFile(f.result,'utf8'),'0');
  await until(async()=>(await tmux(f.outerState,'display-message','-p','-t','%0','#{pane_dead}'))==='1');
  assert.notEqual(await tmux(f.outerState,'display-message','-p','-t','%0','#{pane_dead_status}'),'0');
  assert.match(await tmux(f.outerState,'capture-pane','-p','-t','%0'),/shoulder: Could not start native Codex \(ENOENT\)\.[\s\S]*(?:executable|working directory)/);
  assert.equal((await records(f.logs,'main')).length,0);
});
test('native outcome survives runtime reaping until its separate owner consumes it',async t=>{
  const f=await fixture(t,{},false);
  const owner=join(f.dir,'result owner'); await mkdir(owner,{mode:0o700});
  const outcome=join(owner,'main.json');
  const state=await createRuntime(f.options,outcome); t.after(()=>cleanup(state));
  await until(async()=>(await records(f.logs,'main')).length===1);
  await until(async()=>(await tmux(state,'capture-pane','-p','-t',state.mainPane)).includes('NATIVE_READY'));
  await tmux(state,'send-keys','-t',state.mainPane,'/exit7','Enter');
  await until(async()=>{try{await access(state.directory);return false;}catch{return true;}},'runtime fully reaped');
  assert.deepEqual(JSON.parse(await readFile(outcome,'utf8')),{exitCode:7});
  assert.equal((await stat(outcome)).mode&0o777,0o600);
  await cleanup(state);
  assert.deepEqual(JSON.parse(await readFile(outcome,'utf8')),{exitCode:7});
});

test('public fresh CLI waits for first saved answer then copy-mode selection forks the exact footer UUID',async t=>{
  const f=await freshFixture(t);
  assert.deepEqual(f.main.args,['--profile','name with 日本語','--no-alt-screen','--config','tui.status_line=["session-id","model-with-reasoning","context-remaining","current-dir"]']);
  assert.equal(f.state.options.sessionId,undefined);
  assert.equal(await tmux(f.state,'show-options','-gv','status-right'),'Finish a main answer');
  await assert.rejects(openScratchpad(f.state,'before first turn'),/answer|complete|finish/i);
  assert.equal((await records(f.logs,'fork')).length,0);
  // A newer unrelated complete history must not affect exact footer binding.
  const decoy=join(f.home,'sessions','rollout-latest-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'first-main-question','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:first-main-question'));
  const savedPath=join(f.home,'sessions',`rollout-fresh-${id}.jsonl`);
  const saved=await readFile(savedPath,'utf8');
  // Footer identity must still pass the existing exact metadata/lifecycle reader.
  for(const invalid of [saved.replace(id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),saved.split('\n').filter(line=>!line.includes('task_complete')).join('\n'),saved+'partial']) {
    await writeFile(savedPath,invalid);
    await assert.rejects(openScratchpad(f.state,'unverified source selection'));
    assert.equal((await records(f.logs,'fork')).length,0);
  }
  await writeFile(savedPath,saved);
  await writeFile(decoy,saved.replaceAll(id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  await tmux(f.state,'copy-mode','-t',f.state.mainPane);
  for(const action of ['history-top','start-of-line','begin-selection','end-of-line']) await tmux(f.state,'send-keys','-t',f.state.mainPane,'-X',action);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'e');
  await until(async()=>(await records(f.logs,'fork')).length===1,'fresh public selection fork');
  const [fork]=await records(f.logs,'fork');
  assert.ok(fork.args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(id)));
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('SELECT passage 日本語'),'selection staged in native draft');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  assert.equal(fork.args[fork.args.indexOf('--model')+1],'fresh-effective');
  assert.equal(fork.args.some(arg=>arg.includes('tui.status_line')),true);
  assert.equal(fork.cwd,await import('node:fs/promises').then(fs=>fs.realpath(f.work)));
  assert.equal(await tmux(f.state,'show-options','-gv','status-right'),'Source linked · read on demand');
  assert.equal(JSON.parse(await readFile(join(f.state.directory,'state.json'),'utf8')).options.sessionId,undefined);
  assert.equal(await readFile(join(f.logs,'main.transcript'),'utf8'),'first-main-question\n');
});
test('public fresh selection opens a side fork when the native footer has a warning',async t=>{
  const f=await freshFixture(t);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'first question','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:first question'));
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/footer warning','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('⚠ 1 warning · f2 to view'));
  await tmux(f.state,'copy-mode','-t',f.state.mainPane);
  for(const action of ['history-top','start-of-line','begin-selection','end-of-line']) await tmux(f.state,'send-keys','-t',f.state.mainPane,'-X',action);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'e');
  await until(async()=>(await records(f.logs,'fork')).length===1,'warning footer selection opens native fork');
  const [fork]=await records(f.logs,'fork');
  assert.ok(fork.args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(id)));
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('SELECT passage 日本語'),'selection staged in native draft');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  assert.equal((await tmux(f.state,'list-panes','-F','#{pane_id}')).split('\n').length,2);
  assert.equal(await readFile(join(f.logs,'main.transcript'),'utf8'),'first question\n/footer warning\n');
});

test('fresh action reads current footer again after native new and never falls back to an old binding',async t=>{
  const f=await freshFixture(t);
  const send=async command=>{
    await tmux(f.state,'send-keys','-t',f.state.mainPane,command,'Enter');
    await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes(command === '/new' ? 'native:CLEARED' : `native:${command}`));
  };
  await send('first question'); await openScratchpad(f.state,'first selection');
  await until(async()=>(await records(f.logs,'fork')).length===1);
  for(const mode of ['missing','truncated']) {
    // An existing side cannot bypass verification of the current main source.
    await send(`/footer ${mode}`); await assert.rejects(openScratchpad(f.state,'focus existing'),/footer|UUID/i);
    assert.equal((await records(f.logs,'fork')).length,1);
  }
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/exit','Enter');
  await until(async()=>(await tmux(f.state,'list-panes','-F','#{pane_id}'))===f.state.mainPane);
  for(const mode of ['missing','truncated']) {
    await send(`/footer ${mode}`);
    await assert.rejects(openScratchpad(f.state,'must not use prior UUID'),/footer|UUID/i);
    assert.equal((await records(f.logs,'fork')).length,1);
    assert.equal((await readdir(f.state.directory)).some(x=>x.startsWith('request-')),false);
  }
  await send('/footer normal'); await send('/new');
  await assert.rejects(openScratchpad(f.state,'new without context'),/answer|complete|finish/i);
  await send('second question'); await openScratchpad(f.state,'new selection');
  await until(async()=>(await records(f.logs,'fork')).length===2);
  const forks=await records(f.logs,'fork');
  assert.ok(forks[0].args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(id))); assert.ok(forks[1].args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(freshId)));
  assert.equal(await tmux(f.state,'show-options','-gv','status-right'),'Source linked · read on demand');
  assert.equal((await records(f.logs,'main')).length,1);
});
test('fresh main failure restores terminal and gives a native launch hint without an undefined resume ID',async t=>{
  const f=await freshFixture(t);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/exit7','Enter');
  await until(async()=>{try{await access(f.result);return true;}catch{return false;}},'fresh launcher status');
  assert.equal(await readFile(f.result,'utf8'),'7');
  const terminal=await tmux(f.outerState,'capture-pane','-p','-t','%0');
  assert.match(terminal,/shoulder: Native Codex exited with status 7/);
  assert.doesNotMatch(terminal,/resume undefined|Parent undefined/);
  assert.match(terminal,/Run codex directly/);
  await assert.rejects(access(f.state.directory));
  await assert.rejects(access(dirname(f.state.mainOutcomeFile)));
});
