import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/http.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox, digest } from '../src/store.mjs';
import { CoverageLedger, isWithin, mergeIntervals, missingIntervals } from '../src/coverage-ledger.mjs';
import { boundaryFromContentType, parseMultipart } from '../src/multipart.mjs';

const ETAG = '"pkg-v1"';

function makeEntry(id, start, end, bytes) {
  return { id, start, end, sha256: digest(bytes.subarray(start, end)) };
}

async function customSource(index, bytes, handler) {
  const server = await serve(handler);
  return { url: server.url, close: server.close, path: '/archive', index, bytes };
}

function multipartParts(res, boundary, parts, { truncated = false, etag = ETAG } = {}) {
  res.writeHead(206, { 'content-type': `multipart/byteranges; boundary="${boundary}"`, etag });
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: message/rfc822\r\nContent-Range: bytes ${part.start}-${part.end}/${part.total}\r\n\r\n`));
    chunks.push(part.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const wire = Buffer.concat(chunks);
  res.end(truncated ? wire.subarray(0, Math.floor(wire.length / 2)) : wire);
}

function parseRequestRanges(rangeHeader) {
  return rangeHeader.replace('bytes=', '').split(',').map(value => {
    const [start, end] = value.trim().split('-').map(Number);
    return [start, end];
  });
}

async function runWith(source, check) {
  const store = new Inbox();
  try { await check(await intake.collect(source, store), store, source); }
  finally { store.close(); await source.close(); }
}

test('coverage ledger keeps authorized gaps outside every accepted span', () => {
  const ledger = new CoverageLedger([[0, 9], [20, 29]]);
  assert.equal(isWithin(ledger.authorized, 0, 9), true);
  assert.equal(isWithin(ledger.authorized, 5, 25), false);
  assert.equal(isWithin(ledger.authorized, 10, 19), false);
  assert.deepEqual(mergeIntervals([[0, 4], [5, 9], [20, 25], [26, 29]]), [[0, 9], [20, 29]]);
  ledger.add(0, 9, Buffer.alloc(10, 1));
  // 20-29 同样未覆盖，与空隙 10-19 连成一个缺口区间
  assert.deepEqual(missingIntervals(ledger.coverage, 0, 29), [[10, 29]]);
  assert.deepEqual(missingIntervals(ledger.coverage, 0, 5), []);
});

test('overlapping parts must carry identical bytes or the later part is refused', () => {
  const ledger = new CoverageLedger([[0, 9]]);
  ledger.add(0, 5, Buffer.from('abcdef'));
  ledger.add(4, 9, Buffer.from('efghij')); // 重叠字节 e f 一致
  assert.deepEqual(ledger.slice(0, 9).toString(), 'abcdefghij');
  const conflicting = new CoverageLedger([[0, 9]]);
  conflicting.add(0, 5, Buffer.from('abcdef'));
  assert.throws(() => conflicting.add(4, 9, Buffer.from('XXghij')), error => error.code === 'overlap-conflict');
  assert.throws(() => ledger.add(9, 19, Buffer.alloc(11)), error => error.code === 'outside-authorization');
});

test('multipart parser only accepts legal boundary lines, mail text cannot create parts', () => {
  const boundary = 'dept-boundary';
  const payload = Buffer.concat([
    Buffer.from('mail text --dept-boundary without CRLF prefix stays content\r\n'),
    Buffer.from('\r\n--dept-boundary-junk suffix is not a delimiter\r\n'),
    Buffer.from('tail of the only real part'),
  ]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Range: bytes 0-${payload.length - 1}/100\r\n\r\n`),
    payload, Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const parsed = parseMultipart(body, boundary);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.parts.length, 1);
  assert.ok(parsed.parts[0].data.equals(payload));
  assert.equal(boundaryFromContentType('multipart/byteranges; boundary="dept-boundary"'), boundary);
  assert.equal(boundaryFromContentType('multipart/byteranges; boundary=dept-boundary'), boundary);
});

