import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, appendFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { attachedFixture, fixture, tmux, records, until, id, freshId } from './runtime-fixture.mjs';
import { openScratchpad, loadState, closeScratchpad, clearScratchpad, cleanup } from '../dist/runtime.js';

async function draft(f,index=0) { try { return await readFile(join(f.logs,`fork-${index}.draft`),'utf8'); } catch { return ''; } }

test('direct mouse drag with native reporting opens an unsent native draft on e',async t=>{
  const f=await attachedFixture(t);
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('NATIVE_READY'));
  for(const event of ['\x1b[<0;1;1M','\x1b[<32;24;1M','\x1b[<0;24;1m']) await tmux(f.outerState,'send-keys','-t','%0','-l',event);
  await until(async()=>(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{selection_present}'))==='1','direct drag retained');
  await tmux(f.outerState,'send-keys','-t','%0','-l','e');
  await until(async()=>(await draft(f)).includes('SELECT passage'),'selected quote staged');
  const [fork]=await records(f.logs,'fork');
  assert.ok(fork.args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes('12345678-1234-4234-8234-123456789abc')));
  assert.equal(fork.args.some(arg=>arg.includes('SELECT passage')),false);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
  const state=await loadState(f.state.directory);
  await tmux(state,'send-keys','-t',state.sidePane,'Why is this true?','Enter');
  await until(async()=>(await readFile(join(f.logs,'fork.transcript'),'utf8')).includes('Why is this true?'));
  assert.match(await readFile(join(f.logs,'fork.transcript'),'utf8'),/SELECT passage/);
});

test('repeated selection preserves the existing question draft and side clear accepts new context',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'FIRST_QUOTE');
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'MY_UNSENT_QUESTION');
  await openScratchpad(f.state,'SECOND_QUOTE');
  assert.match(await draft(f),/FIRST_QUOTE[\s\S]*MY_UNSENT_QUESTION[\s\S]*SECOND_QUOTE/);
  assert.equal((await records(f.logs,'fork')).length,1);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/clear','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.sidePane)).includes('CLEARED'));
  await openScratchpad(f.state,'AFTER_CLEAR_QUOTE');
  await until(async()=>(await draft(f,1)).includes('AFTER_CLEAR_QUOTE'));
  assert.equal((await records(f.logs,'fork')).length,2);
  assert.doesNotMatch(await draft(f,1),/FIRST_QUOTE|MY_UNSENT_QUESTION/);
  await closeScratchpad(f.state);
  assert.equal(await tmux(f.state,'list-panes','-F','#{pane_id}'),f.state.mainPane);
  await openScratchpad(f.state,'REOPEN_QUOTE');
  assert.match(await draft(f,1),/AFTER_CLEAR_QUOTE[\s\S]*REOPEN_QUOTE/);
  assert.equal((await records(f.logs,'fork')).length,2);
  assert.equal((await records(f.logs,'main')).length,1);
});

