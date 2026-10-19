import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const subject = await import('../dist/claude.js').catch(() => ({}));
const id = '11111111-2222-4333-8444-555555555555';
const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const assistant = (extra = {}) => ({type:'assistant',sessionId:id,cwd:'/work/project',isSidechain:false,uuid:'reply',parentUuid:'question',effort:'high',perTurnEffort:null,message:{role:'assistant',model:'claude-opus-5',stop_reason:'end_turn',content:[]},...extra});
async function fixture(t, rows, name=id) {
 const home=await mkdtemp(join(tmpdir(),'side-claude-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const dir=join(home,'projects','-work-project');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,`${name}.jsonl`),typeof rows==='string'?rows:rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return home;
}
test('reads exact native Claude identity, latest actual model and effective effort',async t=>{
 assert.equal(typeof subject.readClaudeSessionSettings,'function');
 const home=await fixture(t,[assistant(),assistant({effort:'medium',perTurnEffort:'max',message:{model:'claude-sonnet-5',stop_reason:'end_turn'}}),assistant({message:{model:'<synthetic>',stop_reason:'stop_sequence'}})]);
 assert.deepEqual(await subject.readClaudeSessionSettings(home,id),{model:'claude-sonnet-5',effort:'max',cwd:'/work/project',active:false});
});
test('refuses foreign identity, ambiguous files and missing exact session',async t=>{
 assert.equal(typeof subject.readClaudeSessionSettings,'function');
 const home=await fixture(t,[assistant({sessionId:other})]);
 await assert.rejects(subject.readClaudeSessionSettings(home,id),e=>e.code==='IDENTITY');
 await assert.rejects(subject.readClaudeSessionSettings(home,other),e=>e.code==='NOT_FOUND');
 await mkdir(join(home,'projects','duplicate'));await writeFile(join(home,'projects','duplicate',`${id}.jsonl`),'{}\n');
 await assert.rejects(subject.readClaudeSessionSettings(home,id),e=>e.code==='AMBIGUOUS');
});
test('refuses unsaved input, tool activity, unknown models, cwd, and partial records',async t=>{
 assert.equal(typeof subject.readClaudeSessionSettings,'function');
 for(const [rows,code] of [
 [[assistant(),{type:'user',sessionId:id,cwd:'/work/project',message:{role:'user',content:'private'}}],'ACTIVE'],
 [[assistant({message:{model:'claude-opus-5',stop_reason:'tool_use'}})],'ACTIVE'],
 [[assistant({message:{stop_reason:'end_turn'}})],'MISSING_SETTINGS'],
 [[assistant({cwd:'relative'})],'UNSUPPORTED'],
 [JSON.stringify(assistant()),'INCOMPLETE']
 ]) {const home=await fixture(t,rows);await assert.rejects(subject.readClaudeSessionSettings(home,id),e=>e.code===code);}
});
test('keeps unknown effort absent rather than guessing defaults',async t=>{
 assert.equal(typeof subject.readClaudeSessionSettings,'function');
 const home=await fixture(t,[assistant({effort:undefined})]);
 assert.deepEqual(await subject.readClaudeSessionSettings(home,id),{model:'claude-opus-5',cwd:'/work/project',active:false});
});
test('unrecognized native Claude screens never permit automatic prompt injection',()=>{
 assert.equal(typeof subject.parseClaudePromptReady,'function');
 for(const screen of ['', '❯ ', 'Do you trust this folder?\n❯ Yes', 'Allow this action?\n❯ ', 'Thinking…\n❯ ', '❯ unfinished input']) assert.equal(subject.parseClaudePromptReady(screen),false);
});
