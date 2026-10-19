import test from 'node:test';
import assert from 'node:assert/strict';
const verifier=await import('../scripts/verify-context.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const id='12345678-1234-4234-8234-123456789abc',nonce='verification-code-7f994c2da0';
const message=(role,text)=>({type:'response_item',payload:{type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]}});
function evidence(){return {nonce,sourceId:id,sourcePath:'/exact/source.jsonl',sideArgs:['--config',`developer_instructions=source ${id} /exact/source.jsonl`],quote:'Stored',question:'What verification code is in the source?',parentUnchanged:true,sideRecords:[message('developer',`Shoulder source session: ${id}\nExact local transcript: ${JSON.stringify('/exact/source.jsonl')}`),message('user','Stored\nWhat verification code is in the source?'),{type:'response_item',payload:{type:'function_call',call_id:'read1',name:'exec',arguments:'{"cmd":"cat /exact/source.jsonl"}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'read1',output:`User asked to remember ${nonce}`}},message('assistant',nonce)]};}

test('context verification requires exact source reference, an actual source read and exact canary answer',()=>{
  assert.equal(typeof verifier.verifyContextEvidence,'function');
  assert.deepEqual(verifier.verifyContextEvidence(evidence()),{referenceVerified:true,nonceAbsentFromInput:true,sourceReadVerified:true,nonceMatched:true,parentUnchanged:true});
});
test('context verification rejects leaked canaries and a wrong source read',()=>{
  assert.equal(typeof verifier.verifyContextEvidence,'function');
  const leaked=evidence();leaked.sideRecords.splice(1,0,message('user',nonce));
  assert.throws(()=>verifier.verifyContextEvidence(leaked),/leak|input/i);
  const wrong=evidence();wrong.sideRecords[2].payload.arguments='{"cmd":"cat /different/source.jsonl"}';
  assert.throws(()=>verifier.verifyContextEvidence(wrong),/source|read/i);
});
test('context verification rejects wrong answers and parent history changes',()=>{
  assert.equal(typeof verifier.verifyContextEvidence,'function');
  const wrong=evidence();wrong.sideRecords.at(-1).payload.content[0].text='a guess';
  assert.throws(()=>verifier.verifyContextEvidence(wrong),/canary|answer/i);
  const changed=evidence();changed.parentUnchanged=false;
  assert.throws(()=>verifier.verifyContextEvidence(changed),/parent/i);
});


test('context verification rejects source path prefix and suffix decoys',()=>{
  for(const path of ['/exact/source.jsonl.backup','/prefix/exact/source.jsonl','/exact/source.jsonl/child','/exact/source.jsonl:backup','/exact/source.jsonl,backup']) {
    const wrong=evidence();
    wrong.sideRecords[0]=message('developer',`Shoulder source session: ${id}\nExact local transcript: ${JSON.stringify(path)}`);
    assert.throws(()=>verifier.verifyContextEvidence(wrong),/reference|source/i);
    const wrongRead=evidence();
    wrongRead.sideRecords[2].payload.arguments=JSON.stringify({cmd:`cat ${path}`});
    assert.throws(()=>verifier.verifyContextEvidence(wrongRead),/source|read/i);
  }
});
test('context verification rejects UUIDs embedded in decoy source identifiers',()=>{
  for(const reference of [`prefix-${id}`,`${id}-suffix`]) {
    const wrong=evidence();
    wrong.sideRecords[0]=message('developer',`Shoulder source session: ${reference}\nExact local transcript: "/exact/source.jsonl"`);
    assert.throws(()=>verifier.verifyContextEvidence(wrong),/reference|source/i);
  }
});
test('context verification matches decoded native tool argument forms and quoted paths',()=>{
  for(const call of [
    {type:'function_call',call_id:'read1',name:'exec_command',arguments:JSON.stringify({cmd:'cat "/exact/source.jsonl"'})},
    {type:'function_call',call_id:'read1',name:'read_file',arguments:{file_path:'/exact/source.jsonl'}},
    {type:'custom_tool_call',call_id:'read1',name:'exec',input:`const result = await tools.exec_command({cmd: "cat '/exact/source.jsonl'"});`},
  ]) {
    const valid=evidence();valid.sideRecords[2].payload=call;
    assert.equal(verifier.verifyContextEvidence(valid).sourceReadVerified,true);
  }
  const spaces=evidence();spaces.sourcePath='/exact/source with spaces.jsonl';
  spaces.sideRecords[0]=message('developer',`Shoulder source session: ${id}\nExact local transcript: ${JSON.stringify(spaces.sourcePath)}`);
  spaces.sideRecords[2].payload.arguments=JSON.stringify({cmd:`sed -n '1,40p' '${spaces.sourcePath}'`});
  assert.equal(verifier.verifyContextEvidence(spaces).sourceReadVerified,true);
});
test('context verification rejects path mentions outside tool arguments and malformed argument JSON',()=>{
  const wrong=evidence();wrong.sideRecords[2].payload.arguments='{"cmd":"cat /different/source.jsonl"}';
  wrong.sideRecords[2].payload.description='/exact/source.jsonl';
  assert.throws(()=>verifier.verifyContextEvidence(wrong),/source|read/i);
  const malformed=evidence();malformed.sideRecords[2].payload.arguments='{"cmd":"cat /exact/source.jsonl"';
  assert.throws(()=>verifier.verifyContextEvidence(malformed),/source|read/i);
});

const lifecycle=(type,turn)=>({type:'event_msg',payload:{type,turn_id:turn}});
const firstQuestion="What is the random number you've generated? Reply with the number only.";
const nextQuestion="What is the random number you've generated now? Reply with the number only.";
const sideId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function evolvingEvidence() {
  const first=evidence();first.nonce='49683489031594058243403996525';
  first.sideRecords[1]=message('user',`Ready\n${firstQuestion}`);
  first.sideRecords[3].payload.output=`Generated ${first.nonce}`;
  first.sideRecords[4]=message('assistant',first.nonce);
  const one=[{type:'session_meta',payload:{id:sideId}},lifecycle('task_started','first'),...first.sideRecords,lifecycle('task_complete','first')];
  const secondNonce='71770707841713431072712772462';
  const two=[...one,lifecycle('task_started','second'),message('user',nextQuestion),{type:'response_item',payload:{type:'function_call',call_id:'read2',name:'exec',arguments:'{"cmd":"cat /exact/source.jsonl"}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'read2',output:`Generated ${secondNonce}`}},message('assistant',secondNonce),lifecycle('task_complete','second')];
  return {sourceId:id,sourcePath:first.sourcePath,sideArgs:first.sideArgs,sideId,initialSourceDigest:'0'.repeat(64),turns:[
    {turnId:'first',sideId,nonce:first.nonce,quote:'Ready',question:firstQuestion,sideRecords:one,sourceBeforeDigest:'1'.repeat(64),sourceAfterDigest:'1'.repeat(64)},
    {turnId:'second',sideId,nonce:secondNonce,quote:'',question:nextQuestion,sideRecords:two,sourceBeforeDigest:'2'.repeat(64),sourceAfterDigest:'2'.repeat(64)},
  ]};
}

test('a later side turn cannot reuse an earlier source read as fresh evidence',()=>{
  const e=evidence();
  e.sideRecords=[lifecycle('task_started','old'),...e.sideRecords,lifecycle('task_complete','old'),lifecycle('task_started','new'),message('user',nextQuestion),message('assistant',nonce),lifecycle('task_complete','new')];
  e.turnId='new';
  assert.throws(()=>verifier.verifyContextEvidence(e),/fresh|turn|output|canary/i);
});

test('fresh output cannot borrow its matching tool call from an earlier turn',()=>{
  const e=evidence();
  const oldCall=e.sideRecords[2],freshOutput=e.sideRecords[3];
  e.sideRecords=[e.sideRecords[0],lifecycle('task_started','old'),oldCall,lifecycle('task_complete','old'),lifecycle('task_started','new'),message('user',nextQuestion),freshOutput,message('assistant',nonce),lifecycle('task_complete','new')];
  e.turnId='new';
  assert.throws(()=>verifier.verifyContextEvidence(e),/source|read|turn/i);
});

test('evolving context requires two distinct fresh reads and values on the same saved side',()=>{
  assert.equal(typeof verifier.verifyEvolvingContextEvidence,'function');
  const checks=verifier.verifyEvolvingContextEvidence(evolvingEvidence());
  assert.equal(checks.sameSideVerified,true);
  assert.equal(checks.sourceAdvancedBeforeEachTurn,true);
  assert.equal(checks.turns.length,2);
  assert.ok(checks.turns.every(turn=>turn.sourceReadVerified&&turn.nonceMatched&&turn.parentUnchanged));
});

test('evolving context rejects the reproduced stale follow-up with no new source read',()=>{
  assert.equal(typeof verifier.verifyEvolvingContextEvidence,'function');
  const e=evolvingEvidence(),second=e.turns[1];
  second.sideRecords=second.sideRecords.filter(row=>row.type!=='response_item'||!['function_call','function_call_output'].includes(row.payload.type)||row.payload.call_id!=='read2');
  second.sideRecords.findLast(row=>row.type==='response_item'&&row.payload.role==='assistant').payload.content[0].text=e.turns[0].nonce;
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(e),/fresh|turn|output|canary/i);
});

test('evolving context rejects stale answers despite a fresh read and rejects unchanged source snapshots',()=>{
  assert.equal(typeof verifier.verifyEvolvingContextEvidence,'function');
  const stale=evolvingEvidence();
  stale.turns[1].sideRecords.findLast(row=>row.type==='response_item'&&row.payload.role==='assistant').payload.content[0].text=stale.turns[0].nonce;
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(stale),/answer|canary/i);
  const unchanged=evolvingEvidence();unchanged.turns[1].sourceBeforeDigest=unchanged.turns[0].sourceBeforeDigest;unchanged.turns[1].sourceAfterDigest=unchanged.turns[1].sourceBeforeDigest;
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(unchanged),/source|update|advance/i);
});

test('evolving context rejects side replacement, hinted questions, leaked values and parent mutation',()=>{
  assert.equal(typeof verifier.verifyEvolvingContextEvidence,'function');
  const replaced=evolvingEvidence();replaced.turns[1].sideId=id;
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(replaced),/side|identity/i);
  const hinted=evolvingEvidence();hinted.turns[1].question='Read the source transcript and answer.';
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(hinted),/hint|question/i);
  const leaked=evolvingEvidence();leaked.turns[1].sideRecords.splice(1,0,message('developer',leaked.turns[1].nonce));
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(leaked),/leak|input/i);
  const changed=evolvingEvidence();changed.turns[1].sourceAfterDigest='3'.repeat(64);
  assert.throws(()=>verifier.verifyEvolvingContextEvidence(changed),/parent|changed/i);
});
