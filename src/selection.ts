const MAX_SELECTION_BYTES = 16 * 1024;

export function sanitizeSelection(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_SELECTION_BYTES) throw new Error('Selection exceeds 16 KiB. Select a shorter passage.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Selection must be valid UTF-8.'); }
  text = text
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c)/g, '')
    .replace(/(?:\x1b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c)/g, '')
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  if (!text.trim()) throw new Error('Selection must contain visible text.');
  return text;
}

export async function readSelection(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SELECTION_BYTES) throw new Error('Selection exceeds 16 KiB. Select a shorter passage.');
    chunks.push(bytes);
  }
  return sanitizeSelection(Buffer.concat(chunks, size));
}
