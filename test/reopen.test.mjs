import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { attachedFixture, tmux, records, until } from './runtime-fixture.mjs';
import { openScratchpad, closeScratchpad, clearScratchpad, toggleScratchpad, loadState, cleanup } from '../dist/runtime.js';

async function draft(f, index=0) { return readFile(join(f.logs, `fork-${index}.draft`), 'utf8'); }
async function click(f, label) {
  const lines=await until(async()=>{
    const lines=(await tmux(f.outerState,'capture-pane','-p','-t','%0')).split('\n');
    return lines.some(line=>line.includes(label)) && lines;
  },`visible ${label}`);
  const row=lines.findIndex(line=>line.includes(label)),col=lines[row].indexOf(label)+3;
  for(const event of [`\x1b[<0;${col};${row+1}M`,`\x1b[<0;${col};${row+1}m`]) await tmux(f.outerState,'send-keys','-t','%0','-l',event);
}

// Killing/replacing the side process on Close loses both native history and drafts.
test('close and selection reopen preserve the live side history, draft, identity and width',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'ORIGINAL_QUOTE');
  const before=await loadState(f.state.directory),side=before.sidePane;
  await tmux(f.state,'resize-pane','-t',side,'-x','53');
  const width=await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}');
  const pid=await tmux(f.state,'display-message','-p','-t',side,'#{pane_pid}');
  await tmux(f.state,'send-keys','-t',side,'FIRST_QUESTION','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',side)).includes('native:'));
  const transcript=await readFile(join(f.logs,'fork.transcript'),'utf8');
  await tmux(f.state,'send-keys','-t',side,'UNSENT_FOLLOWUP');
  await until(async()=>(await draft(f)).includes('UNSENT_FOLLOWUP'));
  await closeScratchpad(f.state);
  assert.equal(await tmux(f.state,'list-panes','-t',f.state.mainPane,'-F','#{pane_id}'),f.state.mainPane);
  assert.equal((await loadState(f.state.directory)).sideSessionId,before.sideSessionId);
  await openScratchpad(f.state,'NEW_QUOTE');
  const after=await loadState(f.state.directory);
  assert.equal(after.sidePane,side);
  assert.equal(after.sideSessionId,before.sideSessionId);
  assert.equal(await tmux(f.state,'display-message','-p','-t',side,'#{pane_pid}'),pid);
  assert.equal(await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}'),width);
  assert.match(await draft(f),/UNSENT_FOLLOWUP[\s\S]*NEW_QUOTE/);
  assert.equal(await readFile(join(f.logs,'fork.transcript'),'utf8'),transcript,'reopen submits nothing');
  assert.equal((await records(f.logs,'fork')).length,1);
  assert.match(await tmux(f.state,'capture-pane','-p','-t',side),/native:/);
});

test('visible Reopen side restores an unsaved draft without needing a new selection',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'UNSAVED_QUOTE');
  const side=f.state.sidePane;
  await click(f,'[Close side]');
  await until(async()=>(await tmux(f.state,'list-panes','-t',f.state.mainPane,'-F','#{pane_id}'))===f.state.mainPane);
  await click(f,'[Reopen side]');
  await until(async()=>(await tmux(f.state,'list-panes','-t',f.state.mainPane,'-F','#{pane_id}')).split('\n').length===2);
  await tmux(f.outerState,'send-keys','-t','%0','-l','MY_QUESTION');
  await until(async()=>(await draft(f)).includes('MY_QUESTION'));
  assert.equal((await loadState(f.state.directory)).sidePane,side);
  assert.match(await draft(f),/UNSAVED_QUOTE[\s\S]*MY_QUESTION/);
  assert.equal((await records(f.logs,'fork')).length,1);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('Clear side while hidden opens a fresh chat and never restores the discarded draft',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'DISCARD_ON_CLEAR');
  const side=f.state.sidePane;
  await closeScratchpad(f.state);
  await clearScratchpad(f.state);
  await until(async()=>(await records(f.logs,'fork')).length===2);
  assert.equal((await loadState(f.state.directory)).sidePane,side);
  assert.equal((await tmux(f.state,'list-panes','-t',f.state.mainPane,'-F','#{pane_id}')).split('\n').length,2);
  await tmux(f.outerState,'send-keys','-t','%0','-l','FRESH_DRAFT');
  await until(async()=>(await draft(f,1)).includes('FRESH_DRAFT'));
  assert.doesNotMatch(await draft(f,1),/DISCARD_ON_CLEAR/);
});

test('wrapper cleanup also terminates a hidden side process',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'PARKED_CLEANUP');
  const pid=Number(await tmux(f.state,'display-message','-p','-t',f.state.sidePane,'#{pane_pid}'));
  await closeScratchpad(f.state);
  process.kill(pid,0);
  await cleanup(f.state);
  await until(async()=>{try{process.kill(pid,0);return false;}catch{return true;}},'hidden helper released');
});

