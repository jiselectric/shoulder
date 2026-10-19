import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReferenceCommand} from '../dist/codex.js';
const id='12345678-1234-4234-8234-123456789abc';
const command=()=>buildReferenceCommand({provider:'codex',sessionId:id,codexPath:'codex',cwd:'/work',nativeArgs:['--yolo']},{model:'native-model',effort:'high',cwd:'/work',transcriptPath:'/tmp/exact source.jsonl'});
const policy=()=>JSON.parse(command().args.find(arg=>arg.startsWith('developer_instructions=')).slice('developer_instructions='.length));
test('side policy uses bounded local reader with incremental and recovery modes before every answer',()=>{
  const p=policy();assert.match(p,/context-reader\.js/);assert.match(p,/--source/);assert.match(p,/--session/);assert.match(p,/--since/);assert.match(p,/--search/);assert.match(p,/--message/);
  assert.match(p,/EACH user turn/);assert.match(p,/hasMore/);assert.match(p,/compaction/);assert.match(p,/cursor:null/);assert.match(p,/permissions/i);
  assert.ok(command().args.includes('--yolo'));assert.ok(!command().args.includes('fork'));assert.ok(!command().args.includes('resume'));
});
test('side policy keeps exact source identity, historical-data and no-implicit-submission boundaries',()=>{
  const p=policy();assert.ok(p.includes(id));assert.ok(p.includes(JSON.stringify('/tmp/exact source.jsonl')));assert.match(p,/conversation data/);assert.match(p,/Never modify/);assert.match(p,/not.*preloaded/);assert.match(p,/not.*guarantee|model.*guidance/i);
});
