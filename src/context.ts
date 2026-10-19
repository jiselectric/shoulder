import { constants } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface ContextRequest {
  sourcePath: string;
  sessionId: string;
  cursor?: string;
  query?: string;
  /** Inclusive completed-message index for a literal search continuation. */
  start?: number;
  message?: number;
  /** UTF-16 code units; never a position between a surrogate pair. */
  offset?: number;
  /** Complete serialized JSON response limit, 1024..32768 bytes. */
  maxBytes?: number;
}
export interface ContextMessage {
  index: number;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  offset: number;
  totalChars: number;
}
export interface ContextResponse {
  sourceSessionId: string;
  status: 'snapshot' | 'delta' | 'unchanged' | 'reset' | 'search' | 'message';
  sourceVersion: string;
  /** Search and exact-message retrieval leave refresh progress untouched. */
  cursor: string | null;
  hasMore: boolean;
  olderAvailable: boolean;
  active: boolean;
  incompleteTail: boolean;
  messages: ContextMessage[];
  nextSearchIndex?: number;
}

type Row = { type: string; payload: Record<string, unknown> };
type Selector = 'event' | 'response' | 'complete';
type Ref = { position: number; length: number; selector: Selector; role: 'user' | 'assistant'; turnId: string; chars: number; jsonBytes: number; digest: string; prefix: string };
type Cursor = { v: 1; source: string; index: number; offset: number; prefix: string; part: string };
type Turn = { id: string; canonical: Ref[]; fallback: Ref[]; user: boolean; assistant: boolean };
const FILE_LIMIT = 256 * 1024 * 1024;
const RECORD_LIMIT = 1024 * 1024;
// A byte cap alone permits millions of tiny entries and unbounded metadata overhead.
const ENTRY_LIMIT = 100000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const seed = hash('shoulder-context-v1');
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function fail(): never { throw new Error('Context source unavailable or invalid'); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parse(bytes: Buffer): Row {
  try {
    const row: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(row) || typeof row.type !== 'string' || !object(row.payload)) fail();
    return row as Row;
  } catch { return fail(); }
}
function final(payload: Record<string, unknown>): boolean {
  return (payload.channel === undefined || payload.channel === 'final') && (payload.phase === undefined || payload.phase === 'final_answer');
}
function textOf(row: Row, selector: Selector, role: 'user' | 'assistant'): string {
  const p = row.payload;
  if (selector === 'complete') return typeof p.last_agent_message === 'string' ? p.last_agent_message : '';
  if (selector === 'event') {
    if (typeof p.message !== 'string') fail();
    return p.message;
  }
  if (!Array.isArray(p.content)) fail();
  return p.content.map(part => {
    if (!object(part)) fail();
    if (part.type !== (role === 'user' ? 'input_text' : 'output_text')) return '';
    if (typeof part.text !== 'string') fail();
    return part.text;
  }).join('');
}
function boundary(text: string, position: number): boolean {
  return !(position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]!) && /[\uDC00-\uDFFF]/.test(text[position]!));
}
async function scan(file: FileHandle, size: number, consume: (row: Row, position: number, length: number) => void): Promise<boolean> {
  const chunk = Buffer.alloc(65536);
  let pending = Buffer.alloc(0), readPosition = 0, linePosition = 0;
  while (readPosition < size) {
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - readPosition), readPosition);
    if (!bytesRead) fail();
    readPosition += bytesRead;
    const bytes = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let start = 0, end: number;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      if (end - start > RECORD_LIMIT) fail();
      consume(parse(bytes.subarray(start, end)), linePosition, end - start);
      linePosition += end - start + 1;
      start = end + 1;
    }
    pending = Buffer.from(bytes.subarray(start));
    if (pending.length > RECORD_LIMIT) fail();
  }
  return pending.length !== 0;
}
async function loadText(file: FileHandle, ref: Ref): Promise<string> {
  const bytes = Buffer.alloc(ref.length);
  let position = 0;
  while (position < bytes.length) {
    const read = await file.read(bytes, position, bytes.length - position, ref.position + position);
    if (!read.bytesRead) fail();
    position += read.bytesRead;
  }
  const text = textOf(parse(bytes), ref.selector, ref.role);
  if (text.length !== ref.chars || hash(JSON.stringify([ref.turnId, ref.role, text])) !== ref.digest) fail();
  return text;
}
function decodeCursor(value: string, source: string): Cursor {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  try {
    const c: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!object(c) || Object.keys(c).sort().join(',') !== 'index,offset,part,prefix,source,v' || c.v !== 1 || c.source !== source || !Number.isSafeInteger(c.index) || Number(c.index) < 0 || !Number.isSafeInteger(c.offset) || Number(c.offset) < 0 || typeof c.prefix !== 'string' || !HEX.test(c.prefix) || typeof c.part !== 'string' || (c.part !== '' && !HEX.test(c.part))) fail();
    return c as Cursor;
  } catch { return fail(); }
}

