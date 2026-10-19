#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'shoulder package '));
const env = { ...process.env, npm_config_cache: join(temporary, 'npm cache'), npm_config_update_notifier: 'false' };
function run(command, args, cwd = root, overrides = {}) {
  return execFileSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
try {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'STALE_PRIVATE_FILE.txt'), 'synthetic package exclusion canary');
  run('npm', ['run', 'build']);
  assert.equal(existsSync(join(root, 'dist', 'STALE_PRIVATE_FILE.txt')), false, 'Build must remove stale generated files before packing');
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--offline', '--pack-destination', temporary]));
  const files = packed.files.map(file => file.path).sort();
  for (const required of ['README.md', 'SECURITY.md', 'PRIVACY.md', 'docs/compatibility.md', 'docs/verification.md', 'docs/release.md', 'dist/cli.js', 'dist/context-reader.js', 'dist/context.js', 'dist/runtime.js', 'dist/helper.js', 'package.json', 'LICENSE', 'docs/assets/overview.png', 'docs/assets/terminal-demo.png']) {
    assert.ok(files.includes(required), `Tarball must contain ${required}`);
  }
  const allowed = new Set(['LICENSE', 'docs/assets/overview.svg', 'docs/assets/overview.png', 'docs/assets/terminal-demo.svg', 'docs/assets/terminal-demo.png', 'package.json', 'README.md', 'SECURITY.md', 'PRIVACY.md', 'docs/compatibility.md', 'docs/verification.md', 'docs/release.md',
    ...['claude', 'cli', 'codex', 'context', 'context-reader', 'draft', 'helper', 'presentation', 'runtime', 'selection', 'session', 'tmux'].flatMap(name => [`dist/${name}.js`, `dist/${name}.d.ts`])]);
  assert.deepEqual(files, [...allowed].sort(), 'Packed files must match the reviewed public inventory exactly');
  assert.ok(packed.files.find(file => file.path === 'dist/cli.js').mode & 0o111, 'Tarball CLI must be executable');
  const prefix = join(temporary, 'installed under spaces');
  await mkdir(prefix);
  run('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(temporary, packed.filename)]);
  const installed = join(prefix, 'node_modules', 'shldr');
  const executable = join(prefix, 'node_modules', '.bin', 'shoulder');
  const shortExecutable = join(prefix, 'node_modules', '.bin', 'shldr');
  const contextSource = join(temporary, 'synthetic source with spaces.jsonl');
  const contextId = '12345678-1234-4234-8234-123456789abc';
  await writeFile(contextSource, [
    {type:'session_meta',payload:{id:contextId}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'smoke'}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'smoke',last_agent_message:'CONTEXT_SMOKE'}},
  ].map(JSON.stringify).join('\n')+'\n');
  const contextArgs = [join(installed,'dist/context-reader.js'),'--source',contextSource,'--session',contextId];
  const context = JSON.parse(run(process.execPath, contextArgs, prefix));
  assert.equal(context.status,'snapshot');
  assert.ok(context.messages.some(message=>message.text==='CONTEXT_SMOKE'));
  const unchangedContext = JSON.parse(run(process.execPath,[...contextArgs,'--since',context.cursor],prefix));
  assert.equal(unchangedContext.status,'unchanged');
  assert.deepEqual(unchangedContext.messages,[]);

  assert.ok((await stat(join(installed, 'dist/cli.js'))).mode & 0o111, 'Installed CLI must be executable');
  assert.match(run(executable, ['--help'], prefix), /Usage:/);
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'shldr');
  assert.deepEqual(Object.keys(metadata.bin).sort(), ['shldr', 'shoulder']);
  assert.equal(run(executable, ['--version'], prefix).trim(), metadata.version);
  assert.equal(run(shortExecutable, ['--version'], prefix).trim(), metadata.version);
  assert.equal(run(shortExecutable, ['--help'], prefix), run(executable, ['--help'], prefix));
  assert.match(run(executable, ['--help'], prefix), /shoulder codex/);
  assert.notEqual(metadata.private, true, 'The prepared public package must not retain the private guard');
  assert.deepEqual(metadata.publishConfig, { access: 'public', tag: 'alpha' }, 'Publications must default to the explicit alpha channel');
  assert.equal(metadata.license, 'MIT', 'License must match the owner-approved MIT release');
  assert.match(await readFile(join(installed, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Permission is hereby granted/);
  assert.equal(metadata.repository.url, 'git+https://github.com/jiselectric/shoulder.git');
  for (const name of ['overview', 'terminal-demo']) {
    const svg = await readFile(join(installed, 'docs/assets', `${name}.svg`), 'utf8');
    assert.match(svg, /<title[ >]/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject)\b|\bhref\s*=|url\(\s*["']?https?:/i, 'Illustrations must remain static and self-contained');
    const png = await readFile(join(installed, 'docs/assets', `${name}.png`));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0, 'Runtime dependency changes require a fresh supply-chain review');
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(metadata.scripts?.[hook], undefined, 'Consumer install hooks require a fresh supply-chain review');
  // Controlled help/version providers make this package check portable and inference-free.
  const providers = join(temporary, 'doctor fixtures');
  await mkdir(providers);
  const fixture = `#!${process.execPath}\nconst a=process.argv.slice(2);\nif (a.join(' ')==='--version') console.log('codex-cli 0.163.0');\nelse if(a.join(' ')==='resume --help') console.log('Usage: codex resume [SESSION_ID] [PROMPT]\\n--sandbox --model --config --profile');\nelse if(a.join(' ')==='fork --help') console.log('Usage: codex fork [SESSION_ID] [PROMPT]\\n--sandbox --model --config --profile');\nelse if(a.join(' ')==='-V') console.log('tmux 3.6a');\nelse process.exit(99);\n`;
  for (const name of ['codex', 'tmux']) await writeFile(join(providers, name), fixture, { mode: 0o755 });
  const doctor = run(executable, ['doctor'], prefix, { PATH: `${providers}:${process.env.PATH ?? ''}` });
  assert.equal((doctor.match(/^OK /gm) ?? []).length, 4, 'Installed doctor must inspect all four capabilities');
  assert.doesNotMatch(doctor, /^FAIL /m);
  console.log(JSON.stringify({ package: packed.filename, version: metadata.version, aliases: ['shoulder', 'shldr'], files: files.length, installPathContainsSpaces: prefix.includes(' '), executable: true, help: 'pass', versionCommand: 'pass', doctor: 'pass (controlled help/version only)', contextReader: 'pass (snapshot and unchanged, synthetic source)' }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
  assert.equal(existsSync(temporary), false, 'Smoke check must remove its temporary files');
}
