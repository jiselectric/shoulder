import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildReferenceCommand, buildMainCommand, inferProvider, nativeSessionId, providerDoctor, type LaunchOptions, type RuntimeState } from './codex.js';
import { readSessionSettings, parseComposerFooter, SessionMetadataError } from './session.js';
import { sanitizeSelection } from './selection.js';
import { paneExists, shellQuote, tmux, tmuxBatch } from './tmux.js';
import { nativeInputIdentity, stageSelection } from './draft.js';
import { readClaudeSessionSettings } from './claude.js';
import { bannerToggleCommand, loadPresentation, presentationCommands, useColor, type Presentation } from './presentation.js';

const helper = fileURLToPath(new URL('./helper.js', import.meta.url));
async function closingRequested(directory: string): Promise<boolean> {
  try { await access(join(directory, 'closing')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export type MainOutcome = { exitCode: number; spawnError?: string };
export async function saveState(state: RuntimeState): Promise<void> {
  const temporary = join(state.directory, `state-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(state.directory, 'state.json'));
}
export async function loadState(directory: string): Promise<RuntimeState> {
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as RuntimeState;
  if (state.version !== 1 || state.directory !== directory || state.socket !== join(directory, 'tmux.sock') || state.session !== 'shoulder') throw new Error('Invalid runtime identity.');
  return state;
}

export async function createRuntime(options: LaunchOptions, mainOutcomeFile?: string, presentation: Presentation = { color: useColor(), version: '' }): Promise<RuntimeState> {
  if (inferProvider(options) === 'claude' && !options.sessionId && !nativeSessionId(options.nativeArgs)) {
    const candidate = { ...options, freshSessionId: randomUUID() };
    if (nativeSessionId(buildMainCommand(candidate).args) === candidate.freshSessionId) options = candidate;
  }
  buildMainCommand(options);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Shoulder requires macOS or Linux.');
  // /tmp deliberately avoids macOS's long per-user tmpdir exceeding AF_UNIX limits.
  const directory = await mkdtemp('/tmp/shoulder-');
  await chmod(directory, 0o700);
  const state: RuntimeState = { version: 1, directory, socket: join(directory, 'tmux.sock'), session: 'shoulder', mainPane: '', options, ...(mainOutcomeFile ? { mainOutcomeFile } : {}) };
  try {
    await saveState(state);
    // run-shell and copy-pipe expand tmux formats after shell quoting. Keep
    // installation paths inside a private script that the shell reads directly.
    const dispatch = join(directory, 'dispatch.sh');
    await writeFile(dispatch, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { mode: 0o700, flag: 'wx' });
    state.mainPane = await tmux(state, ['-f', '/dev/null', 'new-session', '-d', '-s', state.session,
      '-n', 'Shoulder', '-x', String(process.stdout.columns || 120), '-y', String(process.stdout.rows || 40), '-P', '-F', '#{pane_id}', '-c', options.cwd,
      process.execPath, helper, 'main', directory]);
    if (!/^%\d+$/.test(state.mainPane) || !await paneExists(state, state.mainPane)) throw new Error('tmux did not create the managed main pane; check local socket permissions.');
    const setup: string[][] = [];
    // The native process starts after ready, so these labels are in place
    // before it can emit OSC titles or request a window rename.
    setup.push(['set-window-option', '-g', 'automatic-rename', 'off']);
    setup.push(['set-window-option', '-g', 'allow-rename', 'off']);
    setup.push(['set-window-option', '-g', 'allow-set-title', 'off']);
    setup.push(['select-pane', '-t', state.mainPane, '-T', 'Main']);
    setup.push(['set-window-option', '-g', 'pane-border-status', 'bottom']);
    setup.push(['set-window-option', '-g', 'pane-border-format', ' #{pane_title} ']);
    // Directory names are data, never tmux formats or terminal control input.
    const project = Array.from(basename(options.cwd).replace(/[\x00-\x1f\x7f-\x9f]/g, '')).slice(0, 48).join('') || 'project';
    // Option substitution does not recursively interpret its value as a format.
    setup.push(['set-option', '-g', '@shoulder_project', project]);
    setup.push(['set-option', '-g', 'set-titles-string', 'Shoulder · #{@shoulder_project}']);
    setup.push(['set-option', '-g', 'set-titles', 'on']);
    setup.push(['set-option', '-g', 'status-right', 'Finish a main answer']);
    setup.push(['set-option', '-g', 'status-right-length', '100']);
    const directKeys = options.directKeys !== false && inferProvider(options) === 'codex';
    setup.push(...presentationCommands(presentation, Boolean(options.banner), process.stdout.columns || 120, process.stdout.rows || 40, inferProvider(options), directKeys));
    setup.push(['set-option', '-g', 'mouse', 'on']);
    // Newer tmux versions can focus on hover. Keep the 3.6a floor: those
    // clients focus on the first scroll event through the bindings below.
    if (await tmux(state, ['show-options', '-gqv', 'focus-follows-mouse'])) setup.push(['set-option', '-g', 'focus-follows-mouse', 'on']);
    setup.push(['set-option', '-g', 'set-clipboard', 'off']);
    setup.push(['set-option', '-g', 'display-time', '6000']);
    // Native apps can request their own mouse events. This managed gesture
    // deliberately belongs to Shoulder, so a drag always starts a selection.
    setup.push(['bind-key', '-T', 'root', 'MouseDrag1Pane', 'copy-mode', '-M']);
    // Scrolling also establishes focus, including terminals that send wheel
    // reports but no hover motion. Never turn a wheel into input-history keys.
    for (const [event, fallback] of [['WheelUpPane', 'copy-mode -e -t ='], ['WheelDownPane', '']] as const) {
      setup.push(['bind-key', '-T', 'root', event, `select-pane -t = ; if-shell -F -t = '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M'${fallback ? ` '${fallback}'` : ''}`]);
    }
    setup.push(['set-window-option', '-g', 'copy-mode-position-format', 'Selection | e: side chat | Esc/click: type']);
    const control = [dispatch, 'control', directory].map(shellQuote).join(' ');
    if (directKeys) {
      setup.push(['bind-key', '-T', 'root', 'C-\\', 'select-pane', '-t', ':.+']);
      setup.push(['bind-key', '-T', 'root', 'C-q', 'run-shell', `${control} toggle`]);
    }
    // Lowercase actions need no Shift; keep uppercase aliases for existing users.
    for (const key of ['c', 'C']) setup.push(['bind-key', '-T', 'prefix', key, 'run-shell', `${control} clear`]);
    for (const key of ['x', 'X']) setup.push(['bind-key', '-T', 'prefix', key, 'run-shell', `${control} toggle`]);
    setup.push(['bind-key', '-T', 'prefix', 'b', 'if-shell', '-F', '1', bannerToggleCommand()]);
    for (const event of ['MouseDown1Status', 'MouseDown1StatusLeft', 'SecondClick1Status', 'SecondClick1StatusLeft', 'DoubleClick1Status', 'DoubleClick1StatusLeft', 'TripleClick1Status', 'TripleClick1StatusLeft']) {
      setup.push(['bind-key', '-T', 'root', event, 'if-shell', '-F', '#{==:#{mouse_status_range},side-close}', `run-shell ${shellQuote(`${control} toggle`)}`, `if-shell -F '#{==:#{mouse_status_range},side-clear}' ${shellQuote(`run-shell ${shellQuote(`${control} clear`)}`)} ${shellQuote(`if-shell -F '#{==:#{mouse_status_range},banner-toggle}' ${shellQuote(bannerToggleCommand())} 'select-window -t ='`)}`]);
    }
    const pipe = [dispatch, 'selection', directory].map(shellQuote).join(' ');
    // Forward only: retain no extra quote in the clipboard or paste buffers,
    // including when the downstream action rejects the selection.
    const action = `send-keys -X copy-pipe-and-cancel -CP ${shellQuote(pipe)}`;
    // Prefix dispatch can leave copy mode, so e in either copy table is the
    // primary shortcut. Both actions require an active selection, never a buffer.
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      // A quick click after a drag is SecondClick, before DoubleClick is
      // decided. Handle all click shapes so none trap typing in copy mode.
      for (const event of ['MouseDown1Pane', 'SecondClick1Pane', 'DoubleClick1Pane', 'TripleClick1Pane']) {
        setup.push(['bind-key', '-T', table, event, 'send-keys -X -t = cancel ; select-pane -t =']);
      }
      setup.push(['bind-key', '-T', table, 'Escape', 'send-keys', '-X', 'cancel']);
      setup.push(['bind-key', '-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'stop-selection']);
      setup.push(['bind-key', '-T', table, 'e', 'if-shell', '-F', '#{selection_present}', action, 'display-message "Select a passage first; no clipboard buffer is used."']);
    }
    setup.push(['bind-key', '-T', 'prefix', 'e', 'if-shell', '-F', '#{selection_present}', action, 'display-message "Enter copy mode, select text, then press e."']);
    // One client submits an ordered command queue. tmux stops on the first
    // setup error; ready remains absent and the catch below tears down the server.
    await tmuxBatch(state, setup);
    await saveState(state);
    await writeFile(join(directory, 'ready'), '', { mode: 0o600 });
    return state;
  } catch (error) { await cleanup(state); throw error; }
}

export async function openScratchpad(state: RuntimeState, selection?: string): Promise<void> {
  const quote = selection === undefined ? undefined : sanitizeSelection(Buffer.from(selection));
  const lock = join(state.directory, 'opening.lock');
  const lockDeadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() >= lockDeadline) throw new Error('Another side action is still finishing. Retry the selection.');
    if (await closingRequested(state.directory)) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }
    if (await closingRequested(state.directory)) { await rm(lock, { recursive: true, force: true }); continue; }
    break;
  }
  let request: string | undefined;
  let newPane: string | undefined;
  let committed = false;
  try {
    const current = await loadState(state.directory);
    const size = (await tmux(current, ['display-message', '-p', '-t', current.mainPane, '#{window_width} #{window_height}'])).split(' ').map(Number);
    if (!(size[0]! >= 100 && size[1]! >= 20)) throw new Error('Scratchpad needs at least 100 columns and 20 rows. Enlarge the terminal first.');
    const provider = inferProvider(current.options);
    if (provider === 'generic') throw new Error('This executable has no conversation-context adapter yet. Its main terminal remains available.');
    if (provider === 'claude') throw new Error('Claude side drafts are not yet supported. Continue in the main terminal, or use shoulder codex for side chats.');
    // Action-only capture of the current pane, without history or polling.
    // Keep fresh launch options unbound so native /new is resolved each time.
    await tmux(current, ['set-option', '-g', 'status-right', 'Finish a main answer']);
    const sessionId = parseComposerFooter(await tmux(current, ['capture-pane', '-p', '-t', current.mainPane]));
    let settings;
    if (!sessionId) throw new Error('Cannot identify this native session exactly. Use an exact --session UUID for context forking.');
    try { settings = await readSessionSettings(process.env.CODEX_HOME ?? join(homedir(), '.codex'), sessionId); }
    catch (error) {
      if (current.options.sessionId === undefined && error instanceof SessionMetadataError && error.code === 'NOT_FOUND') {
        throw new Error('Finish a main answer first, then open the side chat.');
      }
      if (!(error instanceof SessionMetadataError && error.code === 'MISSING_SETTINGS' && current.options.sideModel && current.options.sideEffort && error.cwd)) throw error;
      settings = { model: current.options.sideModel, effort: current.options.sideEffort, cwd: error.cwd, transcriptPath: error.transcriptPath };
    }
    await tmux(current, ['set-option', '-g', 'status-right', 'Source linked · read on demand']);
    let replacementPane: string | undefined;
    if (current.sidePane && await paneExists(current, current.sidePane)) {
      const identity = current.sideSessionId ? await nativeInputIdentity(current, current.sidePane) : undefined;
      // Native /clear creates another side identity. Re-fork the source so the
      // next question receives main context instead of an empty native chat.
      if ((!current.sideSessionId || identity === current.sideSessionId) && current.sideParentId === sessionId) {
        const wasHidden = current.sideHidden;
        await restorePane(current);
        current.sideSessionId = await stageSelection(current, current.sidePane, quote, wasHidden || !current.sideSessionId);
        await saveState(current);
        await tmux(current, ['select-pane', '-t', current.sidePane]);
        state.sidePane = current.sidePane;
        return;
      }
      replacementPane = current.sidePane;
    }
    const command = buildReferenceCommand({ ...current.options, sessionId }, settings);
    if (replacementPane) {
      try {
        if (!(await stat(command.cwd)).isDirectory()) throw new Error('Not a directory.');
      } catch {
        throw new Error('The saved side working directory is unavailable. The existing side chat was preserved.');
      }
    }
    const name = `request-${randomUUID()}.json`;
    request = join(current.directory, name);
    await writeFile(request, JSON.stringify(command), { mode: 0o600, flag: 'wx' });
    // Keep the previous native process and its draft until the replacement
    // input is ready. Parking makes room for the usual two-pane dimensions.
    const previous = replacementPane ? structuredClone(current) : undefined;
    let previousWidth: number | undefined;
    let previousParked = false;
    try {
      if (replacementPane && !current.sideHidden) {
        previousWidth = Number(await tmux(current, ['display-message', '-p', '-t', replacementPane, '#{pane_width}']));
        await tmux(current, ['break-pane', '-d', '-s', replacementPane, '-n', 'shoulder-replacing']);
        previousParked = true;
      }
      newPane = await tmux(current, ['split-window', '-h', '-l', '40%', '-t', current.mainPane, '-c', command.cwd, '-P', '-F', '#{pane_id}', process.execPath, helper, 'side', current.directory, name]);
      if (!/^%\d+$/.test(newPane) || !await paneExists(current, newPane)) throw new Error('tmux did not create the scratchpad pane.');
      await tmux(current, ['select-pane', '-t', newPane, '-T', 'Side chat']);
      current.sidePane = newPane;
      delete current.sideHidden;
      delete current.sideWidth;
      await tmux(current, ['set-option', '-g', '@side_hidden', '0']);
      await tmux(current, ['set-option', '-g', '@side_exists', '1']);
      current.sideParentId = sessionId;
      current.sideSettings = settings;
      delete current.sideSessionId;
      delete current.sidePreviousSessionId;
      current.sideUnsaved = true;
      await saveState(current);
      state.sidePane = newPane;
      committed = true;
      current.sideSessionId = await stageSelection(current, newPane, quote, true);
      await saveState(current);
      if (replacementPane && await paneExists(current, replacementPane)) await tmux(current, ['kill-pane', '-t', replacementPane]);
    } catch (error) {
      if (previous) {
        if (error instanceof Error && error.message.startsWith('Side process exited')) {
          error = new Error('Replacement side process exited with an error. Your previous side chat and draft were preserved.');
        }
        if (newPane) await tmux(current, ['kill-pane', '-t', newPane]).catch(() => {});
        newPane = undefined;
        committed = false;
        // Controls wait for opening.lock. A queued Close therefore sees the
        // restored original, including when its marker cancelled this startup.
        if (previousParked) {
          const restoring = { ...previous, sideHidden: true, sideWidth: previousWidth };
          try { await restorePane(restoring); }
          catch {
            // A concurrent resize can prevent joining. Keep the old process
            // recoverable and truthfully mark it hidden instead of losing it.
            await saveState(restoring);
            await tmux(restoring, ['set-option', '-g', '@side_hidden', '1']);
            state.sidePane = restoring.sidePane;
            throw error;
          }
        }
        await saveState(previous);
        await tmux(previous, ['set-option', '-g', '@side_hidden', previous.sideHidden ? '1' : '0']);
        state.sidePane = previous.sidePane;
      }
      throw error;
    }
  } finally {
    // The pane reads and unlinks its request before launching native Codex.
    if (!committed) {
      if (newPane) await tmux(state, ['kill-pane', '-t', newPane]).catch(() => {});
      if (request) await rm(request, { force: true });
    }
    await rm(lock, { recursive: true, force: true });
  }
}

export async function closeScratchpad(state: RuntimeState): Promise<void> {
  await resetScratchpad(state, 'close');
}

export async function clearScratchpad(state: RuntimeState): Promise<void> {
  await resetScratchpad(state, 'clear');
}

export async function toggleScratchpad(state: RuntimeState): Promise<void> {
  const current = await loadState(state.directory);
  if (current.sidePane && await paneExists(current, current.sidePane)) await resetScratchpad(state, 'toggle');
  else await openScratchpad(state);
}

// Keep the native process/PTY alive in a detached window of this private
// runtime. Joining it back preserves history, drafts and running turns exactly.
async function restorePane(current: RuntimeState): Promise<void> {
  if (current.sideHidden && current.sidePane) {
    const width = Number(await tmux(current, ['display-message', '-p', '-t', current.mainPane, '#{window_width}']));
    if (width < 100) throw new Error('Scratchpad needs at least 100 columns. Enlarge the terminal first.');
    await tmux(current, ['join-pane', '-h', '-s', current.sidePane, '-t', current.mainPane, '-l', String(Math.max(20, Math.min(current.sideWidth ?? Math.floor(width * 0.4), width - 40)))]);
    delete current.sideHidden;
    await saveState(current);
    await tmux(current, ['set-option', '-g', '@side_hidden', '0']);
  }
  if (current.sidePane) {
    await tmux(current, ['send-keys', '-X', '-t', current.sidePane, 'cancel']).catch(() => {});
    await tmux(current, ['select-pane', '-t', current.sidePane]);
  }
}

async function resetScratchpad(state: RuntimeState, action: 'clear' | 'close' | 'toggle'): Promise<void> {
  const closing = join(state.directory, 'closing');
  const lock = join(state.directory, 'opening.lock');
  const controlDeadline = Date.now() + 20000;
  for (;;) {
    try { await writeFile(closing, action, { mode: 0o600, flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let running;
      try { running = await readFile(closing, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (running === action) return;
      if (Date.now() >= controlDeadline) throw new Error('Another side action is still finishing. Retry the side action.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  let locked = false;
  try {
    const deadline = Date.now() + 20000;
    while (!locked) {
      try { await mkdir(lock, { mode: 0o700 }); locked = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Side action is still finishing. Retry Close side.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const current = await loadState(state.directory);
    if (current.sidePane && await paneExists(current, current.sidePane) && action !== 'clear') {
      if (action === 'toggle' && current.sideHidden) {
        await restorePane(current);
      } else if (!current.sideHidden) {
        current.sideWidth = Number(await tmux(current, ['display-message', '-p', '-t', current.sidePane, '#{pane_width}']));
        await tmux(current, ['break-pane', '-d', '-s', current.sidePane, '-n', 'shoulder-hidden']);
        current.sideHidden = true;
        await saveState(current);
        await tmux(current, ['set-option', '-g', '@side_hidden', '1']);
      }
      await tmux(current, ['select-pane', '-t', action === 'toggle' && !current.sideHidden ? current.sidePane : current.mainPane]);
      state.sidePane = current.sidePane;
      return;
    }
    if (action === 'clear' && current.sidePane && await paneExists(current, current.sidePane)) {
      const provider = inferProvider(current.options);
      if (!current.sideParentId) throw new Error('This older side chat has no source reference. Close it and select a passage to open a new one.');
      // Reuse the launch settings/reference, so clearing also works while the
      // main is answering. Older runtimes can resolve their original source.
      const settings = current.sideSettings ?? (provider === 'claude'
        ? await readClaudeSessionSettings(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), current.sideParentId)
        : await readSessionSettings(process.env.CODEX_HOME ?? join(homedir(), '.codex'), current.sideParentId));
      const command = buildReferenceCommand({ ...current.options, sessionId: current.sideParentId }, settings);
      await restorePane(current);
      let previousIdentity = current.sideSessionId ?? current.sidePreviousSessionId;
      try { previousIdentity = await nativeInputIdentity(current, current.sidePane); } catch { /* A busy/dialog view may have no readable footer. */ }
      const name = `request-${randomUUID()}.json`, path = join(current.directory, name);
      await writeFile(path, JSON.stringify(command), { mode: 0o600, flag: 'wx' });
      let restarted = false;
      try {
        // Respawn keeps the same pane, divider position and dimensions. No
        // keystrokes or slash commands are injected into the discarded chat.
        await tmux(current, ['respawn-pane', '-k', '-t', current.sidePane, '-c', command.cwd, process.execPath, helper, 'side', current.directory, name]);
        restarted = true;
        delete current.sideSessionId;
        current.sidePreviousSessionId = previousIdentity;
        current.sideSettings = settings;
        if (provider === 'codex') current.sideUnsaved = true;
        if (provider === 'claude') current.sideSessionId = nativeSessionId(command.args);
        await saveState(current);
        await tmux(current, ['clear-history', '-t', current.sidePane]);
        await tmux(current, ['select-pane', '-t', current.sidePane]);
        state.sidePane = current.sidePane;
      } finally {
        if (!restarted) await rm(path, { force: true });
      }
      return;
    }
    if (current.sidePane && await paneExists(current, current.sidePane)) await tmux(current, ['kill-pane', '-t', current.sidePane]);
    delete current.sidePane;
    delete current.sideHidden;
    delete current.sideWidth;
    delete current.sideSessionId;
    delete current.sidePreviousSessionId;
    delete current.sideParentId;
    delete current.sideUnsaved;
    delete current.sideSettings;
    await saveState(current);
    await tmux(current, ['set-option', '-g', '@side_hidden', '0']);
    await tmux(current, ['set-option', '-g', '@side_exists', '0']);
    delete state.sidePane;
    await tmux(current, ['select-pane', '-t', current.mainPane]);
  } finally {
    if (locked) await rm(lock, { recursive: true, force: true });
    await rm(closing, { force: true });
  }
}

export async function cleanup(state: RuntimeState): Promise<void> {
  await tmux(state, ['kill-server']).catch(() => {});
  await rm(state.directory, { recursive: true, force: true });
}

export async function launch(options: LaunchOptions): Promise<number> {
  if (process.env.TMUX) throw new Error('Launch Shoulder from an outer terminal, outside an existing tmux session.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Shoulder requires an interactive TTY terminal.');
  const capabilities = await providerDoctor(options);
  if (!capabilities.ok) throw new Error(`Native CLI/tmux prerequisites failed. ${capabilities.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.evidence}`).join(' ')}`);
  const presentation = await loadPresentation();
  // The main reaper removes its runtime. Keep this launch-owned channel outside
  // that directory until the attached client has restored the terminal.
  const outcomeDirectory = await mkdtemp('/tmp/shoulder-result-');
  const outcomeFile = join(outcomeDirectory, 'main.json');
  let state: RuntimeState | undefined;
  let outcome: MainOutcome | undefined;
  let attachCode = 1;
  let signalCode = 0;
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  const handlers = Object.entries(signals).map(([signal, code]) => {
    const handler = () => { signalCode = code; if (state) void cleanup(state); };
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    state = await createRuntime(options, outcomeFile, presentation);
    if (!signalCode) {
      attachCode = await new Promise<number>(resolve => {
        const client = spawn('tmux', ['-S', state!.socket, 'attach-session', '-t', state!.session], { stdio: 'inherit', shell: false });
        client.once('error', () => resolve(1));
        client.once('close', code => resolve(code ?? 1));
      });
      try {
        outcome = JSON.parse(await readFile(outcomeFile, 'utf8')) as MainOutcome;
        if (!Number.isInteger(outcome.exitCode) || outcome.exitCode < 0 || outcome.exitCode > 255 || (outcome.spawnError !== undefined && !/^[A-Z0-9_]+$/.test(outcome.spawnError))) throw new Error('Invalid native main outcome.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } finally {
    if (state) await cleanup(state);
    // kill-server can return before the main helper finishes its final
    // temp-file/rename. Retry transient directory-removal races, bounded to
    // 150 ms of backoff; persistent failures still propagate.
    await rm(outcomeDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
  if (signalCode) return signalCode;
  const provider = inferProvider(options);
  const nativeName = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'executable';
  const inspectCommand = provider === 'codex' ? (options.sessionId ? `codex resume ${options.sessionId}` : 'codex') : shellQuote(options.codexPath);
  if (outcome?.spawnError) console.error(`shoulder: Could not start native ${nativeName} (${outcome.spawnError}). Check the executable path and working directory.`);
  else if (outcome && outcome.exitCode !== 0) console.error(`shoulder: Native ${nativeName} exited with status ${outcome.exitCode}. Run ${inspectCommand} directly to inspect authentication, configuration, or runtime errors.`);
  return outcome?.exitCode ?? attachCode;
}
