import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, buildMainCommand, buildForkCommand, doctor } from '../dist/codex.js';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const id = '12345678-1234-4234-8234-123456789abc';
const base = { sessionId: id, nativeArgs: [], cwd: '/tmp/a space/한글', codexPath: '/some path/codex', provider: 'codex' };

test('main receives ordered native args and unchanged cwd with no scratchpad text', () => {
  const args = ['--model', 'gpt-example', '-c', 'features.alpha=true', '--no-alt-screen', '--cd=/tmp/b space'];
  const options = { ...base, nativeArgs: args };
  assert.deepEqual(buildMainCommand(options), { executable: '/some path/codex', args: ['resume', id, ...args, '--config', 'tui.status_line=["session-id","model-with-reasoning","context-remaining","current-dir"]'], cwd: '/tmp/a space/한글' });
  assert.deepEqual(args, ['--model', 'gpt-example', '-c', 'features.alpha=true', '--no-alt-screen', '--cd=/tmp/b space']);
});
test('fork uses exact ID and starts idle with matching native permissions', () => {
  const options = { ...base, nativeArgs: ['--sandbox', 'danger-full-access', '--approve-for-me', '--add-dir', '/tmp', '-c', 'sandbox_mode="danger-full-access"', '-p', 'work', '-m', 'old-model'] };
  const fork = buildForkCommand(options, 'UNIQUE_QUOTE_MARKER', { model: 'current-model', effort: 'high' });
  assert.deepEqual(fork.args.slice(0, 2), ['fork', id]);
  assert.ok(!fork.args.join(' ').includes('UNIQUE_QUOTE_MARKER'));
  assert.ok(fork.args.includes('danger-full-access'));
  assert.ok(fork.args.includes('--approve-for-me'));
  assert.ok(fork.args.includes('--add-dir'));
  assert.ok(!fork.args.includes('read-only'));
});
test('explicit side fallback overrides saved settings without changing main', () => {
  const options = {...base, sideModel:'fallback', sideEffort:'medium'};
  assert.ok(buildForkCommand(options, 'quoted text', {}).args.includes('fallback'));
  assert.ok(buildForkCommand(options, 'quoted text', {}).args.includes('model_reasoning_effort="medium"'));
  assert.deepEqual(buildMainCommand(options).args.slice(0,2), ['resume', id]);
  assert.throws(() => buildForkCommand(base, 'text', {}), /side-model/);
  assert.throws(() => buildForkCommand(base, 'text', {model:'x', active:true}), /finish|active/i);
  assert.throws(() => buildForkCommand({...options,sideEffort:'bad'}, 'text', {}), /effort/);
});
test('parser consumes only wrapper options before separator', () => {
  assert.deepEqual(parseArgs(['codex','--session',id,'--side-model','x','--side-effort','high','--','-m','native']), { command:'codex', sessionId:id, sideModel:'x', sideEffort:'high', nativeArgs:['-m','native'] });
  for (const args of [['codex','--session','no'], ['codex','--session',id,'--session',id]]) assert.throws(() => parseArgs(args));
  assert.throws(() => buildMainCommand({...base,sessionId:'bad'}), /UUID/);
});
test('the banner opt-out belongs to Shoulder only before the native separator', () => {
  assert.deepEqual(parseArgs(['codex', '--no-banner', '--yolo']), { command: 'codex', noBanner: true, nativeArgs: ['--yolo'] });
  assert.deepEqual(parseArgs(['codex', '--', '--no-banner']), { command: 'codex', nativeArgs: ['--no-banner'] });
  assert.throws(() => parseArgs(['codex', '--no-banner', '--no-banner']), /Repeated wrapper option/);
  assert.throws(() => parseArgs(['codex', '--no-banner=false']), /does not take a value/);
});
test('doctor requires actual capability output and performs no inference', async () => {
  const calls=[];
  const run = async (executable,args) => {
    calls.push([executable,args]);
    if (args[0]==='--version') return {exitCode:0,stdout:'codex-cli 0.162.1',stderr:''};
    if (executable==='tmux') return {exitCode:0,stdout:'tmux 3.6a',stderr:''};
    return {exitCode:0,stdout:`Usage: codex ${args[0]} [OPTIONS] [SESSION_ID] [PROMPT]\n--sandbox --model --config --profile`,stderr:''};
  };
  const result=await doctor(run);
  assert.equal(result.ok,true);
  assert.equal(calls.length,4);
  assert.ok(calls.every(([,a]) => a.includes('--help') || a.includes('--version') || a.includes('-V')));
  assert.equal((await doctor(async () => ({exitCode:0,stdout:'',stderr:'Operation not permitted'}))).ok,false);
});
test('built executable provides help and version without launching provider', () => {
  for (const args of [['--help'],['--version']]) {
    const child=spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    if(args[0]==='--help') assert.match(child.stdout,/shoulder codex \[--session UUID\]/);
    else assert.equal(child.stdout.trim(),version);
  }
});