/** Read only completed conversation text. Every call independently validates the source. */
export async function readContext(request: ContextRequest): Promise<ContextResponse> {
  let file: FileHandle | undefined;
  try {
    if (!object(request) || typeof request.sourcePath !== 'string' || !isAbsolute(request.sourcePath) || request.sourcePath.includes('\0') || typeof request.sessionId !== 'string' || !UUID.test(request.sessionId)) fail();
    const budget = request.maxBytes ?? 12288;
    if (!Number.isInteger(budget) || budget < 1024 || budget > 32768) fail();
    const modes = [request.cursor, request.query, request.message].filter(v => v !== undefined).length;
    if (modes > 1 || (request.offset !== undefined && request.message === undefined)) fail();
    if (request.query !== undefined && (typeof request.query !== 'string' || !request.query || Buffer.byteLength(request.query) > RECORD_LIMIT)) fail();
    if (request.start !== undefined && (request.query === undefined || !Number.isSafeInteger(request.start) || request.start < 0)) fail();
    if (request.message !== undefined && (!Number.isSafeInteger(request.message) || request.message < 0)) fail();
    if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) fail();
    const path = resolve(request.sourcePath);
    const source = hash(JSON.stringify([path, request.sessionId]));
    const incoming = request.cursor === undefined ? undefined : decodeCursor(request.cursor, source);
    const beforePath = await lstat(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > FILE_LIMIT) fail();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size > FILE_LIMIT || before.ino !== beforePath.ino || before.dev !== beforePath.dev) fail();
    let identity = false, rowIndex = 0, active: Turn | undefined;
    const turns = new Set<string>();
    const refs: Ref[] = [];
    let version = seed;
    const makeRef = (row: Row, position: number, length: number, selector: Selector, role: 'user' | 'assistant', turnId: string): Ref | undefined => {
      const text = textOf(row, selector, role);
      if (!text) return undefined;
      return { position, length, selector, role, turnId, chars: text.length, jsonBytes: Buffer.byteLength(JSON.stringify(text)), digest: hash(JSON.stringify([turnId, role, text])), prefix: '' };
    };
    const incompleteTail = await scan(file, before.size, (row, position, length) => {
      const p = row.payload;
      if (rowIndex >= ENTRY_LIMIT) fail();
      if (rowIndex++ === 0) {
        if (row.type !== 'session_meta' || p.id !== request.sessionId || (p.session_id !== undefined && p.session_id !== p.id)) fail();
        identity = true;
        return;
      }
      if (row.type === 'session_meta') fail();
      if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(p.type))) {
        if (typeof p.turn_id !== 'string' || !p.turn_id || p.turn_id.length > 128) fail();
        if (p.type === 'task_started') {
          if (active || turns.has(p.turn_id)) fail();
          turns.add(p.turn_id);
          active = { id: p.turn_id, canonical: [], fallback: [], user: false, assistant: false };
        } else {
          if (!active || active.id !== p.turn_id) fail();
          if (p.type === 'task_complete') {
            const selected = [...active.canonical, ...active.fallback.filter(r => r.role === 'user' ? !active!.user : !active!.assistant)].sort((a, b) => a.position - b.position);
            if (!selected.some(r => r.role === 'assistant')) {
              const ref = makeRef(row, position, length, 'complete', 'assistant', active.id);
              if (ref) selected.push(ref);
            }
            for (const ref of selected) { ref.prefix = version; version = hash(version + ref.digest); refs.push(ref); }
          }
          active = undefined;
        }
        return;
      }
      if (row.type === 'turn_context') {
        if (typeof p.turn_id !== 'string' || (active ? p.turn_id !== active.id : !turns.has(p.turn_id))) fail();
      }
      if (!active && row.type === 'event_msg' && ['user_message', 'agent_message'].includes(String(p.type))) fail();
      if (!active) return;
      if (p.turn_id !== undefined && p.turn_id !== active.id) fail();
      if (row.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message')) {
        const role = p.type === 'user_message' ? 'user' : 'assistant';
        if (role === 'assistant' && !final(p)) return;
        active[role] = true;
        const ref = makeRef(row, position, length, 'event', role, active.id);
        if (ref) active.canonical.push(ref);
      } else if (row.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        if (!final(p)) return;
        const ref = makeRef(row, position, length, 'response', p.role, active.id);
        if (ref) active.fallback.push(ref);
      }
    });
    if (!identity) fail();
    const prefixAt = (index: number): string => refs[index]?.prefix ?? version;
    const cursorAt = (index: number, offset: number): string => Buffer.from(JSON.stringify({ v: 1, source, index, offset, prefix: prefixAt(index), part: offset ? refs[index]!.digest : '' } satisfies Cursor)).toString('base64url');
    const response: ContextResponse = { sourceSessionId: request.sessionId, status: 'snapshot', sourceVersion: version, cursor: null, hasMore: false, olderAvailable: false, active: !!active, incompleteTail, messages: [] };
    const fits = (): boolean => Buffer.byteLength(JSON.stringify(response)) <= budget;
    const messageAt = (ref: Ref, index: number, text: string, offset: number): ContextMessage => ({ index, turnId: ref.turnId, role: ref.role, text, offset, totalChars: ref.chars });
    let index = 0, offset = 0;
    if (request.query !== undefined) {
      response.status = 'search';
      if ((request.start ?? 0) > refs.length) fail();
      let exhausted = true;
      for (let i = request.start ?? 0; i < refs.length; i++) {
        const ref = refs[i]!;
        const text = await loadText(file, ref);
        const found = text.indexOf(request.query);
        if (found < 0) continue;
        let start = found;
        if (!boundary(text, start)) start--;
        const item = messageAt(ref, i, '', start);
        response.hasMore = true;
        response.nextSearchIndex = i + 1;
        response.messages.push(item);
        let end = Math.min(text.length, start + 320);
        if (!boundary(text, end)) end--;
        item.text = text.slice(start, end);
        while (!fits() && end > start) { end--; if (!boundary(text, end)) end--; item.text = text.slice(start, end); }
        if (!item.text || end <= found) {
          response.messages.pop();
          if (!response.messages.length) fail();
          response.nextSearchIndex = i;
          exhausted = false;
          break;
        }
        response.olderAvailable = i > 0 || end < text.length;
      }
      if (exhausted) { response.hasMore = false; delete response.nextSearchIndex; }
    } else if (request.message !== undefined) {
      response.status = 'message';
      index = request.message;
      offset = request.offset ?? 0;
      if (!refs[index] || offset > refs[index]!.chars) fail();
      response.olderAvailable = index > 0 || offset > 0;
    } else {
      let reset = false;
      if (incoming) {
        index = incoming.index; offset = incoming.offset;
        reset = index > refs.length || prefixAt(index) !== incoming.prefix || (offset > 0 && (!refs[index] || offset >= refs[index]!.chars || incoming.part !== refs[index]!.digest)) || (offset === 0 && incoming.part !== '');
        if (!reset) response.status = index === refs.length ? 'unchanged' : 'delta';
      }
      if (!incoming || reset) {
        response.status = reset ? 'reset' : 'snapshot';
        index = refs.length;
        let estimate = 650;
        while (index > 0) {
          const cost = refs[index - 1]!.jsonBytes + 180;
          if (index < refs.length && estimate + cost > budget) break;
          index--; estimate += cost;
        }
        offset = 0;
      }
      response.olderAvailable = index > 0;
      response.cursor = cursorAt(index, offset);
    }
    if (request.query === undefined) {
      const stop = request.message === undefined ? refs.length : index + 1;
      while (index < stop) {
        const ref = refs[index]!;
        const text = await loadText(file, ref);
        if (!boundary(text, offset)) fail();
        if (offset === text.length) break;
        const item = messageAt(ref, index, '', offset);
        response.messages.push(item);
        const fitEnd = (end: number): boolean => {
          item.text = text.slice(offset, end);
          const next = end === text.length ? index + 1 : index;
          response.hasMore = request.message === undefined ? next < refs.length : end < text.length;
          response.cursor = request.message === undefined ? cursorAt(next, end === text.length ? 0 : end) : null;
          return fits();
        };
        let end = text.length;
        if (!fitEnd(end)) {
          let low = offset, high = text.length;
          while (low < high) {
            let mid = Math.ceil((low + high) / 2);
            // Evaluate whole surrogate pairs; search by UTF-16 positions then fix its endpoint.
            if (fitEnd(mid)) low = mid; else high = mid - 1;
          }
          end = low;
          if (!boundary(text, end)) end--;
          fitEnd(end);
        }
        if (end === offset) {
          response.messages.pop();
          if (!response.messages.length) fail();
          response.hasMore = true;
          response.cursor = request.message === undefined ? cursorAt(index, offset) : null;
          break;
        }
        if (end < text.length) { offset = end; break; }
        index++; offset = 0;
      }
      if (!response.messages.length && request.message !== undefined) response.hasMore = false;
    }
    if (!fits()) fail();
    const after = await file.stat();
    const afterPath = await lstat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || afterPath.ino !== before.ino || afterPath.dev !== before.dev || afterPath.isSymbolicLink()) fail();
    return response;
  } catch { return fail(); }
  finally { await file?.close(); }
}