test('parser keeps fully framed parts and flags a missing closing boundary', () => {
  const boundary = 'b';
  const partA = { start: 0, end: 3, total: 10, data: Buffer.from('aaaa') };
  const partB = { start: 4, end: 7, total: 10, data: Buffer.from('bbbb') };
  const full = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Range: bytes 0-3/10\r\n\r\n`), partA.data, Buffer.from('\r\n'),
    Buffer.from(`--${boundary}\r\nContent-Range: bytes 4-7/10\r\n\r\n`), partB.data, Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const ordered = parseMultipart(full, boundary);
  assert.equal(ordered.parts.length, 2);
  const cut = parseMultipart(full.subarray(0, full.length - 4), boundary);
  assert.equal(cut.truncated, true);
  assert.ok(cut.parts.length >= 1);
  assert.ok(cut.problems.some(problem => problem.includes('closing boundary')));
});

test('collect reconstructs originals from reordered and merged parts by declared range', async () => {
  const bytes = Buffer.from('0123456789abcdefghijABCDEFGHIJ'); // 三个相邻授权原件，每段10字节
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: bytes.length,
    entries: [makeEntry('E1', 0, 10, bytes), makeEntry('E2', 10, 20, bytes), makeEntry('E3', 20, 30, bytes)] };
  const source = await customSource(index, bytes, (request, response) => {
    assert.equal(request.headers['if-match'], ETAG);
    const ranges = parseRequestRanges(request.headers.range);
    const parts = ranges.map(([start, end]) => ({ start, end, total: bytes.length, data: bytes.subarray(start, end + 1) }));
    parts.reverse(); // 服务端故意重排
    return multipartParts(response, 'mix', parts);
  });
  await runWith(source, (result, store) => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(row => row.id).sort(), ['E1', 'E2', 'E3']);
    for (const record of result.records) {
      const entry = index.entries.find(row => row.id === record.id);
      assert.equal(record.sha256, entry.sha256);
      assert.ok(store.evidence().some(row => row.kind === 'received-original' && row.id === record.evidenceId));
    }
    assert.ok(store.evidence().some(row => row.kind === 'authorization-index'));
    assert.ok(store.evidence().some(row => row.kind === 'http-exchange'));
  });
});

test('a part reaching across an unauthorized gap is refused while good parts still count', async () => {
  const bytes = Buffer.alloc(30, 7);
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: 30,
    entries: [makeEntry('E1', 0, 10, bytes), makeEntry('E2', 20, 30, bytes)] }; // 空隙 10-19
  const source = await customSource(index, bytes, (request, response) => {
    return multipartParts(response, 'g', [
      { start: 0, end: 9, total: 30, data: bytes.subarray(0, 10) },
      { start: 10, end: 29, total: 30, data: bytes.subarray(10, 30) }, // 越权吞并空隙
    ]);
  });
  await runWith(source, result => {
    assert.notEqual(result.status, 'complete');
    assert.deepEqual(result.records.map(row => row.id), ['E1']);
    assert.deepEqual(result.pending.map(row => row.id), ['E2']);
    assert.ok(result.diagnostics.some(row => row.code === 'outside-authorization'));
  });
});

test('inconsistent overlap bytes are diagnosed instead of silently merged', async () => {
  const bytes = Buffer.alloc(10, 9);
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: 10,
    entries: [makeEntry('E1', 0, 10, bytes)] };
  const source = await customSource(index, bytes, (request, response) => {
    return multipartParts(response, 'o', [
      { start: 0, end: 5, total: 10, data: Buffer.from('abcdef') },
      { start: 4, end: 9, total: 10, data: Buffer.from('ZZghij') },
    ]);
  });
  await runWith(source, result => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.records.length, 0);
    assert.ok(result.diagnostics.some(row => row.code === 'overlap-conflict'));
    // 第一个部分的 0-5 已可信登记，冲突部分 4-9 被拒，缺口只报尚未覆盖的 6-9
    assert.deepEqual(result.pending[0].missing, [{ start: 6, end: 9 }]);
  });
});

test('a declared package size different from the index cannot be accepted', async () => {
  const bytes = Buffer.alloc(10, 3);
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: 10,
    entries: [makeEntry('E1', 0, 10, bytes)] };
  const source = await customSource(index, bytes, (request, response) => {
    return multipartParts(response, 's', [{ start: 0, end: 9, total: 999, data: bytes }]);
  });
  await runWith(source, result => {
    assert.notEqual(result.status, 'complete');
    assert.equal(result.records.length, 0);
    assert.ok(result.diagnostics.some(row => row.code === 'package-size-mismatch'));
  });
});

test('a 206 whose ETag drifted from the index is rejected', async () => {
  const bytes = Buffer.alloc(10, 3);
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: 10,
    entries: [makeEntry('E1', 0, 10, bytes)] };
  const source = await customSource(index, bytes, (request, response) => {
    return multipartParts(response, 'e', [{ start: 0, end: 9, total: 10, data: bytes }], { etag: '"pkg-v2"' });
  });
  await runWith(source, result => {
    assert.equal(result.status, 'rejected');
    assert.equal(result.records.length, 0);
    assert.ok(result.diagnostics.some(row => row.code === 'version-conflict'));
  });
});

test('fully covered bytes failing the index digest stay pending with an explicit reason', async () => {
  const bytes = Buffer.alloc(10, 3);
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: 10,
    entries: [{ id: 'E1', start: 0, end: 10, sha256: '00'.repeat(32) }] };
  const source = await customSource(index, bytes, (request, response) => {
    return multipartParts(response, 'd', [{ start: 0, end: 9, total: 10, data: bytes }]);
  });
  await runWith(source, result => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.records.length, 0);
    assert.deepEqual(result.pending[0].missing, []);
    assert.match(result.pending[0].reason, /digest/);
    assert.ok(result.diagnostics.some(row => row.code === 'digest-mismatch'));
  });
});

test('single-range 206 truncation is reported and never recorded', async () => {
  const bytes = Buffer.alloc(10, 4);
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: 10,
    entries: [makeEntry('E1', 0, 10, bytes)] };
  const source = await customSource(index, bytes, (request, response) => {
    response.writeHead(206, { 'content-type': 'message/rfc822', 'content-range': `bytes 0-9/${bytes.length}`, etag: ETAG });
    response.end(bytes.subarray(0, 8));
  });
  await runWith(source, result => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.records.length, 0);
    assert.ok(result.diagnostics.some(row => row.code === 'transfer-truncated'));
    assert.deepEqual(result.pending[0].missing, [{ start: 0, end: 9 }]);
  });
});

test('request budget and the four-range cap are honored and gaps are never requested', async () => {
  const bytes = Buffer.from('a'.repeat(60));
  const entries = [];
  for (let i = 0; i < 6; i++) {
    const start = i * 10;
    entries.push({ id: `E${i}`, start, end: start + 10, sha256: digest(bytes.subarray(start, start + 10)) });
  }
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: bytes.length, entries };
  const seen = [];
  const source = await customSource(index, bytes, (request, response) => {
    const ranges = parseRequestRanges(request.headers.range);
    seen.push({ range: request.headers.range, ifMatch: request.headers['if-match'], ranges });
    assert.ok(ranges.length <= 4, 'each request carries at most four ranges');
    for (const [start, end] of ranges) {
      assert.ok(isWithin(index.entries.map(entry => [entry.start, entry.end - 1]), start, end),
        'requested span must stay inside the authorized index');
    }
    return multipartParts(response, 'budget', ranges.map(([start, end]) => ({ start, end, total: bytes.length, data: bytes.subarray(start, end + 1) })));
  });
  await runWith(source, result => {
    assert.equal(result.status, 'complete');
    assert.ok(seen.length >= 1 && seen.length <= 2, 'body request budget is two requests');
    assert.ok(seen.every(row => row.ifMatch === ETAG));
    assert.equal(result.records.length, 6);
  });
});

test('authorized collection never reads source.bytes, only the restricted HTTP source', async () => {
  const bytes = Buffer.from('restricted-package-bytes-not-to-be-touched');
  const index = { archiveId: 'a1', revision: 'r1', etag: ETAG, totalSize: bytes.length,
    entries: [makeEntry('E1', 0, bytes.length, bytes)] };
  const server = await serve((request, response) => {
    response.writeHead(206, { 'content-type': 'message/rfc822', 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, etag: ETAG });
    response.end(bytes);
  });
  const source = { url: server.url, close: server.close, path: '/archive', index }; // 故意不提供 bytes
  try {
    const store = new Inbox();
    try {
      const result = await intake.collect(source, store);
      assert.equal(result.status, 'complete');
      assert.equal(result.records[0].sha256, index.entries[0].sha256);
    } finally { store.close(); }
  } finally { await source.close(); }
});
