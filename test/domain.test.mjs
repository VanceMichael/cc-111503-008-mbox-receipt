import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMessage } from '../src/raw-message.mjs';
import { preview } from '../src/archive.mjs';
import { fixture } from '../src/samples.mjs';
import { Inbox } from '../src/store.mjs';

test('raw-message inspector preserves folded and repeated headers', () => {
  const value = inspectMessage(Buffer.from('Subject: hello\n there\nX: a\nX: b\n\nbody'));
  assert.equal(value.headers[0].value, 'hello there'); assert.equal(value.headers.length, 3);
});
test('unrestricted package preview is still available independently of grant receipt', async () => {
  const source = await fixture(); const store = new Inbox();
  try { assert.equal((await preview(source, store)).receiptMatched, true); }
  finally { store.close(); await source.close(); }
});
test('range source refuses ungranted gaps rather than returning extra private bytes', async () => {
  const source = await fixture();
  try {
    const response = await fetch(source.url + source.path, { headers: { Range: 'bytes=0-' + (source.index.totalSize - 1), 'If-Match': source.index.etag } });
    assert.equal(response.status, 403);
  } finally { await source.close(); }
});
test('authorized two-range response really uses multipart byte ranges', async () => {
  const source = await fixture();
  try {
    const range = source.index.entries.map(row => row.start + '-' + (row.end - 1)).join(',');
    const response = await fetch(source.url + source.path, { headers: { Range: 'bytes=' + range, 'If-Match': source.index.etag } });
    assert.equal(response.status, 206); assert.match(response.headers.get('content-type'), /multipart\/byteranges/);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.includes(Buffer.from('Content-Range: bytes')));
  } finally { await source.close(); }
});

test('a single byte range has the ordinary RFC206 response shape', async () => {
  const source = await fixture();
  try {
    const entry = source.index.entries[0];
    const response = await fetch(source.url + source.path, { headers: { Range: 'bytes=' + entry.start + '-' + (entry.end - 1), 'If-Match': source.index.etag } });
    assert.equal(response.status, 206); assert.match(response.headers.get('content-range'), /^bytes /);
    assert.equal((await response.arrayBuffer()).byteLength, entry.end - entry.start);
  } finally { await source.close(); }
});
