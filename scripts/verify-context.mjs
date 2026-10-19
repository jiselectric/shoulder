#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntime,openScratchpad,clearScratchpad,loadState,cleanup} from '../dist/runtime.js';
import {buildReferenceCommand} from '../dist/codex.js';
import {tmux} from '../dist/tmux.js';
import {parseComposerFooter,readSessionSettings,readSessionActivity} from '../dist/session.js';

function text(payload) {return (payload.content??[]).map(item=>item.text??'').join('\n');}
// Inspect only decoded model-supplied tool arguments, never incidental tool
// metadata. Token boundaries keep a sibling/prefixed filename from counting as
// the exact source. Unknown argument encodings fail closed without evaluation.
function referencesExactPath(call,path) {
  let input;
  if(call.type==='custom_tool_call') input=call.input;
  else {
    input=call.arguments;
    if(typeof input==='string') {try{input=JSON.parse(input);}catch{return false;}}
  }
  const escaped=path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const token=new RegExp("(^|[\\s\"'`])"+escaped+"(?=$|[\\s\"'`])");
  function contains(value) {
    if(typeof value==='string') return value===path||token.test(value);
    if(Array.isArray(value)) return value.some(contains);
    if(value&&typeof value==='object') return Object.values(value).some(contains);
    return false;
  }
  return contains(input);
}
function turnRecords(records,turnId) {
  if(turnId===undefined)return records;
  const starts=records.flatMap((row,index)=>row.type==='event_msg'&&row.payload?.type==='task_started'&&row.payload.turn_id===turnId?[index]:[]);
  const ends=records.flatMap((row,index)=>row.type==='event_msg'&&row.payload?.type==='task_complete'&&row.payload.turn_id===turnId?[index]:[]);
  assert.ok(starts.length===1&&ends.length===1&&ends[0]>starts[0],'Fresh side turn lacks an exact completed lifecycle.');
  const scoped=records.slice(starts[0],ends[0]+1);
  assert.ok(!scoped.some(row=>row.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(row.payload?.type)&&row.payload.turn_id!==turnId),'Side turn contains a conflicting lifecycle.');
  return scoped;
}
export function verifyContextEvidence(e) {
  const items=e.sideRecords.filter(row=>row.type==='response_item').map(row=>row.payload);
  const scoped=turnRecords(e.sideRecords,e.turnId).filter(row=>row.type==='response_item').map(row=>row.payload);
  const developer=items.filter(item=>item.type==='message'&&item.role==='developer').map(text).join('\n');
  const developerLines=developer.split('\n');
  assert.ok(developerLines.includes(`Shoulder source session: ${e.sourceId}`)&&developerLines.includes(`Exact local transcript: ${JSON.stringify(e.sourcePath)}`),'Exact source reference is missing from native developer input.');
  assert.ok(![...e.sideArgs,e.quote,e.question].some(value=>value.includes(e.nonce)),'Canary leaked into side input.');
  const outputIndex=scoped.findIndex(item=>['function_call_output','custom_tool_call_output'].includes(item.type)&&JSON.stringify(item).includes(e.nonce));
  assert.ok(outputIndex>=0,'No fresh native tool output retrieved the canary in this side turn.');
  const output=scoped[outputIndex],globalOutputIndex=items.indexOf(output);
  assert.ok(!items.slice(0,globalOutputIndex).some(item=>JSON.stringify(item).includes(e.nonce)),'Canary leaked before the fresh source read into model input.');
  const call=scoped.slice(0,outputIndex).find(item=>['function_call','custom_tool_call'].includes(item.type)&&item.call_id===output.call_id);
  assert.ok(call&&referencesExactPath(call,e.sourcePath),'The canary tool read did not reference the exact source file in this side turn.');
  const answer=scoped.filter(item=>item.type==='message'&&item.role==='assistant').map(text).at(-1)?.trim();
  assert.equal(answer,e.nonce,'The side answer did not match the fresh canary exactly.');
  assert.equal(e.parentUnchanged,true,'Parent history changed during the side conversation.');
  return {referenceVerified:true,nonceAbsentFromInput:true,sourceReadVerified:true,nonceMatched:true,parentUnchanged:true};
}

