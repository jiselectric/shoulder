import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { validateSessionId, type SessionSettings } from './codex.js';
import { SessionMetadataError } from './session.js';

// Only filenames are inspected outside the exact requested session. Never pick a
// session by timestamps, directory order, cwd similarity, or transcript text.
async function exactFiles(home: string, id: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 4) throw new SessionMetadataError('Unsupported Claude project directory depth.', 'UNSUPPORTED');
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (++visited > 100000) throw new SessionMetadataError('Claude metadata search limit exceeded.', 'UNSUPPORTED');
      if (entry.isDirectory()) { if (entry.name !== 'subagents') await walk(join(directory, entry.name), depth + 1); }
      else if (entry.isFile() && entry.name.toLowerCase() === `${id.toLowerCase()}.jsonl`) found.push(join(directory, entry.name));
    }
  }
  await walk(join(home, 'projects'), 0);
  return found;
}

async function* records(path: string): AsyncGenerator<Record<string, unknown>> {
  let pending = Buffer.alloc(0), total = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
    const bytes = chunk as Buffer;
    if ((total += bytes.length) > 256 * 1024 * 1024) throw new SessionMetadataError('Claude metadata file limit exceeded.', 'UNSUPPORTED');
    pending = Buffer.concat([pending, bytes]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > 1024 * 1024) throw new SessionMetadataError('Claude metadata record limit exceeded.', 'UNSUPPORTED');
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      if (!line.length) continue;
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { throw new SessionMetadataError('Invalid Claude metadata record.', 'UNSUPPORTED'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionMetadataError('Unknown Claude metadata format.', 'UNSUPPORTED');
      yield value;
    }
    if (pending.length > 1024 * 1024) throw new SessionMetadataError('Claude metadata record limit exceeded.', 'UNSUPPORTED');
  }
  if (pending.length) throw new SessionMetadataError('Claude session has a partially saved record. Wait and retry.', 'INCOMPLETE');
}

export async function readClaudeSessionSettings(home: string, sessionId: string): Promise<SessionSettings> {
  validateSessionId(sessionId);
  const files = await exactFiles(home, sessionId);
  if (!files.length) throw new SessionMetadataError('Exact Claude session not found. Check its UUID and CLAUDE_CONFIG_DIR.', 'NOT_FOUND');
  if (files.length !== 1) throw new SessionMetadataError('Multiple exact Claude session files found.', 'AMBIGUOUS');
  let identified = false, active: boolean | undefined;
  let cwd: string | undefined, latest: Record<string, unknown> | undefined;
  for await (const record of records(files[0]!)) {
    if (record.sessionId !== undefined) {
      if (typeof record.sessionId !== 'string' || record.sessionId.toLowerCase() !== sessionId.toLowerCase() || (record.session_id !== undefined && record.session_id !== record.sessionId)) {
        throw new SessionMetadataError('Claude metadata identity differs from the requested exact UUID.', 'IDENTITY');
      }
      identified = true;
    }
    if (!['assistant', 'user'].includes(String(record.type)) || record.isSidechain === true) continue;
    if (!identified || record.sessionId === undefined) throw new SessionMetadataError('Claude conversation record lacks exact identity.', 'IDENTITY');
    if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd) || record.cwd.includes('\0')) throw new SessionMetadataError('Claude conversation lacks a verified working directory.', 'UNSUPPORTED');
    cwd = record.cwd;
    if (record.type === 'user') { active = true; continue; }
    const message = record.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new SessionMetadataError('Unknown Claude assistant metadata format.', 'UNSUPPORTED');
    const m = message as Record<string, unknown>;
    if (m.model === '<synthetic>') continue;
    latest = { model: m.model, effort: record.perTurnEffort ?? record.effort };
    if (m.stop_reason === 'end_turn') active = false;
    else if (m.stop_reason === 'tool_use' || m.stop_reason === null) active = true;
    else throw new SessionMetadataError('Unknown Claude turn completion metadata.', 'UNSUPPORTED');
  }
  if (!identified) throw new SessionMetadataError('Claude session lacks exact saved identity.', 'IDENTITY');
  if (active) throw new SessionMetadataError('Claude parent turn is active or unfinished. Wait for a completed answer.', 'ACTIVE');
  if (!cwd) throw new SessionMetadataError('Claude session lacks a verified working directory.', 'UNSUPPORTED');
  if (!latest || typeof latest.model !== 'string' || !latest.model.trim() || latest.model.includes('\0')) throw new SessionMetadataError('Claude session lacks a saved assistant model. Finish a native turn first.', 'MISSING_SETTINGS', cwd);
  const effort = latest.effort;
  if (effort !== undefined && (typeof effort !== 'string' || !['low','medium','high','xhigh','max'].includes(effort))) throw new SessionMetadataError('Unknown saved Claude effort.', 'UNSUPPORTED');
  return { model: latest.model, ...(typeof effort === 'string' ? { effort } : {}), cwd, active: false };
}

// No idle composer was observable without accepting a persistent workspace trust
// prompt on the installed Claude version. Fail closed until its native empty
// composer is verified; a bare ❯ also occurs in permission/trust dialogs.
export function parseClaudePromptReady(_screen: string): boolean { return false; }
