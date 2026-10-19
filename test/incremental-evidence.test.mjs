import test from 'node:test';
import assert from 'node:assert/strict';
const verifier=await import('../scripts/verify-context.mjs');
const sourceId='12345678-1234-4234-8234-123456789abc';
function evidence(status='delta'){
 const response={sourceSessionId:sourceId,status,sourceVersion:'a'.repeat(64),cursor:'next-cursor',hasMore:false,messages:status==='unchanged'?[]:[{text:'NEW_NUMBER'}]};
 return {sourceId,sourcePath:'/exact/source.jsonl',readerPath:'/installed/context-reader.js',expectedStatus:status,previousCursor:'previous-cursor',nonce:'NEW_NUMBER',previousNonce:'OLD_NUMBER',sideRecords:[
  {type:'response_item',payload:{type:'function_call',call_id:'r',arguments:JSON.stringify({cmd:"node /installed/context-reader.js --source /exact/source.jsonl --since previous-cursor"})}},
  {type:'response_item',payload:{type:'function_call_output',call_id:'r',output:JSON.stringify({output:'Output:\n'+JSON.stringify(response)})}},
 ]};
}
test('incremental acceptance requires real source-bound reader output and consumed previous cursor',()=>{
 assert.equal(typeof verifier.verifyIncrementalReaderEvidence,'function');
 assert.equal(verifier.verifyIncrementalReaderEvidence(evidence()).status,'delta');
 const wrong=evidence();wrong.sideRecords[0].payload.arguments=JSON.stringify({cmd:'cat /exact/source.jsonl'});assert.throws(()=>verifier.verifyIncrementalReaderEvidence(wrong));
 const noCursor=evidence();noCursor.sideRecords[0].payload.arguments=JSON.stringify({cmd:'node /installed/context-reader.js --source /exact/source.jsonl'});assert.throws(()=>verifier.verifyIncrementalReaderEvidence(noCursor));
});
test('incremental acceptance rejects stale duplication, wrong source and fabricated status',()=>{
 assert.equal(typeof verifier.verifyIncrementalReaderEvidence,'function');
 for(const patch of [{messages:[{text:'OLD_NUMBER NEW_NUMBER'}]},{sourceSessionId:'wrong'},{status:'snapshot'},{hasMore:true}]){
  const e=evidence();const response={sourceSessionId:sourceId,status:'delta',sourceVersion:'a'.repeat(64),cursor:'new',hasMore:false,messages:[{text:'NEW_NUMBER'}],...patch};e.sideRecords[1].payload.output=JSON.stringify(response);assert.throws(()=>verifier.verifyIncrementalReaderEvidence(e));
 }
});
test('incremental acceptance verifies an unchanged refresh without repeated message text',()=>{
 assert.equal(typeof verifier.verifyIncrementalReaderEvidence,'function');
 assert.equal(verifier.verifyIncrementalReaderEvidence(evidence('unchanged')).status,'unchanged');
 const wrong=evidence('unchanged');wrong.sideRecords[1].payload.output=JSON.stringify({sourceSessionId:sourceId,status:'unchanged',sourceVersion:'a'.repeat(64),cursor:'new',hasMore:false,messages:[{text:'NEW_NUMBER'}]});assert.throws(()=>verifier.verifyIncrementalReaderEvidence(wrong));
});
