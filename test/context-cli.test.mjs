import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const cli=await import('../dist/context-reader.js').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const id='12345678-1234-4234-8234-123456789abc';

test('context reader parses source-bound refresh, literal search and older-message modes',()=>{
  assert.equal(typeof cli.parseContextArgs,'function');
  const base=['--source','/tmp/source with spaces.jsonl','--session',id];
  assert.deepEqual(cli.parseContextArgs(base),{sourcePath:base[1],sessionId:id});
  assert.deepEqual(cli.parseContextArgs([...base,'--since','cursor-value']),{sourcePath:base[1],sessionId:id,cursor:'cursor-value'});
  assert.deepEqual(cli.parseContextArgs([...base,'--search','$(literal); [query]']),{sourcePath:base[1],sessionId:id,query:'$(literal); [query]'});
  assert.deepEqual(cli.parseContextArgs([...base,'--search','needle','--start','5']),{sourcePath:base[1],sessionId:id,query:'needle',start:5});
  assert.deepEqual(cli.parseContextArgs([...base,'--message','0','--offset','12']),{sourcePath:base[1],sessionId:id,message:0,offset:12});
});
test('context reader rejects unknown, duplicate, missing and conflicting flags',()=>{
  assert.equal(typeof cli.parseContextArgs,'function');
  const base=['--source','/tmp/source.jsonl','--session',id];
  for(const args of [[],['--source'],[...base,'--source','/tmp/other'],[...base,'--evil','x'],[...base,'--since','x','--search','y'],[...base,'--offset','1'],[...base,'--start','1'],[...base,'--search','needle','--start','-1'],[...base,'--message','-1'],[...base,'--message','1.5'],[...base,'--message','9007199254740992'],[...base,'--search',''],['--source','relative.jsonl','--session',id],['--source','/tmp/source','--session','not-id']])assert.throws(()=>cli.parseContextArgs(args),undefined,JSON.stringify(args));
});
test('actual reader child returns completed text JSON and cursor deltas without changing source',async t=>{
  assert.equal(typeof cli.parseContextArgs,'function');
  const dir=await mkdtemp(join(tmpdir(),'shoulder-context-cli-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"source with spaces ' ; $(literal).jsonl");
  const line=x=>JSON.stringify(x)+'\n';
  const turn=(turnId,value)=>[
    {type:'event_msg',payload:{type:'task_started',turn_id:turnId}},
    {type:'event_msg',payload:{type:'user_message',message:'Remember '+value}},
    {type:'event_msg',payload:{type:'agent_message',message:value}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:value}},
  ].map(line).join('');
  let source=line({type:'session_meta',payload:{id}})+turn('turn-a','FIRST_VALUE');
  await writeFile(path,source);
  const args=[resolve('dist/context-reader.js'),'--source',path,'--session',id];
  const first=JSON.parse((await exec(process.execPath,args)).stdout);
  assert.equal(first.status,'snapshot');assert.ok(first.messages.some(m=>m.text==='FIRST_VALUE'));assert.ok(first.cursor);
  const unchanged=JSON.parse((await exec(process.execPath,[...args,'--since',first.cursor])).stdout);
  assert.equal(unchanged.status,'unchanged');assert.deepEqual(unchanged.messages,[]);
  source+=turn('turn-b','NEW_VALUE');await writeFile(path,source);
  const delta=JSON.parse((await exec(process.execPath,[...args,'--since',first.cursor])).stdout);
  assert.equal(delta.status,'delta');assert.ok(delta.messages.some(m=>m.text==='NEW_VALUE'));assert.ok(!delta.messages.some(m=>m.text.includes('FIRST_VALUE')));
  assert.equal(await readFile(path,'utf8'),source);
  const search=JSON.parse((await exec(process.execPath,[...args,'--search','FIRST_VALUE'])).stdout);
  assert.equal(search.status,'search');assert.ok(search.messages.some(m=>m.text.includes('FIRST_VALUE')));
});
test('actual reader errors reveal no transcript text and emit no partial JSON',async()=>{
  assert.equal(typeof cli.parseContextArgs,'function');
  await assert.rejects(exec(process.execPath,[resolve('dist/context-reader.js'),'--source','/no/such/source','--session',id]),error=>{
    assert.equal(error.stdout,'');assert.match(error.stderr,/Shoulder context|shoulder context/i);assert.doesNotMatch(error.stderr,/\/no\/such\/source|stack|ENOENT/);return true;
  });
});

test('reader invoked through a symlink still emits JSON',async t=>{
  assert.equal(typeof cli.parseContextArgs,'function');
  const {symlink}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'shoulder-reader-link-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'source.jsonl'),link=join(dir,'reader-link.mjs');
  await symlink(resolve('dist/context-reader.js'),link);
  await writeFile(source,[{type:'session_meta',payload:{id}},{type:'event_msg',payload:{type:'task_started',turn_id:'a'}},{type:'event_msg',payload:{type:'task_complete',turn_id:'a',last_agent_message:'LINK_VALUE'}}].map(JSON.stringify).join('\n')+'\n');
  const result=await exec(process.execPath,[link,'--source',source,'--session',id]);
  assert.ok(JSON.parse(result.stdout).messages.some(m=>m.text==='LINK_VALUE'));
});

test('exact generated reader command treats hostile installation and source paths as data',async t=>{
  assert.equal(typeof cli.parseContextArgs,'function');
  const {cp,mkdir,readdir}=await import('node:fs/promises');const {pathToFileURL}=await import('node:url');
  const dir=await mkdtemp(join(tmpdir(),'shoulder-reader-shell-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const install=join(dir,"package ' ; $(touch SHOULD_NOT_EXIST)");await mkdir(install);
  await writeFile(join(install,'package.json'),'{"type":"module"}');await cp(resolve('dist'),join(install,'dist'),{recursive:true});
  const source=join(dir,"source ' ; $(touch ALSO_NOT_EXIST).jsonl");
  await writeFile(source,[{type:'session_meta',payload:{id}},{type:'event_msg',payload:{type:'task_started',turn_id:'a'}},{type:'event_msg',payload:{type:'task_complete',turn_id:'a',last_agent_message:'SHELL_LITERAL_VALUE'}}].map(JSON.stringify).join('\n')+'\n');
  const provider=await import(pathToFileURL(join(install,'dist/codex.js')).href);
  const command=provider.buildReferenceCommand({provider:'codex',sessionId:id,codexPath:'codex',cwd:dir,nativeArgs:[]},{model:'native-model',effort:'high',cwd:dir,transcriptPath:source});
  const policy=JSON.parse(command.args.find(x=>x.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  const shell=policy.split('\n').find(x=>x.startsWith('Reader command: ')).slice('Reader command: '.length);
  const result=await exec('/bin/sh',['-c',shell],{cwd:dir});
  assert.equal(result.stderr,'');assert.ok(JSON.parse(result.stdout).messages.some(m=>m.text==='SHELL_LITERAL_VALUE'));
  assert.ok(!(await readdir(dir)).some(name=>['SHOULD_NOT_EXIST','ALSO_NOT_EXIST'].includes(name)));
});
