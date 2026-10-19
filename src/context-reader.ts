import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { readContext, type ContextRequest } from './context.js';

/** Strict read-only tool interface; values remain argv data, never shell source. */
export function parseContextArgs(args: string[]): ContextRequest {
  const allowed = new Set(['--source', '--session', '--since', '--search', '--start', '--message', '--offset']);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!allowed.has(key) || values.has(key) || value === undefined || value.includes('\0')) throw new Error('Invalid context-reader arguments.');
    values.set(key, value);
  }
  const sourcePath = values.get('--source'), sessionId = values.get('--session');
  if (!sourcePath || !isAbsolute(sourcePath) || !sessionId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(sessionId)) throw new Error('An exact source and session are required.');
  const cursor = values.get('--since'), query = values.get('--search');
  const parseIndex = (key: string): number | undefined => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('Invalid context-reader position.');
    return Number(raw);
  };
  const message = parseIndex('--message'), offset = parseIndex('--offset'), start = parseIndex('--start');
  if ([cursor !== undefined, query !== undefined, message !== undefined].filter(Boolean).length > 1 || (offset !== undefined && message === undefined) || (start !== undefined && query === undefined) || cursor === '' || query === '') throw new Error('Conflicting context-reader modes.');
  return { sourcePath, sessionId, ...(cursor !== undefined ? {cursor} : {}), ...(query !== undefined ? {query} : {}), ...(start !== undefined ? {start} : {}), ...(message !== undefined ? {message} : {}), ...(offset !== undefined ? {offset} : {}) };
}

const entry = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => '') : '';
if (entry === fileURLToPath(import.meta.url)) {
  try {
    const result = await readContext(parseContextArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result));
  } catch {
    // Neither transcript text, paths, argv nor native diagnostics are exposed.
    process.stderr.write('Shoulder context reader could not verify completed source context.\n');
    process.exitCode = 1;
  }
}
