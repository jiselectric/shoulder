import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
const engine=await import('../dist/context.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const id='12345678-1234-4234-8234-123456789abc';
const meta={type:'session_meta',payload:{id}};
const event=(type,extra={})=>({type:'event_msg',payload:{type,...extra}});
const life=(type,turn_id='one',extra={})=>event(type,{turn_id,...extra});
const msg=(role,text,extra={})=>({type:'response_item',payload:{type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}],...extra}});
const turn=(user,assistant,turn_id='one')=>[life('task_started',turn_id),event('user_message',{message:user}),event('agent_message',{message:assistant}),life('task_complete',turn_id)];
const encode=rows=>rows.map(r=>JSON.stringify(r)+'\n').join('');
async function fixture(t,rows=[meta,...turn('hello','world')],tail='') {const dir=await mkdtemp(join(tmpdir(),'context engine '));t.after(()=>rm(dir,{recursive:true,force:true}));const sourcePath=join(dir,'source ; $.jsonl');await writeFile(sourcePath,encode(rows)+tail);return {sourcePath,sessionId:id};}
async function read(request){assert.equal(typeof engine.readContext,'function');return engine.readContext(request);}

test('completed canonical messages appear once, metadata and non-final text stay excluded',async t=>{
 const f=await fixture(t,[meta,life('task_started'),msg('developer','secret config'),msg('user','fallback'),event('user_message',{message:'hello'}),msg('assistant','analysis',{channel:'analysis'}),msg('assistant','world',{channel:'final'}),event('agent_message',{message:'world'}),{type:'response_item',payload:{type:'function_call_output',output:'tool secret'}},life('task_complete')]);
 const before=await readFile(f.sourcePath);const r=await read(f);assert.equal(r.status,'snapshot');assert.deepEqual(r.messages.map(m=>[m.role,m.text]),[['user','hello'],['assistant','world']]);assert.equal(r.active,false);assert.equal(r.hasMore,false);assert.equal(r.sourceSessionId,id);assert.deepEqual(await readFile(f.sourcePath),before);
});
test('initial, delta and unchanged cursors are deterministic and ignore configuration noise',async t=>{const f=await fixture(t);const one=await read(f);const same=await read({...f,cursor:one.cursor});assert.equal(same.status,'unchanged');assert.deepEqual(same.messages,[]);await appendFile(f.sourcePath,encode([{type:'turn_context',payload:{turn_id:'one',model:'noise'}}]));assert.equal((await read(f)).sourceVersion,one.sourceVersion);await appendFile(f.sourcePath,encode(turn('second','answer','two')));const a=await read({...f,cursor:one.cursor});const b=await read({...f,cursor:one.cursor});assert.equal(a.status,'delta');assert.deepEqual(a,b);assert.deepEqual(a.messages.map(m=>m.text),['second','answer']);});
test('active, aborted and incomplete tails never emit their text',async t=>{const f=await fixture(t,[meta,...turn('safe','done'),life('task_started','aborted'),event('user_message',{message:'hidden abort'}),life('turn_aborted','aborted'),life('task_started','active'),event('user_message',{message:'hidden active'})],'{"partial":');const r=await read(f);assert.deepEqual(r.messages.map(m=>m.text),['safe','done']);assert.equal(r.active,true);assert.equal(r.incompleteTail,true);});
test('response-item fallback and native task-complete final answer work without canonical duplication',async t=>{const f=await fixture(t,[meta,life('task_started'),msg('user','fallback user'),msg('assistant','fallback assistant'),life('task_complete','one',{last_agent_message:'fallback assistant'}),life('task_started','two'),event('user_message',{message:'native user'}),life('task_complete','two',{last_agent_message:'native final'})]);assert.deepEqual((await read(f)).messages.map(m=>m.text),['fallback user','fallback assistant','native user','native final']);});
test('oversized Unicode text paginates without skips or duplicated retries',async t=>{const text='🙂한é'.repeat(630);const f=await fixture(t,[meta,...turn('old',text)]);let r=await read({...f,maxBytes:1024});assert.equal(r.olderAvailable,true);let all='';let loops=0;while(true){assert.ok(Buffer.byteLength(JSON.stringify(r))<=1024);assert.equal(r.messages[0].offset,all.length);all+=r.messages.map(m=>m.text).join('');assert.ok(!r.messages.some(m=>/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(m.text)));if(!r.hasMore)break;const next=await read({...f,maxBytes:1024,cursor:r.cursor});assert.deepEqual(next,await read({...f,maxBytes:1024,cursor:r.cursor}));r=next;assert.ok(++loops<100);}assert.equal(all,text);assert.equal((await read({...f,cursor:r.cursor})).status,'unchanged');});
test('recent snapshot retains older literal search and exact message access',async t=>{const f=await fixture(t,[meta,...turn('old needle [.*] '+ 'x'.repeat(3500),'old final'),...turn('new','latest','two')]);const r=await read({...f,maxBytes:1024});assert.equal(r.olderAvailable,true);const s=await read({...f,query:'[.*]',maxBytes:1024});assert.equal(s.status,'search');assert.equal(s.messages.length,1);assert.ok(s.messages[0].text.includes('[.*]'));assert.equal(s.messages[0].index,0);assert.equal((await read({...f,query:'.*absent'})).messages.length,0);let m=await read({...f,message:0,offset:16,maxBytes:1024});assert.equal(m.status,'message');assert.equal(m.messages[0].offset,16);assert.ok(m.messages[0].text.length>0);assert.ok(/^x+$/.test(m.messages[0].text));assert.ok(Buffer.byteLength(JSON.stringify(m))<=1024);assert.equal(m.cursor,null);assert.equal(s.cursor,null);assert.equal((await read({...f,cursor:r.cursor})).status,'unchanged');});
test('rewritten or truncated consumed history resets, foreign and malformed cursors reject',async t=>{const f=await fixture(t);const r=await read(f);await writeFile(f.sourcePath,encode([meta,...turn('different','answer')]));assert.equal((await read({...f,cursor:r.cursor})).status,'reset');await writeFile(f.sourcePath,encode([meta]));assert.equal((await read({...f,cursor:r.cursor})).status,'reset');const other=await fixture(t);await assert.rejects(read({...other,cursor:r.cursor}));for(const cursor of ['', 'garbage',Buffer.from('{}').toString('base64url')])await assert.rejects(read({...f,cursor}));});
test('identity, malformed complete records and ambiguous lifecycle fail closed',async t=>{for(const rows of [[{type:'session_meta',payload:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}],[life('task_started'),meta],[meta,meta],[meta,life('task_complete')],[meta,life('task_started'),life('task_started','two')],[meta,life('task_started'),life('task_complete','wrong')],[meta,life('task_started'),life('task_complete'),life('task_started')]]){const f=await fixture(t,rows);await assert.rejects(read(f));}const f=await fixture(t);await appendFile(f.sourcePath,'not json\n');await assert.rejects(read(f));});
test('paths, modes, UTF-8 and record/file bounds reject safely',async t=>{const f=await fixture(t);const link=join(f.sourcePath+' link');await symlink(f.sourcePath,link);for(const request of [{...f,sourcePath:link},{...f,sourcePath:'relative.jsonl'},{...f,sessionId:'invalid'},{...f,maxBytes:1023},{...f,maxBytes:32769},{...f,message:-1},{...f,offset:1},{...f,query:''},{...f,query:'x',cursor:'x'},{...f,message:0,query:'x'}])await assert.rejects(read(request));await writeFile(f.sourcePath,Buffer.concat([Buffer.from(encode([meta])),Buffer.from([0xff,10])]));await assert.rejects(read(f));await writeFile(f.sourcePath,encode([meta])+'x'.repeat(1024*1024+1)+'\n');await assert.rejects(read(f));await truncate(f.sourcePath,256*1024*1024+1);await assert.rejects(read(f));});