test('fork starts in the saved effective working directory', () => {
  assert.equal(buildForkCommand(base, 'text', {model:'current',effort:'high',cwd:'/saved/work'}).cwd, '/saved/work');
});
test('provider receives literal quote argv through an executable with spaces', async t => {
  const directory=await mkdtemp(join(tmpdir(),'side-ask-provider-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,'fake codex');
  await writeFile(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n');
  await chmod(executable,0o700);
  const marker=join(directory,'must-not-exist');
  const quote='QUOTE_MARKER $(touch "'+marker+'") `touch "'+marker+'"`; 世界';
  const command=buildForkCommand({...base,codexPath:executable,cwd:directory},quote,{model:'current',effort:'high'});
  const child=spawnSync(command.executable,command.args,{cwd:command.cwd,shell:false,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const observed=JSON.parse(child.stdout);
  assert.deepEqual(observed.args.slice(0,2),['fork',id]);
  assert.ok(!observed.args.join(' ').includes(quote));
  assert.equal(observed.cwd,await realpath(directory));
  const {existsSync}=await import('node:fs');
  assert.equal(existsSync(marker),false);
});
test('CLI runs when invoked via an npm-style symlink', async t => {
  const directory=await mkdtemp(join(tmpdir(),'side-ask-bin-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const bin=join(directory,'side-ask');
  await symlink(resolve('dist/cli.js'),bin);
  const child=spawnSync(process.execPath,[bin,'--version'],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),version);
});

test('fresh parser omits identity while preserving ordered native arguments', () => {
  assert.deepEqual(parseArgs(['codex']), {command:'codex',nativeArgs:[]});
  assert.deepEqual(parseArgs(['codex','--side-model','side','--side-effort','high','--','-m','main','--no-daemon']), {command:'codex',nativeArgs:['-m','main','--no-daemon'],sideModel:'side',sideEffort:'high'});
  assert.throws(()=>parseArgs(['codex','--session','']), /value/);
});
test('fresh main launches native Codex with only invocation-local footer display config', () => {
  const options = {...base, sessionId:undefined, nativeArgs:['-p','work','-m','native','--no-daemon','--cd=/tmp/project']};
  assert.deepEqual(buildMainCommand(options), {executable:base.codexPath,args:['-p','work','-m','native','--no-daemon','--cd=/tmp/project','--config','tui.status_line=["session-id","model-with-reasoning","context-remaining","current-dir"]'],cwd:base.cwd});
  assert.deepEqual(options.nativeArgs,['-p','work','-m','native','--no-daemon','--cd=/tmp/project']);
  assert.throws(()=>buildForkCommand({...options,sessionId:undefined},'quote',{model:'m',effort:'high'}),/UUID|identity|session/i);
});


test('direct shortcut opt-out is consumed only before the native separator', () => {
  assert.deepEqual(parseArgs(['codex', '--no-direct-keys', '--yolo']), { command: 'codex', noDirectKeys: true, nativeArgs: ['--yolo'] });
  assert.deepEqual(parseArgs(['codex', '--', '--no-direct-keys']), { command: 'codex', nativeArgs: ['--no-direct-keys'] });
  assert.throws(() => parseArgs(['codex', '--no-direct-keys=false']), /does not take a value/);
  assert.throws(() => parseArgs(['codex', '--no-direct-keys', '--no-direct-keys']), /Repeated wrapper option/);
});
