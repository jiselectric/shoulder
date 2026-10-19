import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { launch } from '../../dist/runtime.js';
const [config,result]=process.argv.slice(2);
delete process.env.TMUX; // The outer test tmux provides only the launcher's PTY.
await writeFile(`${result}.pid`,String(process.pid));
const options=JSON.parse(await readFile(config,'utf8'));
const code=options.publicCli ? await new Promise((resolveCode,reject)=>{
  const child=spawn(process.execPath,[resolve('dist/cli.js'),'codex',...(options.showBanner ? [] : ['--no-banner']),...(options.directKeys === false ? ['--no-direct-keys'] : []),'--',...options.nativeArgs],{cwd:options.cwd,stdio:'inherit',env:{...process.env,PATH:`${dirname(options.codexPath)}:${process.env.PATH}`}});
  child.once('error',reject); child.once('close',code=>resolveCode(code ?? 1));
}) : await launch(options);
await writeFile(result,String(code));
process.exitCode=code;