test('JSON output stays within budget even when text needs escaping',async t=>{const f=await fixture(t,[meta,...turn('hello','\"\\\n\t'.repeat(1800))]);let r=await read({...f,maxBytes:1024});let text='';do{assert.ok(Buffer.byteLength(JSON.stringify(r))<=1024);text+=r.messages.map(m=>m.text).join('');if(!r.hasMore)break;r=await read({...f,maxBytes:1024,cursor:r.cursor});}while(true);assert.equal(text,'\"\\\n\t'.repeat(1800));});
test('literal search can excerpt a match longer than its output budget',async t=>{const query='q'.repeat(20000);const f=await fixture(t,[meta,...turn('prefix '+query+' suffix','done')]);const r=await read({...f,query,maxBytes:1024});assert.equal(r.messages.length,1);assert.equal(r.messages[0].index,0);assert.ok(r.messages[0].text.includes('q'.repeat(20)));assert.ok(Buffer.byteLength(JSON.stringify(r))<=1024);});
test('metadata counts are bounded even for many tiny valid records',async t=>{const f=await fixture(t,[meta,...turn('safe','done')]);await appendFile(f.sourcePath,(JSON.stringify({type:'event_msg',payload:{type:'token_count'}})+'\n').repeat(100000));await assert.rejects(read(f));});

test('contradictory secondary session identity fails instead of exposing text',async t=>{
 const f=await fixture(t,[{type:'session_meta',payload:{id,session_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},...turn('private','answer')]);
 await assert.rejects(read(f));
});

test('orphan turn context and canonical messages cannot masquerade as an idle source',async t=>{
 for(const extra of [{type:'turn_context',payload:{turn_id:'unstarted'}},{type:'turn_context',payload:{}},event('user_message',{message:'unstarted user'}),event('agent_message',{message:'unstarted answer'})]){
  const f=await fixture(t,[meta,...turn('saved','answer'),extra]);await assert.rejects(read(f));
 }
});

test('bounded literal search pages expose every matching older message without advancing refresh',async t=>{
 const rows=[meta];for(let i=0;i<20;i++)rows.push(...turn('needle '+i+' '+ 'x'.repeat(300),'answer '+i,'search-'+i));
 const f=await fixture(t,rows),first=await read(f),found=[];let start=0;
 for(let page=0;page<30;page++){
  const result=await read({...f,query:'needle',start,maxBytes:1024});
  assert.equal(result.cursor,null);assert.ok(Buffer.byteLength(JSON.stringify(result))<=1024);
  found.push(...result.messages.map(m=>m.index));
  if(!result.hasMore)break;
  assert.ok(Number.isInteger(result.nextSearchIndex)&&result.nextSearchIndex>start);start=result.nextSearchIndex;
 }
 assert.deepEqual(found,Array.from({length:20},(_,i)=>i*2));
 assert.deepEqual((await read({...f,query:'needle',start:40})).messages,[]);
 for(const request of [{...f,start:0},{...f,query:'needle',start:-1},{...f,query:'needle',start:41}])await assert.rejects(read(request));
 assert.equal((await read({...f,cursor:first.cursor})).status,'unchanged');
});
