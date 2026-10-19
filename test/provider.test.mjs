import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs,buildMainCommand,buildForkCommand} from '../dist/codex.js';
const id='12345678-1234-4234-8234-123456789abc';
const base={sessionId:id,nativeArgs:[],cwd:'/tmp',codexPath:'codex'};
test('native flags and positional arguments pass in order before and after separator',()=>{
 const native=['--yolo','--unknown=x','prompt $(touch nope)','resume',id];
 assert.deepEqual(parseArgs(['codex',...native]).nativeArgs,native);
 assert.deepEqual(parseArgs(['codex','--', '--side-model','literal']).nativeArgs,['--side-model','literal']);
});
test('native subcommands are not double resumed',()=>{
 const args=['resume',id,'--yolo'];
 assert.deepEqual(buildMainCommand({...base,nativeArgs:args}).args.slice(0,args.length),args);
});
test('side starts idle and retains explicit permissions',()=>{
 const command=buildForkCommand({...base,nativeArgs:['--yolo','--sandbox','danger-full-access','--add-dir','/extra']},'UNIQUE REQUEST',{model:'m',effort:'high'});
 assert.ok(!command.args.join(' ').includes('UNIQUE REQUEST'));
 assert.ok(command.args.includes('--yolo'));
 assert.ok(command.args.includes('danger-full-access'));
 assert.ok(command.args.includes('/extra'));
 assert.ok(!command.args.includes('read-only'));
});
test('generic executable launches unchanged and fails closed for forks',()=>{
 const parsed=parseArgs(['custom-agent','--unknown','a']);
 assert.equal(parsed.executable,'custom-agent');
 const options={...base,sessionId:undefined,codexPath:'custom-agent',nativeArgs:['--unknown','a']};
 assert.deepEqual(buildMainCommand(options).args,options.nativeArgs);
 assert.throws(()=>buildForkCommand({...options,sessionId:id},'',{model:'m'}),/adapter|unsupported/i);
});
test('Claude uses exact context forks and starts idle',()=>{
 const options={...base,codexPath:'claude'};
 const args=buildForkCommand(options,'never submit',{model:'sonnet'}).args;
 assert.deepEqual(args.slice(0,3),['--resume',id,'--fork-session']);
 assert.ok(!args.includes('--continue'));
 assert.ok(!args.includes('never submit'));
 assert.deepEqual(buildMainCommand({...options,nativeArgs:['--resume',id]}).args,['--resume',id]);
});
test('native identity resolver accepts only explicit UUID identities',async()=>{
 const {nativeSessionId}=await import('../dist/codex.js');
 assert.equal(nativeSessionId(['resume',id]),id);
 assert.equal(nativeSessionId(['--resume='+id]),id);
 assert.equal(nativeSessionId(['--session-id',id]),id);
 assert.equal(nativeSessionId(['--continue']),undefined);
 assert.equal(nativeSessionId(['resume','latest']),undefined);
});
test('literal main argv is delivered without shell expansion',async t=>{
 const {mkdtemp,writeFile,chmod,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const directory=await mkdtemp(join(tmpdir(),'adapter-literal-')); t.after(()=>rm(directory,{recursive:true,force:true}));
 const executable=join(directory,'custom executable');
 await writeFile(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))'); await chmod(executable,0o700);
 const args=['--unknown',`$(touch ${directory}/bad)`, '`echo bad`', 'a; echo bad', '世界'];
 const command=buildMainCommand({...base,sessionId:undefined,codexPath:executable,nativeArgs:args});
 const result=spawnSync(command.executable,command.args,{encoding:'utf8',shell:false});
 assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout),args);
});
test('native interactive identities retain argv prefix and expose footer',()=>{
 for(const subcommand of ['resume','fork']) {
  const args=[subcommand,id,'--yolo'];
  const result=buildMainCommand({...base,nativeArgs:args}).args;
  assert.deepEqual(result.slice(0,args.length),args);
  assert.ok(result.at(-1).includes('tui.status_line'));
 }
 assert.ok(buildMainCommand({...base,sessionId:undefined,nativeArgs:['--profile','review']}).args.at(-1).includes('tui.status_line'));
 assert.deepEqual(buildMainCommand({...base,sessionId:undefined,nativeArgs:['exec','--help']}).args,['exec','--help']);
});
test('Claude wrapper session resumes and side assigns a new tracking identity',()=>{
 const options={...base,codexPath:'claude'};
 assert.deepEqual(buildMainCommand(options).args,['--resume',id]);
 const args=buildForkCommand({...options,nativeArgs:['--permission-mode','acceptEdits']},'',{model:'sonnet'}).args;
 const sideId=args[args.indexOf('--session-id')+1];
 assert.match(sideId,/^[a-f\d-]{36}$/); assert.notEqual(sideId,id);
 assert.ok(args.includes('acceptEdits'));
});
test('provider doctor inspects chosen executable without requiring Codex',async()=>{
 const api=await import('../dist/codex.js');
 assert.equal(typeof api.providerDoctor,'function');
 const calls=[]; const result=await api.providerDoctor({...base,codexPath:'claude'},async(executable,args)=>{calls.push([executable,args]);return {exitCode:0,stdout:executable==='tmux'?'tmux 3.6a':'2.0 Claude Code',stderr:''};});
 assert.equal(result.ok,true); assert.deepEqual(calls.map(x=>x[0]),['claude','tmux']);
});
test('generic launch does not require its executable to implement a version flag',async()=>{
 const {providerDoctor}=await import('../dist/codex.js');
 const calls=[];
 const result=await providerDoctor({...base,codexPath:'custom-agent'},async(executable,args)=>{
  calls.push([executable,args]);
  return executable==='tmux'?{exitCode:0,stdout:'tmux 3.6a',stderr:''}:{exitCode:2,stdout:'',stderr:'unsupported flag'};
 });
 assert.equal(result.ok,true);
 assert.deepEqual(calls,[['tmux',['-V']]]);
});
test('provider doctor rejects tmux versions missing required selection and border fixes',async()=>{
 const {providerDoctor}=await import('../dist/codex.js');
 for(const [version,ok] of [['3.5a',false],['3.6',false],['3.6a',true],['3.6b',true],['3.7',true],['4.0',true]]) {
  const result=await providerDoctor({...base,codexPath:'custom-agent'},async()=>({exitCode:0,stdout:`tmux ${version}`,stderr:''}));
  assert.equal(result.ok,ok,version);
  if(!ok) assert.match(result.checks[0].evidence,/3\.6a.*newer/i);
 }
});
test('option values named resume do not suppress wrapper identity',()=>{
 const args=buildMainCommand({...base,nativeArgs:['--profile','resume']}).args;
 assert.deepEqual(args.slice(0,4),['resume',id,'--profile','resume']);
});
test('Claude preserves every variadic permission value including aliases',()=>{
 for(const flag of ['--disallowedTools','--disallowed-tools','--allowedTools','--allowed-tools','--add-dir','--mcp-config']) {
  const args=buildForkCommand({...base,codexPath:'claude',nativeArgs:[flag,'Bash','Edit','--permission-mode','default']},'',{model:'sonnet'}).args;
  assert.deepEqual(args.slice(args.indexOf(flag),args.indexOf(flag)+3),[flag,'Bash','Edit']);
 }
});
test('native identity ignores option values and positional prompt text',async()=>{
 const {nativeSessionId}=await import('../dist/codex.js');
 for(const args of [['--profile','resume',id],['--model','fork',id],['--disallowedTools','resume',id],['a prompt','resume',id],['--','resume',id],['--unknown','resume',id]]) assert.equal(nativeSessionId(args),undefined,JSON.stringify(args));
 const side='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 assert.equal(nativeSessionId(['--resume',id,'--fork-session','--session-id',side]),side);
});
test('injected provider options precede native positional terminator',()=>{
 const native=['--profile','work','--','literal --help prompt'];
 const args=buildMainCommand({...base,sessionId:undefined,nativeArgs:native}).args;
 assert.deepEqual(args.slice(-2),native.slice(-2));
 assert.equal(args.indexOf('--config')<args.indexOf('--'),true);
 const claude=buildMainCommand({...base,sessionId:undefined,codexPath:'claude',nativeArgs:['--','prompt']}).args;
 assert.deepEqual(claude.slice(-2),['--','prompt']);
 assert.equal(claude.indexOf('--session-id')<claude.indexOf('--'),true);
});
test('identity-shaped prompt after explicit resume never overrides the selected session',async()=>{
 const {nativeSessionId}=await import('../dist/codex.js');
 assert.equal(nativeSessionId(['--resume',id,'fork','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']),id);
});
