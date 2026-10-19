#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, doctor } from './codex.js';
import { launch } from './runtime.js';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.command === 'help') {
      console.log('Shoulder — room for a side question.\n\nUsage:\n  shoulder --help\n  shoulder --version\n  shoulder doctor\n  shoulder codex [--session UUID] [--side-model MODEL] [--side-effort EFFORT] [--provider codex|claude|generic] [--no-banner] [--no-direct-keys] [--] [native arguments]\n\nshldr is an alias for shoulder.\nShoulder appears above your native CLI, which opens immediately.\nUse --no-banner before -- to start with the compact bottom bar. Click Hide banner / Show banner to toggle it live.\n\nFinish a main answer, then press Ctrl+Q or click Open side to ask a follow-up with main context.\nOr drag a passage and press e to open an unsent quoted draft.\nAdd your question and submit it in the native CLI. Nothing is sent automatically.\nEscape or click returns to typing. Scrolling focuses the pane under the pointer. Drag the divider to resize.\nClear side resets the side chat; Close side / Reopen side preserves and restores it.\nKeyboard (Codex): Ctrl+\\ switches panes; Ctrl+Q opens/closes/reopens. Use --no-direct-keys if your custom bindings conflict.\nFallbacks: Ctrl-b then c clears; x opens/closes/reopens; o switches panes; b hides/shows the banner. No Shift needed.\n\nExamples:\n  shldr codex\n  shldr codex --no-banner\n  shoulder codex --side-model MODEL --side-effort low\n  shoulder codex -- --help\n\nOther executables may replace codex; native arguments are forwarded in order.\nCodex sides read source context on demand. Claude and generic executables support main launch only; automatic side insertion is unavailable.\nRequires macOS or Linux, Node >=22, tmux >=3.6a, your authenticated native CLI, and an outer interactive terminal (outside tmux).\nUse at least 100 columns × 22 terminal rows for side chats (including the footer).');
      return 0;
    }
    if (args.command === 'version') {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      console.log(pkg.version);
      return 0;
    }
    if (args.command === 'doctor') {
      const result = await doctor();
      for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.evidence}`);
      console.log('Doctor inspects command help only. Terminal launch, tmux socket permissions, and authenticated model/context parity require separate verification.');
      return result.ok ? 0 : 1;
    }
    if (args.command !== 'codex') throw new Error('Unsupported command.');
    return await launch({ directKeys: !args.noDirectKeys, banner: !args.noBanner && !['--help', '-h', '--version', '-V'].includes(args.nativeArgs[0] ?? ''), sessionId: args.sessionId, nativeArgs: args.nativeArgs, cwd: process.cwd(), codexPath: args.executable ?? 'codex', ...(args.provider ? { provider: args.provider } : {}),
      ...(args.sideModel ? { sideModel: args.sideModel } : {}), ...(args.sideEffort ? { sideEffort: args.sideEffort } : {}) });
  } catch (error) {
    console.error(`shoulder: ${error instanceof Error ? error.message : 'Operation failed.'}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main();
