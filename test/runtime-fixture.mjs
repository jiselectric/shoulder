import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntime, cleanup, loadState } from '../dist/runtime.js';
import { parseComposerFooter } from '../dist/session.js';
export const exec=promisify(execFile);
export const id='12345678-1234-4234-8234-123456789abc';
export const tmux=(state,...args)=>exec('tmux',['-S',state.socket,...args],{encoding:'utf8'}).then(x=>x.stdout.trim());
export async function until(fn,message='condition',ms=5000) {
  const end=Date.now()+ms;
  let value;
  while(Date.now()<end) { try { value=await fn(); if(value) return value; } catch {} await new Promise(r=>setTimeout(r,35)); }
  throw new Error(`Timed out: ${message}`);
}
export async function records(dir,kind) { return Promise.all((await readdir(dir)).filter(x=>x.startsWith(`${kind}-`)&&x.endsWith('.json')).map(async x=>JSON.parse(await readFile(join(dir,x),'utf8')))); }
export async function fixture(t,overrides={},start=true) {
  const dir=await mkdtemp(join(tmpdir(),'side ask 日本語-'));
  const home=join(dir,'codex home'), work=join(dir,'work 日本語'), logs=join(dir,'logs');
  await Promise.all([mkdir(join(home,'sessions'),{recursive:true}),mkdir(work),mkdir(logs)]);
  const provider=join(dir,"native ' codex.mjs");
  await chmod(resolve('test/fixtures/fake-codex.mjs'),0o755);
  await symlink(resolve('test/fixtures/fake-codex.mjs'),provider);
  const oldHome=process.env.CODEX_HOME,oldLog=process.env.SIDE_ASK_TEST_LOG,oldStateHome=process.env.XDG_STATE_HOME;
  process.env.CODEX_HOME=home; process.env.SIDE_ASK_TEST_LOG=logs;
  process.env.XDG_STATE_HOME=join(dir,'state');
  const file=join(home,'sessions',`rollout-test-${id}.jsonl`);
  async function metadata({active=false,missing=false,cwd=work,identity=id}={}) {
    const rows=[{type:'session_meta',payload:{id:identity,cwd:work}},{type:'event_msg',payload:{type:'task_started',turn_id:'t1'}},{type:'turn_context',payload:{turn_id:'t1',model:'effective-current',...(missing?{}:{effort:'high'}),cwd}}];
    if(!active) rows.push({type:'event_msg',payload:{type:'task_complete',turn_id:'t1'}});
    await writeFile(file,rows.map(x=>JSON.stringify(x)+'\n').join(''));
  }
  await metadata();
  let state;
  // Node runs these test hooks in registration order. Own outer launchers here
  // so their final result writes finish before the base directory is removed.
  const beforeRemove=[];
  t.after(async()=>{
    try { if(state) await cleanup(state); }
    finally {
      try { for(const dispose of beforeRemove) await dispose(); }
      finally {
        if(oldHome===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=oldHome;
        if(oldLog===undefined) delete process.env.SIDE_ASK_TEST_LOG; else process.env.SIDE_ASK_TEST_LOG=oldLog;
        if(oldStateHome===undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME=oldStateHome;
        await rm(dir,{recursive:true,force:true});
      }
    }
  });
  const options={provider:'codex',sessionId:id,nativeArgs:['--profile','name with 日本語','--no-alt-screen'],cwd:dir,codexPath:provider,...overrides};
  if(start) {
    state=await createRuntime(options);
    await until(async()=>(await records(logs,'main')).length===1,'main native process');
  }
  return {state,dir,home,work,logs,file,options,metadata,trackState:value=>{state=value;},beforeRemove:dispose=>beforeRemove.push(dispose)};
}
export async function launchFixture(t,prepare) {
  const f=await fixture(t,{},false);
  if(prepare) await prepare(f);
  const outer=await mkdtemp('/tmp/side-ask-pty-');
  const socket=join(outer,'pty.sock'),config=join(outer,'config.json'),result=join(outer,'result');
  await writeFile(config,JSON.stringify(f.options));
  f.beforeRemove(async()=>{
    await exec('tmux',['-S',socket,'kill-server']).catch(()=>{});
    try {
      const pid=Number(await readFile(`${result}.pid`,'utf8').catch(()=>''));
      if(Number.isSafeInteger(pid)&&pid>0) await until(()=>{
        try { process.kill(pid,0); return false; }
        catch(error) { if(error.code==='ESRCH') return true; throw error; }
      },'owned fixture launcher exits before deleting its result directory');
    } finally { await rm(outer,{recursive:true,force:true}); }
  });
  const tmuxConfig=join(outer,'tmux.conf');
  await writeFile(tmuxConfig,'set-window-option -g remain-on-exit on\n');
  await exec('tmux',['-f',tmuxConfig,'-S',socket,'new-session','-d','-s','pty','-x','120','-y',String(f.rows ?? 40),process.execPath,resolve('test/fixtures/launch.mjs'),config,result]);
  return {...f,outerState:{socket},result};
}
export async function attachedFixture(t,prepare) {
  const f=await launchFixture(t,prepare);
  await until(async()=>(await records(f.logs,'main')).length===1,'attached native main');
  const [main]=await records(f.logs,'main');
  const state=await loadState(main.tmux.split(',')[0].replace(/\/tmux\.sock$/,''));
  // The base cleanup hook runs first. Stop writers before removing their logs.
  f.trackState(state);
  // The provider records its PID before drawing. A faster runtime can observe
  // that file while the attached native composer is still painting; callers
  // need an interactive fixture, not merely a spawned child. Keep production's
  // fail-closed readiness behavior and wait here on the actual rendered frame.
  await until(async()=>{
    if(!(await tmux(state,'list-clients','-F','#{client_tty}'))) return false;
    const screen=await tmux(state,'capture-pane','-p','-t',state.mainPane);
    if(!screen.includes('NATIVE_READY')) return false;
    if(f.options.provider==='generic') return /\? for shortcuts\s*$/.test(screen);
    return Boolean(parseComposerFooter(screen));
  },'attached native composer ready');
  return {...f,state,main};
}

export const freshId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export async function freshFixture(t) {
  return attachedFixture(t,async f=>{
    delete f.options.sessionId;
    f.options.publicCli=true;
    await symlink(f.options.codexPath,join(f.dir,'codex'));
    // Direct action calls must use the same provider lookup as the public CLI.
    const previousPath=process.env.PATH;
    process.env.PATH=`${f.dir}:${previousPath ?? ''}`;
    t.after(()=>{if(previousPath===undefined) delete process.env.PATH; else process.env.PATH=previousPath;});
    await rm(f.file);
    await writeFile(join(f.logs,'fresh-config.json'),JSON.stringify({id,newId:freshId,cwd:f.work,model:'fresh-effective',effort:'high'}));
  });
}
