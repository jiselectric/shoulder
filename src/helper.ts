import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMainCommand, type Command } from './codex.js';
import { cleanup, clearScratchpad, closeScratchpad, toggleScratchpad, loadState, openScratchpad, type MainOutcome } from './runtime.js';
import { readSelection } from './selection.js';
import { tmux } from './tmux.js';

let terminalClosing = false;
function diagnostic(message: string): void {
  if (terminalClosing) return;
  // Node initializes process.stderr lazily. Reopening a hung-up PTY can block
  // forever on macOS; write through the existing descriptor instead.
  try { writeSync(2, `${message}\n`); } catch { /* The pane may already be gone. */ }
}
async function runNative(command: Command): Promise<MainOutcome> {
  return new Promise(resolve => {
    const child = spawn(command.executable, command.args, { cwd: command.cwd, stdio: 'inherit', shell: false });
    const signals = ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGWINCH'] as const;
    const handlers = signals.map(signal => {
      const handler = () => {
        if (signal === 'SIGHUP' || signal === 'SIGTERM') terminalClosing = true;
        child.kill(signal);
      };
      process.on(signal, handler);
      return { signal, handler };
    });
    const finish = (outcome: MainOutcome) => { for (const { signal, handler } of handlers) process.off(signal, handler); resolve(outcome); };
    child.once('error', error => {
      const spawnError = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      diagnostic(`shoulder: Could not start native executable (${spawnError}).`);
      finish({ exitCode: 1, spawnError });
    });
    child.once('exit', (code, signal) => finish({ exitCode: code ?? (signal ? 128 + constants.signals[signal] : 1) }));
  });
}
async function holdError(): Promise<void> {
  if (terminalClosing || !process.stdin.isTTY) return;
  diagnostic('\nScratchpad exited with an error. Press Enter to close this pane.');
  process.stdin.resume();
  await new Promise<void>(resolve => {
    const onData = (chunk: Buffer | string) => { if (/[\r\n]/.test(chunk.toString())) finish(); };
    const finish = () => {
      process.stdin.removeListener('data', onData);
      for (const event of ['end', 'close', 'error']) process.stdin.removeListener(event, finish);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on('data', onData);
    for (const event of ['end', 'close', 'error']) process.stdin.once(event, finish);
  });
}
async function main(): Promise<void> {
  const [mode, directory, request] = process.argv.slice(2);
  if (!directory) throw new Error('Missing runtime directory.');
  const state = await loadState(directory);
  if (mode === 'cleanup') { await cleanup(state); return; }
  if (mode === 'control' && ['close', 'clear', 'toggle'].includes(request ?? '')) {
    try {
      if (request === 'clear') await clearScratchpad(state);
      else if (request === 'toggle') await toggleScratchpad(state);
      else await closeScratchpad(state);
    } catch (error) {
      await tmux(state, ['display-message', '-l', `Shoulder: ${error instanceof Error ? error.message : 'Side action failed.'}`]).catch(() => {});
      // This rejection has already been shown as UI feedback. A failed tmux
      // run-shell job opens an output view over the native pane and traps input.
      // Keep fatal helper/native failures separate from handled side actions.
    }
    return;
  }
  if (mode === 'selection') {
    try { await openScratchpad(state, await readSelection(process.stdin)); }
    catch (error) { await tmux(state, ['display-message', '-l', `Shoulder: ${error instanceof Error ? error.message : 'Selection failed.'}`]).catch(() => {}); }
    return;
  }
  if (mode === 'main') {
    for (let i = 0; ; i++) {
      try { await access(join(directory, 'ready')); break; }
      catch { if (i >= 250) throw new Error('Runtime startup did not complete.'); await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    const outcome = await runNative(buildMainCommand(state.options));
    try {
      if (state.mainOutcomeFile) {
        await writeFile(`${state.mainOutcomeFile}.tmp`, JSON.stringify(outcome), { mode: 0o600, flag: 'wx' });
        await rename(`${state.mainOutcomeFile}.tmp`, state.mainOutcomeFile);
      }
    } finally {
      // Reaping must survive an unwritable or removed outcome channel. Otherwise
      // a live side keeps the server/client running after the main has exited.
      const reaper = spawn(process.execPath, [fileURLToPath(import.meta.url), 'cleanup', directory], { detached: true, stdio: 'ignore', shell: false });
      reaper.unref();
    }
    return;
  }
  if (mode !== 'side' || !request || !/^request-[a-f\d-]+\.json$/.test(request)) throw new Error('Invalid pane request.');
  const path = join(directory, request);
  const command = JSON.parse(await readFile(path, 'utf8')) as Command;
  await rm(path, { force: true });
  if ((await runNative(command)).exitCode !== 0) await holdError();
}
try { await main(); }
catch { diagnostic('shoulder: Runtime helper failed.'); process.exitCode = 1; }
// This process owns only one pane/action. TTY handles can remain referenced
// after a child exits; explicitly release them once the action is complete.
process.exit(process.exitCode ?? 0);
