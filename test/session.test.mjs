import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionSettings, readSessionActivity, SessionMetadataError, parseSessionFooter, parseComposerFooter } from '../dist/session.js';
import { buildForkCommand } from '../dist/codex.js';
const id='12345678-1234-4234-8234-123456789abc';
const meta={type:'session_meta',payload:{id,cwd:'/original'}};
const context=(model,effort='high',turn='t1')=>({type:'turn_context',payload:{model,effort,cwd:'/work',turn_id:turn}});
const event=(type,turn='t1')=>({type:'event_msg',payload:{type,turn_id:turn}});
test('native edited composer retains identity when the shortcuts hint is hidden',()=>{
  assert.equal(parseComposerFooter(`answer\n\n› My unsent question\n\n  ${id} · GPT-6.1-Sol high fast · Context 98% left · ~/Desktop`),id);
  assert.equal(parseComposerFooter(`› 1. Compare these\n\n  ${id} · GPT-6.1-Sol high fast\n  tab to queue message`),id);
  assert.equal(parseComposerFooter(`answer\n\n›\n\n  Quoted passage\n\n  My question:\n\n  ${id} · GPT-6.1-Sol high fast\n  tab to queue message`),id);
  for(const screen of [`answer\n  ${id}`,`› draft\n  ${id}\n  esc to interrupt`,`Trust this folder?\n  ${id}`]) assert.throws(()=>parseComposerFooter(screen),/footer|session/i);
});
async function fixture(t,records,extra='') {
  const home=await mkdtemp(join(tmpdir(),'side-ask-session-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'sessions','2026'),{recursive:true});
  const path=join(home,'sessions','2026',`rollout-2026-${id}.jsonl`);
  await writeFile(path,records.map(x=>JSON.stringify(x)+'\n').join('')+extra);
  return {home,path};
}
test('side lifecycle distinguishes a fresh saved fork from active or uncertain records',async t=>{
  const fresh=await fixture(t,[meta]);
  assert.equal(await readSessionActivity(fresh.home,id),'empty');
  const complete=await fixture(t,[meta,event('task_started'),context('x'),event('task_complete')]);
  assert.equal(await readSessionActivity(complete.home,id),'idle');
  const active=await fixture(t,[meta,event('task_started')]);
  await assert.rejects(readSessionActivity(active.home,id),error=>error.code==='ACTIVE');
  const partial=await fixture(t,[meta,event('task_started')],'{"type":');
  await assert.rejects(readSessionActivity(partial.home,id),error=>error.code==='INCOMPLETE');
});
test('native world state and token accounting records preserve lifecycle checks',async t=>{
  const telemetry=[{type:'world_state',payload:{full:true,state:{}}},{type:'token_usage_record',payload:{thread_id:id,session_id:id,turn_id:'t1',usage:{}}}];
  const complete=await fixture(t,[meta,event('task_started'),context('x'),...telemetry,event('task_complete')]);
  assert.equal(await readSessionActivity(complete.home,id),'idle');
  const active=await fixture(t,[meta,event('task_started'),context('x'),...telemetry]);
  await assert.rejects(readSessionActivity(active.home,id),error=>error.code==='ACTIVE');
  const wrong=await fixture(t,[meta,{...telemetry[1],payload:{...telemetry[1].payload,session_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}]);
  await assert.rejects(readSessionActivity(wrong.home,id),error=>error.code==='IDENTITY');
});
test('latest complete turn context preserves interactive settings changes', async t=>{
  const {home,path}=await fixture(t,[meta,event('task_started'),context('old'),event('task_complete'),event('task_started','t2'),context('new','medium','t2'),event('task_complete','t2')]);
  assert.deepEqual(await readSessionSettings(home,id),{model:'new',effort:'medium',cwd:'/work',active:false,transcriptPath:path});
});
test('trailing partial record is rejected instead of using stale settings',async t=>{
  const {home}=await fixture(t,[meta,context('old')],'{"type":"turn_context"');
  await assert.rejects(readSessionSettings(home,id),/partial|incomplete/);
});
test('active turn blocks a fork until save completes',async t=>{
  const {home}=await fixture(t,[meta,event('task_started'),context('new')]);
  await assert.rejects(readSessionSettings(home,id),/active|finish/);
});
test('duplicate exact-ID candidates fail instead of picking filesystem order',async t=>{
  const {home,path}=await fixture(t,[meta,context('x')]);
  await writeFile(path.replace('2026-'+id,'2027-'+id),JSON.stringify(meta)+'\n');
  await assert.rejects(readSessionSettings(home,id),/multiple|ambiguous/);
});
test('missing fields, wrong identity, unknown format and oversized records fail clearly',async t=>{
  for (const records of [[meta,{type:'turn_context',payload:{effort:'high'}}],[{...meta,payload:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},context('x')],[meta,{type:'unknown',payload:{}}]]) {
    const {home}=await fixture(t,records);
    await assert.rejects(readSessionSettings(home,id),/metadata|model|identity|format/);
  }
  const {home}=await fixture(t,[meta,context('x')],JSON.stringify({type:'response_item',payload:'x'.repeat(1048576)})+'\n');
  await assert.rejects(readSessionSettings(home,id),/record|limit/);
});
test('unknown session and malformed UUID fail without exposing transcript',async t=>{
  const {home}=await fixture(t,[meta,context('x')]);
  await assert.rejects(readSessionSettings(home,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),/not found/);
  await assert.rejects(readSessionSettings(home,'../bad'),/UUID/);
});
test('active lifecycle cannot be bypassed by earlier missing context fields',async t=>{
  const {home}=await fixture(t,[meta,event('task_started'),event('task_complete'),event('task_started','t2'),context('new','high','t2')]);
  await assert.rejects(readSessionSettings(home,id),error=>error.code==='ACTIVE');
});
test('orphan new context cannot silently reuse old completed settings',async t=>{
  const {home}=await fixture(t,[meta,event('task_started'),context('old'),event('task_complete'),context('new','medium','t2')]);
  await assert.rejects(readSessionSettings(home,id),error=>error.code==='INCOMPLETE');
});
test('only complete idle lifecycle with missing settings yields explicit-fallback code',async t=>{
  const {home}=await fixture(t,[meta,event('task_started'),{type:'turn_context',payload:{turn_id:'t1',model:'new',cwd:'/work'}},event('task_complete')]);
  await assert.rejects(readSessionSettings(home,id),error=>error.code==='MISSING_SETTINGS');
  const unknown=await fixture(t,[meta,context('x')]);
  await assert.rejects(readSessionSettings(unknown.home,id),error=>error.code==='UNSUPPORTED');
});

test('historical interrupted turn does not reject a later completed turn',async t=>{
  const {home,path}=await fixture(t,[meta,event('task_started'),context('interrupted'),event('turn_aborted'),event('task_started','t2'),context('new','medium','t2'),event('task_complete','t2')]);
  assert.deepEqual(await readSessionSettings(home,id),{model:'new',effort:'medium',cwd:'/work',active:false,transcriptPath:path});
});
test('latest unresolved interruption remains ineligible for explicit fallback',async t=>{
  const {home}=await fixture(t,[meta,event('task_started'),context('old'),event('task_complete'),event('task_started','t2'),context('interrupted','medium','t2'),event('turn_aborted','t2')]);
  await assert.rejects(readSessionSettings(home,id),error=>error instanceof SessionMetadataError && error.code==='INCOMPLETE');
});
test('explicit fallback retains verified saved cwd when reasoning effort is absent',async t=>{
  const {home}=await fixture(t,[meta,event('task_started'),{type:'turn_context',payload:{turn_id:'t1',model:'new',cwd:'/saved/working root'}},event('task_complete')]);
  await assert.rejects(readSessionSettings(home,id),error=>{
    assert.ok(error instanceof SessionMetadataError);
    assert.equal(error.code,'MISSING_SETTINGS');
    assert.equal(error.cwd,'/saved/working root');
    const options={sessionId:id,nativeArgs:['--cd','/saved/working root'],cwd:'/launcher',codexPath:'codex',sideModel:'explicit',sideEffort:'high'};
    const fork=buildForkCommand(options,'quoted text',{model:options.sideModel,effort:options.sideEffort,cwd:error.cwd});
    assert.equal(fork.cwd,'/saved/working root');
    return true;
  });
});
test('missing or invalid saved cwd refuses fallback despite explicit model settings',async t=>{
  for (const cwd of [undefined,'','relative/work']) {
    const {home}=await fixture(t,[meta,event('task_started'),{type:'turn_context',payload:{turn_id:'t1',model:'new',cwd}},event('task_complete')]);
    await assert.rejects(readSessionSettings(home,id),error=>error instanceof SessionMetadataError && error.code==='UNSUPPORTED');
  }
});

test('native footer resolves the session when Codex displays a warning indicator', () => {
  for (const indicator of ['⚠ 1 warning · f2 to view', '⚠ 2 warnings · f2 to view']) {
    assert.equal(parseSessionFooter(`response\n  ${id} · GPT-6.1-Sol high fast · Context 98% left · ~/Desktop\n  ? for shortcuts                       ${indicator}\n\n`), id);
  }
  for (const suffix of ['⚠ 1 warning · f2 to view extra', `⚠ 1 warning · f2 to view ${id}`, 'unrecognized status']) {
    assert.throws(() => parseSessionFooter(`  ${id} · GPT-6.1-Sol high fast\n  ? for shortcuts  ${suffix}`), /footer/i);
  }
});

test('native footer binds only a complete UUID immediately above final shortcuts row', () => {
  const id='12345678-1234-4234-8234-123456789abc';
  const decoy='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const footer of [id,`${id} · GPT-6.1-Sol high fast`,`${id} · GPT-6.1-Sol high fast · 100% left · /tmp/project`]) {
    assert.equal(parseSessionFooter(`response ${decoy}\n  ${footer}\n  ? for shortcuts\n\n`),id);
  }
  for (const screen of [
    '', id, `answer ${id}\n  ? for shortcuts`,
    `  ${id.slice(0,-1)} · GPT-6.1-Sol high\n  ? for shortcuts`,
    `  ${id}x · GPT-6.1-Sol high\n  ? for shortcuts`,
    `  prefix ${id} · GPT-6.1-Sol high\n  ? for shortcuts`,
    `  ${id} · GPT-6.1-Sol high\n\n  ? for shortcuts`,
    `  ${id} · GPT-6.1-Sol high\n  ? for shortcuts\nmore response`,
    `  ${id} · GPT-6.1-Sol high\n  ? for shortcuts\n  ${decoy} · other`,
    `  ${id} · GPT-6.1-Sol high\n  ? for shortcuts\n  not a session\n  ? for shortcuts`,
    `  ${id} · GPT-6.1-Sol high\n  ? for shortcuts · extra`,
    `  ${id} · GPT-6.1-Sol high\n  esc to interrupt`,
    `  ${id} · ${decoy}\n  ? for shortcuts`,
    `  ${id} · \x1b[31mGPT-6.1-Sol\n  ? for shortcuts`,
  ]) assert.throws(()=>parseSessionFooter(screen),/footer|session|UUID/i,JSON.stringify(screen));
});
