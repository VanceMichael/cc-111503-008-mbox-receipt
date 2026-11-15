import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMessage } from '../src/raw-message.mjs';
import { preview } from '../src/archive.mjs';
import { fixture } from '../src/samples.mjs';
import { Inbox } from '../src/store.mjs';

test('raw-message inspector preserves repeated headers and folded values', () => {
  const result = inspectMessage(Buffer.from('Subject: hello\n there\nX-Trace: a\nX-Trace: b\n\nbody'));
  assert.equal(result.headers[0].value, 'hello there'); assert.equal(result.headers.length, 3);
});
test('package preview can distinguish an incomplete transfer from a sealed original', async () => {
  const source = await fixture('open-tail'); const store = new Inbox();
  try { const result = await preview(source, store); assert.equal(result.receiptMatched, false); assert.equal(result.sealed, false); }
  finally { store.close(); }
});
