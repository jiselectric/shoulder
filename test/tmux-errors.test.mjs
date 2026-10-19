import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmux } from '../dist/tmux.js';

async function fakeTmux(t, body) {
  const directory=await mkdtemp('/tmp/shoulder-tmux-errors-');
  const previousPath=process.env.PATH;
  t.after(async()=>{
    if(previousPath===undefined) delete process.env.PATH; else process.env.PATH=previousPath;
    await rm(directory,{recursive:true,force:true});
  });
  if(body!==undefined) {
    const executable=join(directory,'tmux');
    await writeFile(executable,`#!/bin/sh\n${body}\n`,{mode:0o700});
    await chmod(executable,0o700);
  }
  process.env.PATH=directory;
  return {socket:join(directory,'unused.sock')};
}

test('tmux preserves a zero-exit stderr diagnostic without exposing captured stdout',async t=>{
  const state=await fakeTmux(t,'printf "%s\\n" "PRIVATE_TRANSCRIPT_SENTINEL"\nprintf "%s\\n" "private socket permission denied" >&2\nexit 0');
  await assert.rejects(tmux(state,['list-panes']),error=>{
    assert.match(error.message,/private socket permission denied/);
    assert.doesNotMatch(error.message,/PRIVATE_TRANSCRIPT_SENTINEL/);
    return true;
  });
});

test('tmux nonzero failures preserve stderr without exposing stdout or argv',async t=>{
  const state=await fakeTmux(t,'printf "%s\\n" "PRIVATE_TRANSCRIPT_SENTINEL"\nprintf "%s\\n" "invalid pane target" >&2\nexit 1');
  await assert.rejects(tmux(state,['display-message','PRIVATE_ARG_SENTINEL']),error=>{
    assert.match(error.message,/invalid pane target/);
    assert.doesNotMatch(error.message,/PRIVATE_TRANSCRIPT_SENTINEL|PRIVATE_ARG_SENTINEL/);
    return true;
  });
});

test('missing tmux keeps its installation hint',async t=>{
  const state=await fakeTmux(t);
  await assert.rejects(tmux(state,['list-panes']),/install tmux first/);
});
