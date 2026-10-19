import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { sanitizeSelection, readSelection } from '../dist/selection.js';

test('multilingual selection survives and terminal controls cannot reach prompt', () => {
  assert.equal(sanitizeSelection(Buffer.from('\x1b[31m안녕 世界\x1b[0m\nquote "$()"\t\x1b]0;title\x07ok\x00')), '안녕 世界\nquote "$()"\tok');
});
test('empty, control-only, invalid UTF-8 and oversized selections fail', () => {
  for (const value of ['', ' \n\t', '\x1b[31m\x00', 'x'.repeat(16385)]) {
    assert.throws(() => sanitizeSelection(Buffer.from(value)), /selection/i);
  }
  assert.throws(() => sanitizeSelection(Uint8Array.from([0xff])), /UTF-8/);
  assert.equal(sanitizeSelection(Buffer.from('x'.repeat(16384))).length, 16384);
});
test('stream preserves split UTF-8 and refuses overflow across chunks', async () => {
  const bytes = Buffer.from('한글');
  assert.equal(await readSelection(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)])), '한글');
  await assert.rejects(readSelection(Readable.from([Buffer.alloc(16000, 65), Buffer.alloc(385, 66)])), /16 KiB/);
});
