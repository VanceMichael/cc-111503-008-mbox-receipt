import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serve } from '../src/http.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function adversarialSource(handler) {
  const mailA = Buffer.from('Message-ID: <a@example.test>\n\nmail a\n');
  const mailB = Buffer.from('Message-ID: <b@example.test>\n\nmail b\n');
  const gap = Buffer.from('PRIVATE DEPARTMENT BYTES');
  const bytes = Buffer.concat([mailA, gap, mailB]);
  const index = {
    archiveId: 'mail-x', revision: 'r1', etag: '"v1"', totalSize: bytes.length,
    entries: [
      { id: 'A', start: 0, end: mailA.length, sha256: sha256(mailA) },
      { id: 'B', start: mailA.length + gap.length, end: bytes.length, sha256: sha256(mailB) },
    ],
  };
  const requests = [];
  const server = await serve((request, response) => {
    requests.push({ range: request.headers.range || null, ifMatch: request.headers['if-match'] || null });
    return handler({ request, response, bytes, index, requests });
  });
  return { ...server, path: '/archive', index, requests, bytes,
    receipt: { archiveId: 'mail-x', revision: 'r1', byteLength: bytes.length, sha256: sha256(bytes), sealed: true } };
}

async function withRun(source, check) {
  const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('a multipart part declaring bytes inside the unauthorized gap is rejected', async () => {
  const source = await adversarialSource(({ request, response, bytes, index }) => {
    if (request.headers['if-match'] !== index.etag) { response.writeHead(412); return response.end(); }
    const boundary = 'b';
    response.writeHead(206, { 'content-type': `multipart/byteranges; boundary=${boundary}`, etag: index.etag });
    response.write(Buffer.from(`--${boundary}\r\nContent-Range: bytes 0-${bytes.length - 1}/${bytes.length}\r\n\r\n`));
    response.write(bytes);
    response.end(Buffer.from(`\r\n--${boundary}--\r\n`));
  });
  await withRun(source, (result, source2, store) => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.records.length, 0);
    assert.ok(result.diagnostics.some(row => row.code === 'part-exceeds-grant'));
    // The private gap never becomes retained original evidence.
    assert.equal(store.evidence().filter(row => row.kind === 'mail-original').length, 0);
    assert.ok(source2.requests.every(row => row.ifMatch === source2.index.etag));
  });
});

test('a Content-Range announcing a different package size is not accepted', async () => {
  const source = await adversarialSource(({ request, response, bytes, index }) => {
    const entry = index.entries[0];
    response.writeHead(206, {
      'content-type': 'multipart/byteranges; boundary=b', etag: index.etag,
    });
    response.end(Buffer.concat([
      Buffer.from(`--b\r\nContent-Range: bytes ${entry.start}-${entry.end - 1}/${bytes.length + 50}\r\n\r\n`),
      bytes.subarray(entry.start, entry.end),
      Buffer.from('\r\n--b--\r\n'),
    ]));
  });
  await withRun(source, result => {
    assert.equal(result.records.length, 0);
    assert.ok(result.diagnostics.some(row => row.code === 'package-size-mismatch'));
  });
});

test('overlapping parts with conflicting shared bytes fail the consistency check', async () => {
  const source = await adversarialSource(({ request, response, bytes, index }) => {
    const entry = index.entries[0];
    const good = bytes.subarray(entry.start, entry.end);
    const tampered = Buffer.from(good);
    tampered[0] = tampered[0] === 0x58 ? 0x59 : 0x58;
    response.writeHead(206, { 'content-type': 'multipart/byteranges; boundary=b', etag: index.etag });
    response.end(Buffer.concat([
      Buffer.from(`--b\r\nContent-Range: bytes ${entry.start}-${entry.end - 1}/${bytes.length}\r\n\r\n`),
      good, Buffer.from('\r\n'),
      Buffer.from(`--b\r\nContent-Range: bytes ${entry.start}-${entry.start + 3}/${bytes.length}\r\n\r\n`),
      tampered.subarray(0, 4), Buffer.from('\r\n'),
      Buffer.from('--b--\r\n'),
    ]));
  });
  await withRun(source, (result, source2) => {
    assert.ok(result.diagnostics.some(row => row.code === 'overlap-conflict'));
    // The tampered fragment is refused; the consistent first fragment stays,
    // but the entry cannot be trusted as a closed original in this run.
    const record = result.records.find(row => row.id === 'A');
    if (record) {
      assert.equal(record.sha256, source2.index.entries[0].sha256);
      assert.ok(result.diagnostics.some(row => row.code === 'overlap-conflict'));
    } else {
      assert.ok(result.pending.some(row => row.id === 'A'));
    }
  });
});