export function verifyEvolvingContextEvidence(e) {
  assert.equal(e.turns.length,2,'Evolving context needs two side turns after separate source updates.');
  assert.match(e.initialSourceDigest,/^[a-f0-9]{64}$/,'Missing source snapshot from before the side opened.');
  let previousDigest=e.initialSourceDigest;
  const nonces=new Set(),turnIds=new Set();
  const turns=e.turns.map(turn=>{
    assert.equal(turn.sideId,e.sideId,'Side identity changed between follow-up turns.');
    const headers=turn.sideRecords.filter(row=>row.type==='session_meta');
    assert.ok(headers.length===1&&headers[0].payload?.id===e.sideId,'Saved side identity differs from the same native side.');
    assert.ok(typeof turn.turnId==='string'&&!turnIds.has(turn.turnId),'Each fresh side answer needs a distinct turn identity.');
    turnIds.add(turn.turnId);
    assert.ok(!/\b(?:main|source|transcript|read)\b/i.test(turn.question),'Native question contains a context retrieval hint.');
    assert.match(turn.nonce,/^\d+$/,'Fresh context value must be a decimal number.');
    assert.ok(!nonces.has(turn.nonce),'Fresh main updates must use distinct values.');nonces.add(turn.nonce);
    assert.match(turn.sourceBeforeDigest,/^[a-f0-9]{64}$/,'Missing updated source snapshot.');
    assert.notEqual(turn.sourceBeforeDigest,previousDigest,'Source did not advance before this side turn.');
    assert.equal(turn.sourceAfterDigest,turn.sourceBeforeDigest,'Parent history changed during this side operation.');
    previousDigest=turn.sourceBeforeDigest;
    return verifyContextEvidence({...turn,sourceId:e.sourceId,sourcePath:e.sourcePath,sideArgs:e.sideArgs,parentUnchanged:true});
  });
  return {sameSideVerified:true,sourceAdvancedBeforeEachTurn:true,turns};
}

