import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {attachedFixture,tmux,until} from './runtime-fixture.mjs';
import {openScratchpad} from '../dist/runtime.js';

async function mouse(f, events) {
  for(const event of events) await tmux(f.outerState,'send-keys','-t','%0','-l',event);
}
async function sideDraft(f) {return readFile(join(f.logs,'fork-0.draft'),'utf8');}

test('typing through the attached terminal reaches a newly opened side draft',async t=>{
  const f=await attachedFixture(t);
  await until(async()=>(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane)).includes('NATIVE_READY'));
  await mouse(f,['\x1b[<0;1;1M','\x1b[<32;24;1M','\x1b[<0;24;1m']);
  await tmux(f.outerState,'send-keys','-t','%0','-l','e');
  await until(async()=>(await sideDraft(f)).includes('SELECT passage'),'selection draft appears');
  await tmux(f.outerState,'send-keys','-t','%0','-l',' MY_QUESTION');
  await until(async()=>(await sideDraft(f)).includes('MY_QUESTION'),'typed text reaches native side');
  assert.doesNotMatch(await tmux(f.state,'capture-pane','-p','-t',f.state.mainPane),/MY_QUESTION/);
});

for(const keys of ['emacs','vi']) test(`dragging and returning to typing works in both panes with ${keys} keys`,async t=>{
  const f=await attachedFixture(t);
  await tmux(f.state,'set-window-option','mode-keys',keys);
  await openScratchpad(f.state,'KEEP_INITIAL_QUOTE');
  let step=0;
  for(const pane of [f.state.mainPane,f.state.sidePane,f.state.mainPane,f.state.sidePane]) {
    const left=Number(await tmux(f.state,'display-message','-p','-t',pane,'#{pane_left}'));
    // Alternate pane focus and drag direction; use real client mouse events.
    await mouse(f,[`\x1b[<0;${left+22};1M`,`\x1b[<32;${left+2};2M`,`\x1b[<0;${left+2};2m`]);
    await until(async()=>(await tmux(f.state,'display-message','-p','-t',pane,'#{selection_present}'))==='1','backward multiline selection retained');
    await tmux(f.outerState,'send-keys','-t','%0','Escape');
    await until(async()=>(await tmux(f.state,'display-message','-p','-t',pane,'#{pane_in_mode}'))==='0','Escape returns to native input');
    const text=` TYPING_AFTER_DRAG_${++step}`;
    await tmux(f.outerState,'send-keys','-t','%0','-l',text);
    const kind=pane===f.state.mainPane?'main':'fork';
    await until(async()=>(await readFile(join(f.logs,`${kind}-0.draft`),'utf8')).includes(text),'new text reaches focused native pane');
  }
  await until(async()=>(await sideDraft(f)).includes('KEEP_INITIAL_QUOTE'),'original native draft retained');
});

test('clicking the side after a drag returns to native typing without losing the draft',async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'KEEP_QUOTE');
  const left=Number(await tmux(f.state,'display-message','-p','-t',f.state.sidePane,'#{pane_left}'));
  await mouse(f,[`\x1b[<0;${left+2};1M`,`\x1b[<32;${left+20};1M`,`\x1b[<0;${left+20};1m`]);
  await until(async()=>(await tmux(f.state,'display-message','-p','-t',f.state.sidePane,'#{pane_in_mode}'))==='1','side selection mode');
  await mouse(f,[`\x1b[<0;${left+3};30M`,`\x1b[<0;${left+3};30m`]);
  await tmux(f.outerState,'send-keys','-t','%0','-l',' CLICKED_AND_TYPED');
  await until(async()=>(await sideDraft(f)).includes('CLICKED_AND_TYPED'),'click returns side to native input',1000);
  assert.match(await sideDraft(f),/KEEP_QUOTE/);
  assert.equal(await tmux(f.state,'display-message','-p','-t',f.state.sidePane,'#{pane_in_mode}'),'0');
});

for(const direction of [64,65]) test(`scrolling the main pane cannot edit the side draft (wheel ${direction})`,async t=>{
  const f=await attachedFixture(t);
  await openScratchpad(f.state,'SCROLL_PRESERVED_QUOTE');
  await tmux(f.outerState,'send-keys','-t','%0','-l','UNSENT_SIDE_QUESTION');
  await until(async()=>(await sideDraft(f)).includes('UNSENT_SIDE_QUESTION'));
  const before=await sideDraft(f);
  const bindings=await tmux(f.state,'list-keys','-T','root');
  t.diagnostic(bindings.split('\n').filter(line=>/Wheel(Up|Down)Pane/.test(line)).join('\n'));
  const left=Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_left}'));
  const top=Number(await tmux(f.state,'display-message','-p','-t',f.state.mainPane,'#{pane_top}'));
  for(let i=0;i<5;i++) await mouse(f,[`\x1b[<${direction};${left+5};${top+2}M`]);
  // A native round trip makes any wrongly routed wheel bytes observable.
  await tmux(f.state,'send-keys','-t',f.state.sidePane,'-l','AFTER_SCROLL');
  await until(async()=>(await sideDraft(f)).includes('AFTER_SCROLL'));
  assert.equal(await sideDraft(f),before+'AFTER_SCROLL','main scroll must not inject wheel bytes into side input');
});

for(const banner of [false,true]) for(const event of ['scroll-up','scroll-down']) test(`${event} focuses the pane under the pointer and preserves the other pane's draft (banner ${banner})`,async t=>{
  const f=await attachedFixture(t,async f=>{f.options.banner=banner;});
  await openScratchpad(f.state,'POINTER_SIDE_DRAFT');
  const wheel=event==='scroll-up'?64:65;
  for(const pane of [f.state.mainPane,f.state.sidePane]) {
    const inactive=pane===f.state.mainPane?'fork':'main';
    const inactivePath=join(f.logs,`${inactive}-0.draft`);
    const inactiveBefore=await readFile(inactivePath,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    const left=Number(await tmux(f.state,'display-message','-p','-t',pane,'#{pane_left}'));
    const status=await tmux(f.state,'show-options','-gv','status');
    const offset=await tmux(f.state,'show-options','-gv','status-position')==='top'?(status==='on'?1:Number(status)):0;
    const top=Number(await tmux(f.state,'display-message','-p','-t',pane,'#{pane_top}'))+offset;
    await mouse(f,[`\x1b[<${wheel};${left+5};${top+2}M`]);
    await until(async()=>await tmux(f.state,'display-message','-p','#{pane_id}')===pane,`${event} activates pointer pane`);
    // Focus is synchronous in tmux; the PTY consumer processes the forwarded
    // wheel later. Observe that transport before testing the reverse direction.
    const targetPath=join(f.logs,`${pane===f.state.mainPane?'main':'fork'}-0.draft`);
    await until(async()=>(await readFile(targetPath,'utf8')).includes(`\x1b[<${wheel};5;2M`),`${event} reaches only its native target`);
    assert.equal(await readFile(inactivePath,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}),inactiveBefore);
  }
  // A motionless pointer must not undo an intentional keyboard switch.
  await tmux(f.outerState,'send-keys','-t','%0','C-\\');
  await until(async()=>await tmux(f.state,'display-message','-p','#{pane_id}')===f.state.mainPane,'keyboard switch remains usable');
});