test('a busy side never receives a quote or an implicit submission',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'INITIAL_QUOTE');
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/footer busy','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.sidePane)).includes('esc to interrupt'));
  const before=await readFile(join(f.logs,'fork.transcript'),'utf8');
  await assert.rejects(openScratchpad(f.state,'MUST_NOT_BE_SENT'),/ready|finish|footer/i);
  assert.equal(await draft(f),'');
  assert.equal(await readFile(join(f.logs,'fork.transcript'),'utf8'),before);
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('mouse divider resizing and visible Close side control preserve the main conversation',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'RESIZE_QUOTE');
  const side=f.state.sidePane;
  const before=Number(await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}'));
  const border=Number(await tmux(f.state,'display-message','-p','-t',side,'#{pane_left}'));
  for(const event of [`\x1b[<0;${border};5M`,`\x1b[<32;${border-10};5M`,`\x1b[<0;${border-10};5m`]) await tmux(f.outerState,'send-keys','-t','%0','-l',event);
  await until(async()=>Number(await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}'))>before,'divider drag expands side');
  const lines=(await tmux(f.outerState,'capture-pane','-p','-t','%0')).split('\n');
  const row=lines.findIndex(line=>line.includes('[Close side]'));
  assert.ok(row>=0,'visible mouse close control');
  const col=lines[row].indexOf('[Close side]')+3;
  for(const event of [`\x1b[<0;${col};${row+1}M`,`\x1b[<0;${col};${row+1}m`]) await tmux(f.outerState,'send-keys','-t','%0','-l',event);
  await until(async()=>(await tmux(f.state,'list-panes','-F','#{pane_id}'))===f.state.mainPane,'mouse close side');
  assert.equal((await records(f.logs,'main')).length,1);
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('closing during native startup cancels draft insertion without reopening the side',async t=>{
  const f=await attachedFixture(t);
  await writeFile(join(f.logs,'side-dialog'),'');
  const opening=openScratchpad(f.state,'NEVER_PASTE_IN_TRUST_DIALOG');
  const rejected=assert.rejects(opening,/closed|closing|cancel|ready/i);
  await until(async()=>(await records(f.logs,'fork')).length===1,'side startup');
  await closeScratchpad(f.state);
  await rejected;
  assert.equal(await tmux(f.state,'list-panes','-F','#{pane_id}'),f.state.mainPane);
  assert.equal((await loadState(f.state.directory)).sideHidden,true);
  assert.equal(await draft(f),'');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
});

test('partially saved active metadata blocks a paste even when the native input still looks idle',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'UNCHANGED_DRAFT');
  const current=await loadState(f.state.directory);
  await appendFile(join(f.home,'sessions',`rollout-side-${current.sideSessionId}.jsonl`),JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'in-flight'}})+'\n{"type":');
  await assert.rejects(openScratchpad(f.state,'MUST_NOT_APPEND'),/ready|saved|record|finish/i);
  assert.doesNotMatch(await draft(f),/MUST_NOT_APPEND/);
  assert.match(await draft(f),/UNCHANGED_DRAFT/);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
});

test('visible Clear side resets the conversation in the same pane and retains its width',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'BEFORE_MOUSE_CLEAR');
  const side=f.state.sidePane;
  await tmux(f.state,'resize-pane','-t',side,'-x','55');
  const width=await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}');
  const helper=Number(await tmux(f.state,'display-message','-p','-t',side,'#{pane_pid}'));
  const lines=(await tmux(f.outerState,'capture-pane','-p','-t','%0')).split('\n');
  const row=lines.findIndex(line=>line.includes('[Clear side]'));
  const col=lines[row].indexOf('[Clear side]')+3;
  for(const event of [`\x1b[<0;${col};${row+1}M`,`\x1b[<0;${col};${row+1}m`]) await tmux(f.outerState,'send-keys','-t','%0','-l',event);
  await until(async()=>(await records(f.logs,'fork')).length===2,'clear starts a fresh native chat');
  assert.equal((await loadState(f.state.directory)).sidePane,side);
  assert.equal(await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}'),width);
  await until(async()=>{try{process.kill(helper,0);return false;}catch{return true;}},'old side helper released');
  await tmux(f.outerState,'send-keys','-t','%0','-l','MY_NEW_QUESTION');
  await until(async()=>(await draft(f,1)).includes('MY_NEW_QUESTION'),'fresh side accepts typing');
  assert.doesNotMatch(await draft(f,1),/BEFORE_MOUSE_CLEAR/);
  await openScratchpad(f.state,'AFTER_MOUSE_CLEAR');
  assert.match(await draft(f,1),/AFTER_MOUSE_CLEAR/);
  assert.match(await draft(f,1),/MY_NEW_QUESTION/);
  assert.doesNotMatch(await draft(f,1),/BEFORE_MOUSE_CLEAR/);
  assert.equal((await records(f.logs,'fork')).length,2);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('closing a running side keeps its helper alive until runtime teardown',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'HELPER_CLEANUP_QUOTE');
  const helper=Number(await tmux(f.state,'display-message','-p','-t',f.state.sidePane,'#{pane_pid}'));
  await closeScratchpad(f.state);
  process.kill(helper,0);
  await cleanup(f.state);
  await until(async()=>{try{process.kill(helper,0);return false;}catch{return true;}},'side helper released');
  assert.equal((await records(f.logs,'main')).length,1);
});

test('Clear works while the main and side are busy and leaves a blank usable side',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'DISCARD_THIS_QUOTE');
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/footer busy','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.sidePane)).includes('esc to interrupt'));
  await f.metadata({active:true});
  const pane=f.state.sidePane;
  await tmux(f.state,'copy-mode','-t',pane);
  await clearScratchpad(f.state);
  await until(async()=>(await records(f.logs,'fork')).length===2,'fresh process after clear');
  assert.equal((await loadState(f.state.directory)).sidePane,pane);
  assert.equal(await tmux(f.state,'display-message','-p','-t',pane,'#{pane_in_mode}'),'0');
  await tmux(f.outerState,'send-keys','-t','%0','-l','FRESH_QUESTION');
  await until(async()=>(await draft(f,1)).includes('FRESH_QUESTION'),'cleared side accepts input');
  assert.doesNotMatch(await draft(f,1),/DISCARD_THIS_QUOTE/);
  assert.equal((await records(f.logs,'main')).length,1);
});