// Native tools wrap stdout in different receipt shapes. Parse only bounded
// JSON payloads; never evaluate tool text or treat source text as instructions.
function readerResponses(value, depth=0) {
  if(depth>6)return [];
  if(typeof value==='string') {
    if(Buffer.byteLength(value)>1024*1024)return [];
    try{return readerResponses(JSON.parse(value),depth+1);}catch{}
    return value.split('\n').flatMap(line=>{
      if(!line.trimStart().startsWith('{'))return [];
      try{return readerResponses(JSON.parse(line),depth+1);}catch{return [];}
    });
  }
  if(!value||typeof value!=='object')return [];
  if(value.sourceSessionId&&Array.isArray(value.messages))return [value];
  return Object.values(value).flatMap(item=>readerResponses(item,depth+1));
}
export function verifyIncrementalReaderEvidence(e) {
  const items=turnRecords(e.sideRecords,e.turnId).filter(row=>row.type==='response_item').map(row=>row.payload);
  for(const output of items.filter(item=>['function_call_output','custom_tool_call_output'].includes(item.type))) {
    const call=items.find(item=>['function_call','custom_tool_call'].includes(item.type)&&item.call_id===output.call_id);
    if(!call||!referencesExactPath(call,e.sourcePath)||!referencesExactPath(call,e.readerPath))continue;
    if(e.previousCursor)assert.ok(referencesExactPath(call,e.previousCursor),'Reader did not consume the preceding refresh cursor.');
    const responses=readerResponses(output.output);
    for(const response of responses) {
      assert.equal(response.sourceSessionId,e.sourceId,'Reader output belongs to another source.');
      assert.equal(response.status,e.expectedStatus,'Reader did not use the expected incremental mode.');
      assert.match(response.sourceVersion,/^[a-f0-9]{64}$/,'Reader source version is missing.');
      assert.ok(typeof response.cursor==='string'&&response.cursor,'Reader refresh cursor is missing.');
      assert.equal(response.hasMore,false,'Reader left an update page unread.');
      if(e.expectedStatus==='unchanged')assert.deepEqual(response.messages,[],'Unchanged refresh repeated message text.');
      else {
        assert.ok(response.messages.some(message=>typeof message.text==='string'&&message.text.includes(e.nonce)),'Reader did not return the fresh value.');
        if(e.previousNonce)assert.ok(!response.messages.some(message=>message.text.includes(e.previousNonce)),'Incremental refresh repeated prior context.');
      }
      return {status:response.status,cursor:response.cursor,responseBytes:Buffer.byteLength(JSON.stringify(response)),messages:response.messages.length};
    }
  }
  assert.fail('No source-bound local reader result was observed in this completed side turn.');
}

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,ms=90000) {
  const end=Date.now()+ms;let last;
  while(Date.now()<end){try{const result=await check();if(result)return result;}catch(error){last=error;}await delay(100);}
  throw new Error(`${label}. ${last?.message??'Check native CLI trust/authentication and model availability.'}`);
}
const digest=value=>createHash('sha256').update(value).digest('hex');
async function savedRecords(path) {
  return (await readFile(path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
}
function latestCompletedTurn(records) {
  return records.filter(row=>row.type==='event_msg'&&row.payload?.type==='task_complete').at(-1)?.payload.turn_id;
}
function lastAnswer(records) {
  return records.filter(row=>row.type==='response_item'&&row.payload?.role==='assistant').map(row=>text(row.payload)).at(-1)?.trim();
}
function usageDelta(before,after) {
  const totals=rows=>rows.filter(row=>row.type==='event_msg'&&row.payload?.type==='token_count').map(row=>row.payload.info?.total_token_usage).filter(Boolean).at(-1);
  const a=totals(after),b=totals(before)??{};
  if(!a)return null;
  const result={};
  for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']) {
    if(typeof a[key]!=='number'||a[key]<(b[key]??0))return null;
    result[key]=a[key]-(b[key]??0);
  }
  return result;
}

async function submit(state,pane,question) {
  await tmux(state,['send-keys','-t',pane,'-l',question]);
  await delay(300); // Let the native TUI finish recognizing its paste burst.
  await tmux(state,['send-keys','-t',pane,'Enter']);
}
async function completedTurn(home,id,previous,label) {
  return until(async()=>{
    if((await readSessionActivity(home,id))!=='idle')return false;
    const settings=await readSessionSettings(home,id),records=await savedRecords(settings.transcriptPath);
    const turnId=latestCompletedTurn(records);
    return typeof turnId==='string'&&turnId!==previous&&{settings,records,turnId};
  },label,120000);
}
async function readyComposer(state,pane,id,label) {
  return until(async()=>{
    const observed=parseComposerFooter(await tmux(state,['capture-pane','-p','-t',pane]));
    assert.equal(observed,id,'Native composer changed conversation identity.');
    return observed;
  },label,15000);
}
export async function runContextVerification() {
  const home=process.env.CODEX_HOME??join(homedir(),'.codex');
  process.stdout.columns=160;process.stdout.rows=45;
  let state,sourceId,sideId,phase='startup';
  try{
    console.error('Running six small native Codex turns: two fresh values, unhinted side follow-ups and an unchanged refresh.');
    state=await createRuntime({provider:'codex',codexPath:'codex',cwd:process.cwd(),nativeArgs:['--no-daemon','Reply exactly Ready. Do not use tools or read files.']});
    sourceId=await until(async()=>{
      const id=parseComposerFooter(await tmux(state,['capture-pane','-p','-t',state.mainPane]));
      await readSessionSettings(home,id);return id;
    },'The neutral main turn did not finish',120000);
    const source=await readSessionSettings(home,sourceId),initialSourceDigest=digest(await readFile(source.transcriptPath));
    const quote='Ready';
    phase='waiting for initial main composer';
    await readyComposer(state,state.mainPane,sourceId,'The initial main composer did not repaint');
    phase='opening side before either number update';
    console.error(JSON.stringify({phase,sourceId}));
    await openScratchpad(state,quote);
    const current=await loadState(state.directory);sideId=current.sideSessionId;
    console.error(JSON.stringify({phase:'side opened before updates',sourceId,sideId}));
    assert.ok(sideId,'Side opened without a verified native identity.');
    assert.equal(digest(await readFile(source.transcriptPath)),initialSourceDigest,'Opening the side changed the parent.');
    const sideArgs=buildReferenceCommand({...state.options,sessionId:sourceId},source).args;
    let parentTurn=latestCompletedTurn(await savedRecords(source.transcriptPath)),sideTurn;
    const turns=[],metrics=[],readerChecks=[];
    const readerPath=fileURLToPath(new URL('../dist/context-reader.js',import.meta.url));
    let refreshCursor,lastSideRecords=[];
    for(let index=0;index<2;index++) {
      let nonce;do{nonce=BigInt('0x'+randomBytes(12).toString('hex')).toString();}while(turns.some(turn=>turn.nonce===nonce));
      phase=`main update ${index+1}`;
      await submit(state,state.mainPane,`Generate ${index?'another':'a'} random number. For this controlled check, use ${nonce}. Reply with that number only. Do not use tools.`);
      const updated=await completedTurn(home,sourceId,parentTurn,'The new main number did not finish');
      parentTurn=updated.turnId;
      assert.equal(lastAnswer(updated.records),nonce,'The main did not save the controlled fresh number.');
      await readyComposer(state,state.mainPane,sourceId,'The updated main composer did not repaint');
      const before=await readFile(source.transcriptPath),sourceBeforeDigest=digest(before);
      const question=index?"What is the random number you've generated now? Reply with the number only.":"What is the random number you've generated? Reply with the number only.";
      phase=`side follow-up ${index+1}`;
      const started=Date.now();
      await submit(state,current.sidePane,question);
      const side=await completedTurn(home,sideId,sideTurn,'The unhinted side answer did not finish');
      sideTurn=side.turnId;
      phase=`side composer repaint ${index+1}`;
      const observedId=await readyComposer(state,current.sidePane,sideId,'The completed side composer did not repaint');
      const turn={turnId:sideTurn,sideId:observedId,nonce,quote:index?'':quote,question,sideRecords:side.records,sourceBeforeDigest,sourceAfterDigest:digest(await readFile(source.transcriptPath))};
      turns.push(turn);
      const scoped=turnRecords(side.records,sideTurn).filter(row=>row.type==='response_item').map(row=>row.payload);
      const calls=scoped.filter(item=>['function_call','custom_tool_call'].includes(item.type));
      const outputs=scoped.filter(item=>['function_call_output','custom_tool_call_output'].includes(item.type));
      const metric={turn:index+1,turnId:sideTurn,elapsedMs:Date.now()-started,toolCalls:calls.length,toolOutputBytes:outputs.reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item)),0),reportedUsage:usageDelta(lastSideRecords,side.records)};
      lastSideRecords=side.records;
      metrics.push(metric);
      console.error(JSON.stringify(metric));
      // Fail on the first stale turn, rather than hiding it behind a later read.
      verifyContextEvidence({...turn,sourceId,sourcePath:source.transcriptPath,sideArgs,parentUnchanged:turn.sourceBeforeDigest===turn.sourceAfterDigest});
      const readerCheck=verifyIncrementalReaderEvidence({...turn,sourceId,sourcePath:source.transcriptPath,readerPath,expectedStatus:index?'delta':'snapshot',...(index?{previousCursor:refreshCursor,previousNonce:turns[0].nonce}:{})});
      refreshCursor=readerCheck.cursor;
      readerChecks.push({status:readerCheck.status,responseBytes:readerCheck.responseBytes,messages:readerCheck.messages});
      if(index===0) {
        phase='unchanged side refresh';
        const repeatedStarted=Date.now();
        await submit(state,current.sidePane,'What was that number again? Reply with the number only.');
        const repeated=await completedTurn(home,sideId,sideTurn,'The unchanged side answer did not finish');
        sideTurn=repeated.turnId;
        await readyComposer(state,current.sidePane,sideId,'The unchanged side composer did not repaint');
        assert.equal(lastAnswer(repeated.records),nonce,'The unchanged question lost the known value.');
        assert.equal(digest(await readFile(source.transcriptPath)),sourceBeforeDigest,'The unchanged refresh modified the source.');
        const check=verifyIncrementalReaderEvidence({sourceId,sourcePath:source.transcriptPath,readerPath,sideRecords:repeated.records,turnId:sideTurn,expectedStatus:'unchanged',previousCursor:refreshCursor});
        metrics.push({turn:'unchanged',elapsedMs:Date.now()-repeatedStarted,readerResponseBytes:check.responseBytes,reportedUsage:usageDelta(lastSideRecords,repeated.records)});
        lastSideRecords=repeated.records;
        refreshCursor=check.cursor;
        readerChecks.push({status:check.status,responseBytes:check.responseBytes,messages:check.messages});
      }

    }
    const checks=verifyEvolvingContextEvidence({sourceId,sourcePath:source.transcriptPath,sideId,sideArgs,initialSourceDigest,turns});
    const side=await readSessionSettings(home,sideId);
    const width=await tmux(state,['display-message','-p','-t',current.sidePane,'#{pane_width}']);
    phase='clear after both context checks';
    await clearScratchpad(state);
    const cleared=await loadState(state.directory);
    const newId=await until(async()=>{const id=parseComposerFooter(await tmux(state,['capture-pane','-p','-t',current.sidePane]));return id!==sideId&&id;},'Cleared side did not become ready',15000);
    assert.equal(cleared.sidePane,current.sidePane,'Clear closed/replaced the pane.');
    assert.notEqual(newId,sideId,'Clear kept the previous conversation identity.');
    assert.equal(await tmux(state,['display-message','-p','-t',current.sidePane,'#{pane_width}']),width,'Clear changed the pane width.');
    const screen=await tmux(state,['capture-pane','-p','-t',current.sidePane]);
    assert.ok(turns.every(turn=>!screen.includes(turn.nonce)),'Clear retained the old visible conversation.');
    const result={sourceId,sideId,checks,readerChecks,metrics,clearKeepsPane:true,model:side.model,effort:side.effort,limits:'Observed native behavior only: same side refreshed the exact source after each main update without retrieval hints. Tool-output bytes are not token counts. Optional reportedUsage is a native cumulative-counter difference for this observed turn, not a controlled billing comparison or savings guarantee. Elapsed time is not a latency guarantee. Native saved QA histories are retained.'};
    console.log(JSON.stringify(result,null,2));return result;
  }catch(error){
    console.error(JSON.stringify({failedPhase:phase,sourceId,sideId}));
    if(state) {
      const directory=await mkdtemp('/tmp/shoulder-context-failure-');
      const current=await loadState(state.directory).catch(()=>state);
      for(const [role,pane] of [['main',state.mainPane],['side',current.sidePane]])if(pane) {
        const screen=await tmux(state,['capture-pane','-p','-t',pane]).catch(()=>'(owned pane unavailable)');
        await writeFile(join(directory,`${role}.txt`),screen,{mode:0o600});
      }
      console.error(`Owned QA pane captures: ${directory}`);
    }
    throw error;
  }finally{if(state)await cleanup(state);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await runContextVerification();}catch(error){console.error(`Context verification FAILED: ${error.message}`);process.exitCode=1;}
}
