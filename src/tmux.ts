import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeState } from './codex.js';

const execute = promisify(execFile);
// tmux's argv parser treats an individual/trailing semicolon as a command
// separator even without a shell. Data is escaped before queue separators exist.
function escapeTrailingSemicolon(arg: string): string {
  return arg.endsWith(';') ? `${arg.slice(0, -1)}\\;` : arg;
}
export async function tmux(state: Pick<RuntimeState, 'socket'>, args: string[]): Promise<string> {
  return executeTmux(state, args.map(escapeTrailingSemicolon));
}
export async function tmuxBatch(state: Pick<RuntimeState, 'socket'>, commands: string[][]): Promise<string> {
  if (!commands.length || commands.some(command => !command.length)) throw new Error('tmux command queue requires nonempty commands.');
  return executeTmux(state, commands.flatMap((command, index) => [
    ...(index ? [';'] : []), ...command.map(escapeTrailingSemicolon),
  ]));
}
async function executeTmux(state: Pick<RuntimeState, 'socket'>, args: string[]): Promise<string> {
  let result: { stdout: string; stderr: string };
  try {
    result = await execute('tmux', ['-S', state.socket, ...args], { shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const detail = error as { stderr?: string; code?: string };
    throw new Error(`tmux operation failed${detail.code === 'ENOENT' ? ': install tmux first' : detail.stderr ? `: ${detail.stderr.trim()}` : ''}.`);
  }
  // Some sandboxed tmux startup failures return zero. Keep their stderr outside
  // the subprocess catch, which deliberately omits stdout and command arguments.
  if (result.stderr.trim()) throw new Error(`tmux operation failed: ${result.stderr.trim()}.`);
  return result.stdout.trim();
}
export async function paneExists(state: RuntimeState, pane: string): Promise<boolean> {
  const panes = await tmux(state, ['list-panes', '-a', '-F', '#{pane_id}']);
  return panes.split('\n').includes(pane);
}

// Quote shell source, including the private dispatch script. tmux also expands
// formats, so installation paths belong in that script, never its binding text.
export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
