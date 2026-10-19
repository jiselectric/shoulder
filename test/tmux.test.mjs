import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, attachedFixture, tmux, records, until } from './runtime-fixture.mjs';

test('actual copy-mode e pipes current selection privately, never a stale clipboard',async t=>{
  const f=await fixture(t);
  await tmux(f.state,'set-buffer','STALE_BUFFER_MUST_NOT_FORK');
  await tmux(f.state,'copy-mode','-t',f.state.mainPane);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'e');
  await new Promise(r=>setTimeout(r,150));
  assert.equal((await records(f.logs,'fork')).length,0);
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'-X','history-top');
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'-X','start-of-line');
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'-X','begin-selection');
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'-X','end-of-line');
  await tmux(f.state,'send-keys','-t',f.state.mainPane,'e');
  await until(async()=>(await records(f.logs,'fork')).length===1,'copy-mode helper creates native fork');
  const [fork]=await records(f.logs,'fork');
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('SELECT passage 日本語 quotes'),'literal quote staged');
  const draft=await readFile(join(f.logs,'fork-0.draft'),'utf8');
  assert.doesNotMatch(draft,/STALE_BUFFER/);
  assert.equal(fork.args.some(arg=>arg.includes('SELECT passage')),false);
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.work,'SHOULD_NOT_EXIST')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
  assert.equal((await readFile(join(f.state.directory,'state.json'),'utf8')).includes('SELECT passage'),false);
});
test('real mouse drag release retains the active selection for e',async t=>{
  const f=await attachedFixture(t);
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('NATIVE_READY'));
  for(const event of ['\x1b[<0;1;1M','\x1b[<32;24;1M','\x1b[<0;24;1m']) {
    await tmux(f.outerState,'send-keys','-t','%0','-l',event);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{selection_present}'),'1');
  assert.equal((await records(f.logs,'fork')).length,0);
  await tmux(f.outerState,'send-keys','-t','%0','-l','e');
  await until(async()=>(await records(f.logs,'fork')).length===1,'mouse selection side fork');
  await until(async()=>(await readFile(join(f.logs,'fork-0.draft'),'utf8')).includes('SELECT passage'),'mouse quote staged');
  await assert.rejects(access(join(f.logs,'fork.transcript')));
  await assert.rejects(access(join(f.logs,'main.transcript')));
});
