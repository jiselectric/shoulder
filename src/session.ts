import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateSessionId, type SessionSettings } from './codex.js';

export class SessionMetadataError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'AMBIGUOUS' | 'IDENTITY' | 'INCOMPLETE' | 'ACTIVE' | 'UNSUPPORTED' | 'MISSING_SETTINGS', public readonly cwd?: string, public readonly transcriptPath?: string) {
    super(message);
    this.name = 'SessionMetadataError';
  }
}
const MAX_RECORD = 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_ENTRIES = 100000;

async function findCandidates(home: string, id: string): Promise<string[]> {
  const candidates: string[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8) throw new SessionMetadataError('Session directory format exceeds the supported depth.', 'UNSUPPORTED');
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) throw new SessionMetadataError('Session directory exceeds the metadata search limit.', 'UNSUPPORTED');
      if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(`-${id.toLowerCase()}.jsonl`)) candidates.push(join(directory, entry.name));
    }
  }
  await walk(join(home, 'sessions'), 0);
  await walk(join(home, 'archived_sessions'), 0);
  return candidates;
}

// Keep record/file memory bounded; never retain response items or print record data.
async function* records(path: string): AsyncGenerator<Record<string, unknown>> {
  let pending = Buffer.alloc(0);
  let total = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const bytes = chunk as Buffer;
    total += bytes.length;
    if (total > MAX_FILE) throw new SessionMetadataError('Session file exceeds the metadata scan limit.', 'UNSUPPORTED');
    pending = Buffer.concat([pending, bytes]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > MAX_RECORD) throw new SessionMetadataError('Session record exceeds the metadata record limit.', 'UNSUPPORTED');
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (!line.length) continue;
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { throw new SessionMetadataError('Unknown session metadata format: invalid record.', 'UNSUPPORTED'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SessionMetadataError('Unknown session metadata record format.', 'UNSUPPORTED');
      yield parsed;
    }
    if (pending.length > MAX_RECORD) throw new SessionMetadataError('Session record exceeds the metadata record limit.', 'UNSUPPORTED');
  }
  if (pending.length) throw new SessionMetadataError('Session has an incomplete partial record. Wait for the parent to finish saving.', 'INCOMPLETE');
}

export async function readSessionSettings(codexHome: string, sessionId: string): Promise<SessionSettings> {
  validateSessionId(sessionId);
  const candidates = await findCandidates(codexHome, sessionId);
  if (!candidates.length) throw new SessionMetadataError('Exact session metadata not found. Check the local session UUID and CODEX_HOME.', 'NOT_FOUND');
  if (candidates.length !== 1) throw new SessionMetadataError('Multiple exact-ID session files found; parent metadata is ambiguous.', 'AMBIGUOUS');
  let identified = false;
  const active = new Set<string>();
  const contexts = new Map<string, Record<string, unknown>>();
  let latest: Record<string, unknown> | undefined;
  let completed = false;
  let interrupted = false;
  for await (const record of records(candidates[0]!)) {
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const p = payload as Record<string, unknown>;
    if (record.type === 'session_meta') {
      if (identified || typeof p.id !== 'string' || p.id.toLowerCase() !== sessionId.toLowerCase() || (p.session_id !== undefined && p.session_id !== p.id)) {
        throw new SessionMetadataError('Session metadata identity does not match the exact parent UUID.', 'IDENTITY');
      }
      identified = true;
    } else if (record.type === 'turn_context') {
      if (!identified) throw new SessionMetadataError('Session metadata identity must precede turn context.', 'IDENTITY');
      if (typeof p.turn_id !== 'string') throw new SessionMetadataError('Unknown turn metadata format: missing turn identity.', 'UNSUPPORTED');
      contexts.set(p.turn_id, { model: p.model, effort: p.effort, cwd: p.cwd });
    } else if (record.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(p.type))) {
      if (typeof p.turn_id !== 'string') throw new SessionMetadataError('Unknown lifecycle metadata format: missing turn identity.', 'UNSUPPORTED');
      if (p.type === 'task_started') active.add(p.turn_id);
      else if (p.type === 'turn_aborted') {
        active.delete(p.turn_id);
        contexts.delete(p.turn_id);
        interrupted = true;
      }
      else {
        active.delete(p.turn_id);
        completed = true;
        interrupted = false;
        latest = contexts.get(p.turn_id);
        contexts.delete(p.turn_id);
      }
    }
  }
  if (!identified) throw new SessionMetadataError('Unknown session metadata format: no exact parent identity.', 'IDENTITY');
  if (active.size) throw new SessionMetadataError('Parent turn is active. Wait for it to finish and save before opening a scratchpad.', 'ACTIVE');
  if (interrupted) throw new SessionMetadataError('Latest parent turn was aborted; finish a saved turn before opening a scratchpad.', 'INCOMPLETE');
  if (!completed) throw new SessionMetadataError('Unknown session metadata format: no completed turn lifecycle.', 'UNSUPPORTED');
  if (contexts.size) throw new SessionMetadataError('Session contains incomplete turn context. Wait for the parent to finish saving.', 'INCOMPLETE');
  if (!latest || typeof latest.cwd !== 'string' || !isAbsolute(latest.cwd) || latest.cwd.includes('\0')) {
    throw new SessionMetadataError('Saved metadata lacks a verified absolute working directory; explicit model settings cannot safely replace it.', 'UNSUPPORTED');
  }
  if (typeof latest.model !== 'string' || !latest.model.trim() || typeof latest.effort !== 'string' || !latest.effort) {
    throw new SessionMetadataError('Saved metadata lacks a complete model and effort. Supply --side-model and --side-effort explicitly if the parent is idle.', 'MISSING_SETTINGS', latest.cwd, candidates[0]);
  }
  return { model: latest.model, effort: latest.effort, cwd: latest.cwd, active: false, transcriptPath: candidates[0] };
}

