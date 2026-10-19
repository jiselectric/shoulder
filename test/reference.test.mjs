import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,records,tmux,until} from './runtime-fixture.mjs';
import {openScratchpad,clearScratchpad,loadState,saveState} from '../dist/runtime.js';
import * as provider from '../dist/codex.js';
import {stageSelection} from '../dist/draft.js';
const id='12345678-1234-4234-8234-123456789abc';

test('clean side launch references exact source without replaying its history or sending a prompt',()=>{
  assert.equal(typeof provider.buildReferenceCommand,'function');
  const command=provider.buildReferenceCommand({provider:'codex',sessionId:id,codexPath:'codex',cwd:'/work',nativeArgs:['--yolo','--profile','work','original main question']},
    {model:'native-model',effort:'high',cwd:'/work',transcriptPath:'/home/user/codex sessions/exact-source.jsonl'});
  assert.equal(command.args.includes('fork'),false);
  assert.equal(command.args.includes('resume'),false);
  assert.equal(command.args.includes('original main question'),false);
  assert.ok(command.args.includes('--yolo'));
  assert.ok(command.args.includes('native-model'));
  const instruction=command.args.find(arg=>arg.startsWith('developer_instructions='));
  assert.ok(instruction.includes(id));
  assert.ok(instruction.includes('exact-source.jsonl'));
  assert.ok(!instruction.includes('model_instructions_file'));
});

test('opening a side uses a fresh native session with an exact source reference',async t=>{
  const f=await fixture(t);
  await openScratchpad(f.state,'SELECTED_QUOTE_ONLY');
  const [side]=await records(f.logs,'fork');
  assert.equal(side.args.includes('fork'),false);
  assert.equal(side.args.includes('resume'),false);
  const instructions=side.args.find(arg=>arg.startsWith('developer_instructions='));
  assert.ok(instructions?.includes(id));
  assert.ok(instructions?.includes(f.file));
});

test('recovering an initially unbound side records its UUID and survives a later native clear',async t=>{
  const f=await fixture(t);
  await openScratchpad(f.state,'INITIAL_QUOTE');
  const state=await loadState(f.state.directory),original=state.sideSessionId;
  // Persisted state after a native startup dialog: pane/parent known, input
  // identity not yet observed. Recover through the real native staging path.
  delete state.sideSessionId;
  await saveState(state);
  await openScratchpad(f.state,'RECOVERED_QUOTE');
  assert.equal((await loadState(f.state.directory)).sideSessionId,original);
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'C-u','/clear','Enter');
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.sidePane)).includes('CLEARED'));
  await openScratchpad(f.state,'AFTER_RECOVERY_CLEAR');
  assert.equal((await records(f.logs,'fork')).length,2);
});

test('a resetting side rejects its previous UUID while the old screen is still visible',async t=>{
  const f=await fixture(t);
  await openScratchpad(f.state,'OLD_CONVERSATION');
  const state=await loadState(f.state.directory);
  state.sidePreviousSessionId=state.sideSessionId;
  delete state.sideSessionId;
  state.sideUnsaved=true;
  await assert.rejects(stageSelection(state,state.sidePane,'DO_NOT_PASTE_INTO_OLD_FRAME',false),/ready|restart|reset/i);
});

test('repeated Clear preserves the stale-screen guard before a new UUID is visible',async t=>{
  const f=await fixture(t);
  await openScratchpad(f.state,'OLD_FRAME');
  const state=await loadState(f.state.directory),previous=state.sideSessionId;
  state.sidePreviousSessionId=previous;
  delete state.sideSessionId;
  await saveState(state);
  await clearScratchpad(f.state);
  assert.equal((await loadState(f.state.directory)).sidePreviousSessionId,previous);
});