test('a busy side can be hidden and reopened without touching either running conversation',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'BUSY_QUOTE');
  const side=f.state.sidePane;
  await tmux(f.state,'send-keys','-t',side,'C-u','/footer busy','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',side)).includes('esc to interrupt'));
  const transcript=await readFile(join(f.logs,'fork.transcript'),'utf8');
  await f.metadata({active:true});
  await closeScratchpad(f.state);
  await toggleScratchpad(f.state);
  assert.equal((await loadState(f.state.directory)).sidePane,side);
  assert.match(await tmux(f.state,'capture-pane','-p','-t',side),/esc to interrupt/);
  assert.equal(await readFile(join(f.logs,'fork.transcript'),'utf8'),transcript);
  assert.equal((await records(f.logs,'fork')).length,1);
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('a narrow terminal refuses reopening without losing the preserved chat',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'PRESERVE_WHILE_NARROW');
  const side=f.state.sidePane;
  await closeScratchpad(f.state);
  await tmux(f.outerState,'resize-window','-x','90','-y','40');
  await until(async()=>Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{window_width}'))===90);
  await assert.rejects(toggleScratchpad(f.state),/100|columns/);
  assert.equal((await loadState(f.state.directory)).sideHidden,true);
  await tmux(f.outerState,'resize-window','-x','120','-y','40');
  await until(async()=>Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{window_width}'))===120);
  await toggleScratchpad(f.state);
  assert.equal((await loadState(f.state.directory)).sidePane,side);
  assert.match(await draft(f),/PRESERVE_WHILE_NARROW/);
  assert.equal((await records(f.logs,'fork')).length,1);
});


test('Ctrl+Q opens a blank source-linked side without selection or submission',async t=>{
  const f=await attachedFixture(t);
  const source=await readFile(f.file);
  await tmux(f.outerState,'send-keys','-t','%0','C-q');
  await until(async()=>(await records(f.logs,'fork')).length===1,'shortcut opens first side');
  const current=await until(async()=>{
    const current=await loadState(f.state.directory);
    return current.sideSessionId && current;
  },'blank side ready');
  const [fork]=await records(f.logs,'fork');
  assert.ok(fork.args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes(f.options.sessionId)&&arg.includes(f.file)));
  assert.equal(await tmux(f.state,'display-message','-p','#{pane_id}'),current.sidePane);
  await assert.rejects(access(join(f.logs,'fork-0.draft')), {code:'ENOENT'}, 'opening injects no input');
  assert.equal(await tmux(f.state,'list-buffers'), '');
  assert.deepEqual(await readFile(f.file),source);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
  await tmux(f.outerState,'send-keys','-t','%0','-l','FOLLOWUP_WITHOUT_QUOTE');
  await until(async()=>(await draft(f)).includes('FOLLOWUP_WITHOUT_QUOTE'),'plain side typing');
  assert.doesNotMatch(await draft(f),/Quoted passage|shoulder-selection|My question:/);
  await tmux(f.outerState,'send-keys','-t','%0','C-q');
  await until(async()=>(await loadState(f.state.directory)).sideHidden,'shortcut closes');
  await tmux(f.outerState,'send-keys','-t','%0','C-q');
  await until(async()=>!(await loadState(f.state.directory)).sideHidden,'shortcut reopens');
  assert.equal((await loadState(f.state.directory)).sideSessionId,current.sideSessionId);
  assert.equal((await records(f.logs,'fork')).length,1);
  assert.equal(await draft(f),'FOLLOWUP_WITHOUT_QUOTE');
});

for(const banner of [false,true]) test(`Open side button opens an empty linked composer without a selection (banner ${banner})`,async t=>{
  const f=await attachedFixture(t,async f=>{f.options.banner=banner;});
  await click(f,'[Open side]');
  await until(async()=>(await loadState(f.state.directory)).sideSessionId,'button opens first side');
  await assert.rejects(access(join(f.logs,'fork-0.draft')), {code:'ENOENT'}, 'opening injects no input');
  await until(async()=>(await tmux(f.outerState,'capture-pane','-p','-t','%0')).includes('[Close side]'),'button reflects open side');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('prefix x opens the initial linked side when direct keys are disabled',async t=>{
  const f=await attachedFixture(t,async f=>{f.options.directKeys=false;});
  await tmux(f.outerState,'send-keys','-t','%0','C-b','x');
  await until(async()=>(await loadState(f.state.directory)).sideSessionId,'prefix opens first side');
  await assert.rejects(access(join(f.logs,'fork-0.draft')), {code:'ENOENT'});
  await assert.rejects(access(join(f.logs,'fork.transcript')));
});

test('opening without a selection refuses active main context and leaves its input alone',async t=>{
  const f=await attachedFixture(t);
  await f.metadata({active:true});
  await tmux(f.outerState,'send-keys','-t','%0','-l','MAIN_UNSENT_DRAFT');
  await tmux(f.outerState,'send-keys','-t','%0','C-q');
  await until(async()=>(await tmux(f.state,'show-messages')).includes('Parent turn is active'),'active context refused');
  assert.equal((await records(f.logs,'fork')).length,0);
  assert.equal((await loadState(f.state.directory)).sidePane,undefined);
  assert.match(await readFile(join(f.logs,'main-0.draft'),'utf8'),/MAIN_UNSENT_DRAFT/);
  await assert.rejects(access(join(f.logs,'main.transcript')));
});
