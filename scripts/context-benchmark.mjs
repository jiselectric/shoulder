#!/usr/bin/env node
// Synthetic retrieval-output comparison, not tokenizer or provider billing data.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {readContext} from '../dist/context.js';
const directory=await mkdtemp(join(tmpdir(),'shoulder-context-benchmark-'));
const sourcePath=join(directory,'source.jsonl'),sessionId='12345678-1234-4234-8234-123456789abc';
const line=x=>JSON.stringify(x)+'\n';
const turn=i=>[
 {type:'event_msg',payload:{type:'task_started',turn_id:'turn-'+i}},
 {type:'event_msg',payload:{type:'user_message',message:`Question ${i}: `+'synthetic project detail '.repeat(8)}},
 {type:'response_item',payload:{type:'function_call_output',output:'ignored synthetic tool payload '.repeat(50)}},
 {type:'event_msg',payload:{type:'agent_message',message:`Answer ${i}: `+'completed project explanation '.repeat(12)}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:'turn-'+i}},
].map(line).join('');
try{
 await writeFile(sourcePath,line({type:'session_meta',payload:{id:sessionId}})+Array.from({length:120},(_,i)=>turn(i)).join(''));
 let cursor,baselineBytes=0,incrementalBytes=0,unchanged=0,baselineMessages=0,incrementalMessages=0;
 const latencies=[];
 for(let step=0;step<24;step++){
  if(step>0&&step%6===0)await appendFile(sourcePath,turn(120+step));
  const baseline=await readContext({sourcePath,sessionId});
  assert.equal(baseline.hasMore,false,'Baseline recent view should fit a page');
  const started=performance.now();
  const current=await readContext({sourcePath,sessionId,...(cursor?{cursor}:{})});
  latencies.push(performance.now()-started);
  assert.equal(current.hasMore,false,'Synthetic update should fit a page');
  cursor=current.cursor;
  if(current.status==='unchanged'){unchanged++;assert.deepEqual(current.messages,[]);}
  if(step%6===0)assert.ok(current.messages.some(message=>message.text.startsWith('Answer '+(step?120+step:119)+':')));
  baselineBytes+=Buffer.byteLength(JSON.stringify(baseline));incrementalBytes+=Buffer.byteLength(JSON.stringify(current));
  baselineMessages+=baseline.messages.length;incrementalMessages+=current.messages.length;
 }
 assert.ok(incrementalBytes<baselineBytes);
 latencies.sort((a,b)=>a-b);
 console.log(JSON.stringify({scenario:'24 synthetic side refreshes, 120 initial turns and 3 appended turns',baseline:'same bounded recent reader without a cursor on every refresh',comparison:'initial bounded snapshot, then explicit cursor deltas or unchanged receipts',modelRequests:0,sourceBytes:(await stat(sourcePath)).size,baselineResponseBytes:baselineBytes,incrementalResponseBytes:incrementalBytes,responseByteReductionPercent:Number((100*(1-incrementalBytes/baselineBytes)).toFixed(2)),baselineMessages,incrementalMessages,unchangedResponses:unchanged,medianReaderMs:Number(latencies[Math.floor(latencies.length/2)].toFixed(3)),maxReaderMs:Number(latencies.at(-1).toFixed(3)),limits:'Serialized tool response bytes only. This does not measure tokenizer counts, developer-policy overhead, cached-token pricing, billed savings, model tool choices or native turn latency.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