test('identical overlapping parts merge and the entry still closes via digest', async () => {
  const source = await adversarialSource(({ request, response, bytes, index }) => {
    const entry = index.entries[0];
    const part = bytes.subarray(entry.start, entry.end);
    response.writeHead(206, { 'content-type': 'multipart/byteranges; boundary=b', etag: index.etag });
    response.end(Buffer.concat([
      Buffer.from(`--b\r\nContent-Range: bytes ${entry.start}-${entry.end - 1}/${bytes.length}\r\n\r\n`),
      part, Buffer.from('\r\n'),
      Buffer.from(`--b\r\nContent-Range: bytes ${entry.start}-${entry.start + 2}/${bytes.length}\r\n\r\n`),
      part.subarray(0, 3), Buffer.from('\r\n'),
      Buffer.from('--b--\r\n'),
    ]));
  });
  await withRun(source, result => {
    const record = result.records.find(row => row.id === 'A');
    assert.ok(record);
    assert.equal(record.sha256, source.index.entries[0].sha256);
  });
});

test('a plain 200 full mailbox answer leaves no original evidence behind', async () => {
  const source = await adversarialSource(({ request, response, bytes }) => {
    response.writeHead(200, { etag: '"v1"' });
    response.end(bytes);
  });
  await withRun(source, (result, source2, store) => {
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.pending.map(row => row.id), ['A', 'B']);
    const kinds = store.evidence().map(row => row.kind);
    assert.ok(kinds.includes('authorization-index'));
    assert.ok(kinds.includes('http-exchange'));
    assert.ok(!kinds.includes('mail-original'));
    assert.equal(source2.requests.length, 1);
  });
});

test('every retained original is traceable to the index and its received bytes', async () => {
  const source = await adversarialSource(({ request, response, bytes, index }) => {
    if (request.headers['if-match'] !== index.etag) { response.writeHead(412); return response.end(); }
    const ranges = request.headers.range.slice(6).split(',').map(value => value.trim().split('-').map(Number));
    const boundary = 'b';
    response.writeHead(206, { 'content-type': 'multipart/byteranges; boundary=b', etag: index.etag });
    const chunks = [];
    for (const [start, end] of ranges.slice().reverse()) {
      chunks.push(Buffer.from(`--b\r\nContent-Range: bytes ${start}-${end}/${bytes.length}\r\n\r\n`));
      chunks.push(bytes.subarray(start, end + 1), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from('--b--\r\n'));
    response.end(Buffer.concat(chunks));
  });
  await withRun(source, (result, source2, store) => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(row => row.id).sort(), ['A', 'B']);
    const evidence = store.evidence();
    assert.equal(evidence.filter(row => row.kind === 'authorization-index').length, 1);
    for (const record of result.records) {
      const entry = source2.index.entries.find(row => row.id === record.id);
      const saved = evidence.find(row => row.id === record.evidence);
      assert.ok(saved, 'record points at retained evidence');
      assert.equal(saved.kind, 'mail-original');
      assert.deepEqual(saved.metadata.start, entry.start);
      assert.equal(saved.size, entry.end - entry.start);
      assert.equal(saved.metadata.sha256, record.sha256);
    }
    assert.deepEqual(store.list('collection-runs')[0].status, 'complete');
  });
});
