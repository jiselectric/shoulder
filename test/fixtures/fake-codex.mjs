#!/usr/bin/env node
import { existsSync, writeFileSync, appendFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2), reference=args.some(arg=>arg.startsWith('developer_instructions=')&&arg.includes('Shoulder source session:'));
const kind=args[0]==='fork'||reference?'fork':'main';
if (args.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
if (args.includes('--help')) {
  console.log(`Usage: codex ${args[0]} [SESSION_ID] [PROMPT]\n--sandbox --model --config --profile`);
  const remove=join(process.env.SIDE_ASK_TEST_LOG,'remove-provider-after-doctor');
  if(args[0]==='fork' && existsSync(remove)) unlinkSync(readFileSync(remove,'utf8'));
  process.exit(0);
}
const dir=process.env.SIDE_ASK_TEST_LOG;
const n=readdirSync(dir).filter(x=>x.startsWith(`${kind}-`) && x.endsWith('.json')).length;
writeFileSync(join(dir,`${kind}-${n}.json`),JSON.stringify({args,cwd:process.cwd(),pid:process.pid,tmux:process.env.TMUX}));
if(kind==='fork' && existsSync(join(dir,'fail-fork'))) { console.error('FAKE_PROVIDER_ERROR authentication required'); process.exit(7); }
const freshFile=join(dir,'fresh-config.json');
const fresh=kind==='main' && existsSync(freshFile) ? JSON.parse(readFileSync(freshFile,'utf8')) : undefined;
let nativeId=fresh?.id ?? (kind==='fork' ? randomUUID() : args[1]), footerMode='normal';
let draft='', input='', pasting=false, lastAnswer='';
function saveSideHeader() {writeFileSync(join(process.env.CODEX_HOME,'sessions',`rollout-side-${nativeId}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:nativeId,cwd:process.cwd()}})+'\n');}
if(kind==='fork'&&!reference) saveSideHeader();
function renderFresh(answer='') {
  lastAnswer=answer;
  // Publish one frame per write instead of exposing row-by-row redraw gaps.
  // Missing/truncated/busy modes still exercise production's refusal guards.
  const lines=["SELECT passage 日本語 quotes ' $(touch SHOULD_NOT_EXIST) ; end",'NATIVE_READY'];
  if(answer) lines.push(`native:${answer}`);
  if(kind==='fork') lines.push('FORK_READY');
  // An unrelated exact-ID footer inside response content must never win.
  lines.push('  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa · decoy response','  ? for shortcuts','response content ends here');
  if(footerMode!=='missing') {
    if(footerMode==='truncated') lines.push(`  ${nativeId.slice(0,-1)} · GPT-6.1-Sol high fast`);
    // Keep the status within the narrowest tested pane on resize.
    else lines.push(`  ${nativeId} · GPT-6.1-Sol high fast`.slice(0,Math.min(process.stdout.columns || 120,48)));
    lines.push(footerMode==='busy' ? '  esc to interrupt' : footerMode==='warning' ? '  ? for shortcuts                     ⚠ 1 warning · f2 to view' : '  ? for shortcuts');
  }
  process.stdout.write('\x1b[2J\x1b[H'+lines.join('\n')+'\n');
}
function completeFreshTurn() {
  const rows=[{type:'session_meta',payload:{id:nativeId,cwd:fresh.cwd}},{type:'event_msg',payload:{type:'task_started',turn_id:'fresh-turn'}},{type:'turn_context',payload:{turn_id:'fresh-turn',model:fresh.model,effort:fresh.effort,cwd:fresh.cwd}},{type:'event_msg',payload:{type:'task_complete',turn_id:'fresh-turn'}}];
  writeFileSync(join(process.env.CODEX_HOME,'sessions',`rollout-fresh-${nativeId}.jsonl`),rows.map(x=>JSON.stringify(x)+'\n').join(''));
}
process.stdout.write('\x1b[?2004h\x1b[?1002h\x1b[?1006h');
if(process.stdin.isTTY) process.stdin.setRawMode(true);
if(kind==='fork' && existsSync(join(dir,'side-dialog'))) { console.log('Trust this folder?\n1. Trust\n2. Quit'); }
else renderFresh();
process.on('SIGWINCH',()=>renderFresh(lastAnswer));
process.stdout.on('resize',()=>renderFresh(lastAnswer));
function submit(line) {
  if(kind==='fork'&&!existsSync(join(process.env.CODEX_HOME,'sessions',`rollout-side-${nativeId}.jsonl`))) saveSideHeader();
  appendFileSync(join(dir,`${kind}.transcript`),line+'\n');
  if(line==='/exit') process.exit(0);
  if(line==='/exit7') { console.error('FAKE_PROVIDER_ERROR authentication or configuration failed'); process.exit(7); }
  if(fresh || kind==='fork') {
    if(line==='/new' || line==='/clear') { nativeId=fresh?.newId ?? randomUUID(); renderFresh('CLEARED'); return; }
    else if(line.startsWith('/footer ')) footerMode=line.slice(8);
    else if(fresh) completeFreshTurn();
    renderFresh(line);
  } else renderFresh(line);
}
process.stdin.on('data',chunk=>{
  input+=chunk.toString();
  for(;;) {
    if(pasting) {
      const end=input.indexOf('\x1b[201~');
      if(end<0) break;
      draft+=input.slice(0,end); input=input.slice(end+6); pasting=false;
      writeFileSync(join(dir,`${kind}-${n}.draft`),draft);
      continue;
    }
    if(!input.length) break;
    if(input.startsWith('\x1b[200~')) {input=input.slice(6); pasting=true; continue;}
    if(input[0]==='\x1b' && '\x1b[200~'.startsWith(input)) break;
    const ch=input[0]; input=input.slice(1);
    if(ch==='\r' || ch==='\n') { const line=draft; draft=''; submit(line); }
    else if(ch==='\x15') draft='';
    else if(ch==='\x7f') draft=draft.slice(0,-1);
    else draft+=ch;
    writeFileSync(join(dir,`${kind}-${n}.draft`),draft);
  }
});