test('Close requested during Clear runs after the reset and leaves no side pane',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'CLEAR_THEN_CLOSE');
  const lock=join(f.state.directory,'opening.lock');
  await mkdir(lock);
  const clearing=clearScratchpad(f.state);
  await until(async()=>{try{await access(join(f.state.directory,'closing'));return true;}catch{return false;}},'clear is pending');
  const closing=closeScratchpad(f.state);
  const done=Promise.all([clearing,closing]);
  await rm(lock,{recursive:true,force:true});
  await done;
  assert.equal(await tmux(f.state,'list-panes','-F','#{pane_id}'),f.state.mainPane);
});

test('Close waits for a control marker whose action has not finished writing',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'PENDING_CONTROL');
  const marker=join(f.state.directory,'closing');
  await writeFile(marker,'');
  const closing=closeScratchpad(f.state);
  await new Promise(resolve=>setTimeout(resolve,70));
  await rm(marker);
  await closing;
  assert.equal(await tmux(f.state,'list-panes','-F','#{pane_id}'),f.state.mainPane);
});

test('a selection queued after Close restores the startup pane and stages only the new draft',async t=>{
  const f=await attachedFixture(t);
  const flag=join(f.logs,'side-dialog');
  await writeFile(flag,'');
  const first=openScratchpad(f.state,'CANCELLED_FIRST_QUOTE');
  const rejected=assert.rejects(first,/closed|closing|cancel|ready/i);
  await until(async()=>(await records(f.logs,'fork')).length===1,'initial dialog');
  await rm(flag);
  const closing=closeScratchpad(f.state);
  await until(async()=>{try{await access(join(f.state.directory,'closing'));return true;}catch{return false;}},'close request recorded');
  const second=openScratchpad(f.state,'QUEUED_AFTER_CLOSE');
  await Promise.all([rejected,closing,second]);
  assert.match(await draft(f),/QUEUED_AFTER_CLOSE/);
  assert.doesNotMatch(await draft(f),/CANCELLED_FIRST_QUOTE/);
  assert.equal((await records(f.logs,'fork')).length,1);
});

test('native main exit releases the main helper process',async t=>{
  const f=await attachedFixture(t);
  const helper=Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_pid}'));
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/exit','Enter');
  await until(async()=>{try{process.kill(helper,0);return false;}catch{return true;}},'main helper released');
});

test('runtime teardown releases a still-running main helper',async t=>{
  const f=await attachedFixture(t);
  const helper=Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_pid}'));
  await cleanup(f.state);
  await until(async()=>{try{process.kill(helper,0);return false;}catch{return true;}},'teardown helper released');
});

test('detached runtime teardown releases its main helper',async t=>{
  const f=await fixture(t);
  const helper=Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_pid}'));
  await cleanup(f.state);
  await until(async()=>{try{process.kill(helper,0);return false;}catch{return true;}},'detached helper released');
});

test('teardown after opening a side releases both pane helpers',async t=>{
  const f=await fixture(t);
  await openScratchpad(f.state,'CLEANUP_BOTH_QUOTE');
  const helpers=(await tmux(f.state,'list-panes','-F','#{pane_pid}')).split('\n').map(Number);
  await cleanup(f.state);
  await until(async()=>helpers.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'both helpers released');
});

test('an explicit launch session follows native main new instead of forking the old parent',async t=>{
  const f=await attachedFixture(t,async f=>{
    await writeFile(join(f.logs,'fresh-config.json'),JSON.stringify({id,newId:freshId,cwd:f.work,model:'fresh-model',effort:'high'}));
  });
  assert.equal(f.state.options.sessionId,id);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/new','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:CLEARED'));
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'new main question','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:new main question'));
  await openScratchpad(f.state,'CURRENT_CONTEXT_QUOTE');
  const [fork]=await records(f.logs,'fork');
  assert.ok(fork.args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(freshId)));
  assert.equal(await tmux(f.state,'show-options','-gv','status-right'),'Source linked · read on demand');
});
