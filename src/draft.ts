import { access, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { RuntimeState } from './codex.js';
import { inferProvider } from './codex.js';
import { parseComposerFooter, readSessionActivity, SessionMetadataError } from './session.js';
import { parseClaudePromptReady } from './claude.js';
import { paneExists, tmux } from './tmux.js';

export function selectionDraft(quote: string): string {
  return `\n\nQuoted passage from the main conversation:\n<shoulder-selection>\n${quote}\n</shoulder-selection>\n\nMy question: `;
}

export async function nativeInputIdentity(state: RuntimeState, pane: string): Promise<string> {
  const screen = await tmux(state, ['capture-pane', '-p', '-t', pane]);
  if (screen.replace(/\s+/g, ' ').includes('Scratchpad exited with an error. Press Enter to close this pane.')) throw new Error('Side process exited with an error; inspect its pane and press Enter to close it.');
  const provider = inferProvider(state.options);
  if (provider === 'codex') {
    const identity = parseComposerFooter(screen);
    if (identity === state.sidePreviousSessionId) throw new Error('Side chat is restarting. Wait for its fresh input before adding a passage.');
    return identity;
  }
  if (provider === 'claude' && parseClaudePromptReady(screen)) return state.sideSessionId ?? '';
  throw new Error('Side input is not ready. Finish the current answer, dismiss any dialog, and select again. Nothing was sent.');
}

export async function stageSelection(state: RuntimeState, pane: string, quote: string | undefined, waitForStartup: boolean): Promise<string> {
  const verifyActivity = async (identity: string) => {
    if (inferProvider(state.options) !== 'codex') return;
    try {
      await readSessionActivity(process.env.CODEX_HOME ?? join(homedir(), '.codex'), identity);
      delete state.sideUnsaved;
    } catch (error) {
      // A fresh native TUI has no saved file until its first submitted turn.
      // Allow only the known newly launched, prompt-free side and its exact
      // unchanged identity. Partial/active/unknown metadata still blocks input.
      if (!(state.sideUnsaved && (!state.sideSessionId || state.sideSessionId === identity) && error instanceof SessionMetadataError && error.code === 'NOT_FOUND')) throw error;
    }
  };
  const deadline = Date.now() + (waitForStartup ? 15000 : 0);
  let identity: string;
  for (;;) {
    try { await access(join(state.directory, 'closing')); throw new Error('Side pane is closing; draft insertion cancelled.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!await paneExists(state, pane)) throw new Error('Side conversation exited before its input was ready. Select again to reopen it.');
    try {
      identity = await nativeInputIdentity(state, pane);
      await verifyActivity(identity);
      break;
    }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Side process exited')) throw error;
      if (Date.now() >= deadline) throw new Error('Side input is not ready. Finish its answer or dismiss any dialog, then select again. Nothing was sent.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  // Opening a context-linked side needs a verified native composer, but no
  // synthetic quote, paste buffer, keystroke or submitted prompt.
  if (quote === undefined) {
    delete state.sidePreviousSessionId;
    return identity;
  }
  // tmux reads the private file directly. Neither quote nor draft becomes shell
  // source, and bracketed paste carries embedded newlines without pressing Enter.
  const name = `shoulder-${randomUUID()}`;
  const path = join(state.directory, `${name}.txt`);
  try {
    await writeFile(path, `\x1b[200~${selectionDraft(quote)}\x1b[201~`, { mode: 0o600, flag: 'wx' });
    await tmux(state, ['load-buffer', '-b', name, path]);
    try { await access(join(state.directory, 'closing')); throw new Error('Side pane is closing; draft insertion cancelled.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (await nativeInputIdentity(state, pane) !== identity) throw new Error('Side conversation changed while preparing the draft. Select again; nothing was sent.');
    await verifyActivity(identity);
    // Existing side scrollback/selection must not keep capturing the question.
    if ((await tmux(state, ['display-message', '-p', '-t', pane, '#{pane_in_mode}'])) === '1') await tmux(state, ['send-keys', '-X', '-t', pane, 'cancel']);
    // Wrap explicitly rather than relying on tmux's -p conditional: -p falls
    // back to unbracketed paste if a terminal hasn't enabled bracketed mode.
    await tmux(state, ['paste-buffer', '-d', '-r', '-b', name, '-t', pane]);
  } finally {
    await rm(path, { force: true });
    await tmux(state, ['delete-buffer', '-b', name]).catch(() => {});
  }
  delete state.sidePreviousSessionId;
  return identity;
}
