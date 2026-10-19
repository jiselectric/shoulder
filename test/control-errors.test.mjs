import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freshFixture, attachedFixture, tmux, until, records } from './runtime-fixture.mjs';
import { loadState, openScratchpad, closeScratchpad } from '../dist/runtime.js';

async function click(f,label) {
  const rows=await until(async()=>{
    const rows=(await tmux(f.outerState,'capture-pane','-p','-t','%0')).split('\n');
    return rows.some(row=>row.includes(label))&&rows;
  },`visible ${label}`);
  const y=rows.findIndex(row=>row.includes(label)),x=rows[y].indexOf(label)+3;
  for(const suffix of ['M','m'])await tmux(f.outerState,'send-keys','-t','%0','-l',`\x1b[<0;${x};${y+1}${suffix}`);
}
async function handled(f,pattern) {
  await until(async()=>(await tmux(f.state,'show-messages')).split('\n').some(line=>line.includes(' message: Shoulder:')&&pattern.test(line)),'useful rejection message');
  // The completed run-shell job is the boundary that triggers tmux's error
  // view. Wait for that job, not only its earlier display-message call.
  await until(async()=>!(await tmux(f.state,'show-messages','-J')).includes('dispatch.sh'),'control helper job completed');
  assert.equal(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_in_mode}'),'0','a rejected control must not open tmux output/copy mode');
  assert.match(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane),/NATIVE_READY/,'native screen remains visible');
  const messages=await tmux(f.state,'show-messages');
  assert.doesNotMatch(messages,/ message: .*returned [1-9]| message: .*dispatch\.sh/,'no raw internal helper error');
}

for(const route of ['button','shortcut','prefix'])for(const banner of [false,true])test(`no saved main context: ${route}, banner ${banner}, keeps native input usable`,async t=>{
  const f=await freshFixture(t);
  if(banner){await tmux(f.outerState,'send-keys','-t','%0','C-b','b');await until(async()=>await tmux(f.state,'show-options','-gv','status')==='5','expanded banner');}
  if(route==='button')await click(f,'[Open side]');
  else await tmux(f.outerState,'send-keys','-t','%0',...(route==='shortcut'?['C-q']:['C-b','x']));
  await handled(f,/saved context|main answer/i);
  assert.equal((await records(f.logs,'fork')).length,0);
  assert.equal((await loadState(f.state.directory)).sidePane,undefined);
  await assert.rejects(access(join(f.logs,'main.transcript')));
  const marker='TYPE_AFTER_REJECTED_OPEN';
  await tmux(f.outerState,'send-keys','-t','%0','-l',marker);
  await until(async()=>(await readFile(join(f.logs,'main-0.draft'),'utf8'))===marker,'typing works without Escape or reset');
  // A completed main answer makes the same control usable on its next click.
  await tmux(f.outerState,'send-keys','-t','%0','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('native:'+marker),'main completed');
  await click(f,'[Open side]');
  await until(async()=>(await loadState(f.state.directory)).sideSessionId,'open succeeds after main answer');
  assert.equal((await records(f.logs,'fork')).length,1);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
});

for(const reason of ['active','malformed','unsupported'])test(`rejected ${reason} source through the real Open side button preserves the main draft`,async t=>{
  const f=await attachedFixture(t,async f=>{if(reason==='unsupported')f.options.nativeArgs.push('--audit-unsupported');});
  if(reason==='active')await f.metadata({active:true});
  if(reason==='malformed'){
    const {appendFile}=await import('node:fs/promises');
    await appendFile(f.file,'{"type":');
  }
  await tmux(f.outerState,'send-keys','-t','%0','-l','MAIN_DRAFT_TO_KEEP');
  await click(f,'[Open side]');
  await handled(f,reason==='active'?/active/i:reason==='malformed'?/partial|record|incomplete/i:/cannot preserve/i);
  await tmux(f.outerState,'send-keys','-t','%0','-l','_CONTINUED');
  await until(async()=>(await readFile(join(f.logs,'main-0.draft'),'utf8'))==='MAIN_DRAFT_TO_KEEP_CONTINUED');
  assert.equal((await records(f.logs,'fork')).length,0);
  await assert.rejects(access(join(f.logs,'main.transcript')));
});

test('rejected narrow Reopen side does not trap the main in a helper output view',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'PRESERVED_SIDE_DRAFT');
  const before=await loadState(f.state.directory);
  await closeScratchpad(f.state);
  await tmux(f.outerState,'resize-window','-x','90','-y','40');
  await until(async()=>await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{window_width}')==='90');
  await click(f,'[Reopen side]');
  await handled(f,/100 columns/i);
  const after=await loadState(f.state.directory);
  assert.equal(after.sideHidden,true);
  assert.equal(after.sideSessionId,before.sideSessionId);
  assert.match(await readFile(join(f.logs,'fork-0.draft'),'utf8'),/PRESERVED_SIDE_DRAFT/);
});
