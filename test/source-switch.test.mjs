import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {freshFixture,tmux,until,freshId,records,exec} from './runtime-fixture.mjs';
import {openScratchpad,loadState,closeScratchpad} from '../dist/runtime.js';

// A source switch must validate its replacement before discarding an existing
// native conversation and unsent input. Future/unsupported native metadata is
// an expected compatibility error, not permission to destroy the old draft.
for(const problem of ['unsupported effort','missing working directory','non-directory working path','native startup failure','hidden native startup failure','Close during native startup','tmux split failure','successful replacement']) test(problem==='successful replacement'?'a successful source replacement retires the previous side after its new unsent draft is ready':`a replacement source with ${problem} preserves the existing side conversation and unsent question`,async t=>{
  const f=await freshFixture(t);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'first main question','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:first main question'));
  await openScratchpad(f.state,'PRESERVE_OLD_QUOTE');
  const side=(await loadState(f.state.directory)).sidePane;
  const pid=await tmux(f.state,'display-message','-p','-t',side,'#{pane_pid}');
  await tmux(f.state,'send-keys','-t',side,'-l','UNSENT_QUESTION');
  const draft=()=>readFile(join(f.logs,'fork-0.draft'),'utf8');
  await until(async()=>(await draft()).includes('UNSENT_QUESTION'));
  const width=Number(await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}'));
  if(problem==='hidden native startup failure') await closeScratchpad(f.state);
  const before=await loadState(f.state.directory);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'/new','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:CLEARED'));
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'new main question','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:new main question'));
  const path=join(f.home,'sessions',`rollout-fresh-${freshId}.jsonl`),saved=await readFile(path,'utf8');
  const rows=saved.trim().split('\n').map(line=>JSON.parse(line));
  const context=rows.find(row=>row.type==='turn_context').payload;
  if(problem==='unsupported effort') context.effort='future-native-effort';
  else if(problem==='missing working directory') context.cwd=join(f.work,'removed-directory');
  else if(problem==='non-directory working path') {context.cwd=join(f.work,'cwd-file');await writeFile(context.cwd,'ordinary file');}
  else if(problem==='tmux split failure') {
    const realTmux=(await exec('which',['tmux'])).stdout.trim(),previousPath=process.env.PATH;
    const wrapper=join(f.dir,'tmux');
    await writeFile(wrapper,`#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args.includes('split-window')) {console.error('Deterministic split failure');process.exit(1); }\nconst child=spawnSync(${JSON.stringify(realTmux)},args,{stdio:'inherit'});process.exit(child.status??1);\n`,{mode:0o700});
    const wrapperPath=`${f.dir}:${previousPath??''}`;
    process.env.PATH=wrapperPath;
    t.after(()=>{if(process.env.PATH===wrapperPath) {if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;}});
  } else if(problem!=='successful replacement') await writeFile(join(f.logs,problem==='Close during native startup'?'side-dialog':'fail-fork'),'');
  await writeFile(path,rows.map(row=>JSON.stringify(row)+'\n').join(''));
  if(problem==='successful replacement') {
    await openScratchpad(f.state,'NEW_SOURCE_QUOTE');
    const current=await loadState(f.state.directory);
    assert.notEqual(current.sidePane,side);
    assert.equal(current.sideParentId,freshId);
    assert.ok(current.sideSessionId);
    assert.ok(!(await tmux(f.state,'list-panes','-a','-F','#{pane_id}')).split('\n').includes(side));
    const newDraft=await readFile(join(f.logs,'fork-1.draft'),'utf8');
    assert.match(newDraft,/NEW_SOURCE_QUOTE/);
    assert.doesNotMatch(newDraft,/PRESERVE_OLD_QUOTE|UNSENT_QUESTION/);
    return;
  }
  if(problem==='Close during native startup') {
    const opening=openScratchpad(f.state,'REJECTED_NEW_QUOTE');
    const rejected=assert.rejects(opening,/closing|cancel/i);
    await until(async()=>(await records(f.logs,'fork')).length===2,'replacement native startup');
    await closeScratchpad(f.state);
    await rejected;
  } else await assert.rejects(openScratchpad(f.state,'REJECTED_NEW_QUOTE'),error=>{
    const expected=problem==='unsupported effort'?/Unsupported side effort/:problem==='tmux split failure'?/Deterministic split failure/:problem.includes('native startup failure')?/process exited/:/working directory/i;
    assert.match(error.message,expected);
    assert.doesNotMatch(error.message,/press Enter|inspect its pane/i,'rollback must not instruct submission or closure of the preserved draft');
    return true;
  });
  const remaining=(await tmux(f.state,'list-panes','-a','-F','#{pane_id}')).split('\n');
  assert.ok(remaining.includes(side),'validation failure must preserve the original live side pane');
  assert.equal(await tmux(f.state,'display-message','-p','-t',side,'#{pane_pid}'),pid);
  const expected=problem==='Close during native startup'?{...before,sideHidden:true,sideWidth:width}:before;
  assert.deepEqual(await loadState(f.state.directory),expected,'replacement failure must preserve the saved source/session identity');
  if(!expected.sideHidden) assert.equal(Number(await tmux(f.state,'display-message','-p','-t',side,'#{pane_width}')),width);
  else assert.equal(await tmux(f.state,'list-panes','-t',f.state.mainPane,'-F','#{pane_id}'),f.state.mainPane);
  assert.match(await draft(),/PRESERVE_OLD_QUOTE[\s\S]*UNSENT_QUESTION/);
  assert.doesNotMatch(await draft(),/REJECTED_NEW_QUOTE/);
  assert.equal((await readdir(f.state.directory)).filter(name=>name.startsWith('request-')||name.endsWith('.txt')).length,0,'failed replacement must remove its private draft/request files');
});