// A newly forked native conversation can contain only its session header until
// the first submitted question. Verify identity and lifecycle independently of
// model settings, and never turn a partial/unknown record into an idle result.
export async function readSessionActivity(codexHome: string, sessionId: string): Promise<'idle' | 'empty'> {
  validateSessionId(sessionId);
  const candidates = await findCandidates(codexHome, sessionId);
  if (!candidates.length) throw new SessionMetadataError('Exact side session is not saved yet. Wait and retry.', 'NOT_FOUND');
  if (candidates.length !== 1) throw new SessionMetadataError('Side session metadata is ambiguous.', 'AMBIGUOUS');
  let identified = false, observed = false;
  const active = new Set<string>(), contexts = new Set<string>();
  for await (const record of records(candidates[0]!)) {
    const p = record.payload as Record<string, unknown> | undefined;
    if (record.type === 'session_meta') {
      if (identified || !p || typeof p.id !== 'string' || p.id.toLowerCase() !== sessionId.toLowerCase() || (p.session_id !== undefined && p.session_id !== p.id)) throw new SessionMetadataError('Side session identity does not match.', 'IDENTITY');
      identified = true;
    } else if (record.type === 'turn_context' || (record.type === 'event_msg' && p && ['task_started','task_complete','turn_aborted'].includes(String(p.type)))) {
      if (!identified || !p || typeof p.turn_id !== 'string') throw new SessionMetadataError('Unrecognized side lifecycle metadata.', 'UNSUPPORTED');
      observed = true;
      if (record.type === 'turn_context') contexts.add(p.turn_id);
      else if (p.type === 'task_started') active.add(p.turn_id);
      else { active.delete(p.turn_id); contexts.delete(p.turn_id); }
    } else if (record.type === 'world_state') {
      if (!identified || !p || typeof p.full !== 'boolean' || !p.state || typeof p.state !== 'object') throw new SessionMetadataError('Unrecognized side world-state record.', 'UNSUPPORTED');
    } else if (record.type === 'token_usage_record') {
      if (!identified || !p || typeof p.turn_id !== 'string') throw new SessionMetadataError('Unrecognized side token-accounting record.', 'UNSUPPORTED');
      for (const key of ['thread_id', 'session_id']) if (p[key] !== sessionId) throw new SessionMetadataError('Side token-accounting identity does not match.', 'IDENTITY');
    } else if (!['event_msg', 'response_item', 'compacted'].includes(String(record.type))) {
      throw new SessionMetadataError('Unknown side metadata record format.', 'UNSUPPORTED');
    }
  }
  if (!identified) throw new SessionMetadataError('Side metadata lacks its exact identity.', 'IDENTITY');
  if (active.size) throw new SessionMetadataError('Side turn is active. Wait for its answer before adding a selection.', 'ACTIVE');
  if (contexts.size) throw new SessionMetadataError('Side context is still being saved. Wait and retry.', 'INCOMPLETE');
  return observed ? 'idle' : 'empty';
}

// Parse only the current input footer, never a UUID in output or scrollback.
// Codex 0.163.0 may append a warning indicator to its final shortcuts row.
export function parseSessionFooter(screen: string): string {
  const unavailable = () => new Error('Cannot resolve the current native session footer. Finish the main answer, return to the normal input view, and retry; widen the terminal if the UUID is truncated.');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(screen)) throw unavailable();
  const lines = screen.trimEnd().split('\n');
  if (!/^[ \t]*\? for shortcuts(?:[ \t]+⚠[ \t]+[1-9]\d* warnings?[ \t]+·[ \t]+f2 to view)?[ \t]*$/.test(lines.at(-1) ?? '')) throw unavailable();
  const footer = lines.at(-2) ?? '';
  const match = /^[ \t]*([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:[ \t]+·[ \t]+(.+?))?[ \t]*$/i.exec(footer);
  if (!match || /[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i.test(match[2] ?? '')) throw unavailable();
  validateSessionId(match[1]);
  return match[1];
}

// Codex hides its shortcuts hint while an input draft is nonempty. The UUID
// remains the final row; require the native composer as an additional anchor.
export function parseComposerFooter(screen: string): string {
  try { return parseSessionFooter(screen); }
  catch {
    const lines = screen.trimEnd().split('\n');
    if (/^[ \t]*tab to queue message[ \t]*$/.test(lines[lines.length - 1] ?? '')) lines.pop();
    let composer = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^[ \t]*›(?:[ \t]|$)/.test(lines[i]!)) { composer = i; break; }
    }
    if (composer < 0 || composer >= lines.length - 2) throw new Error('Cannot resolve the current native input footer. Return to the normal composer and retry.');
    return parseSessionFooter(`${lines.join('\n')}\n  ? for shortcuts`);
  }
}
