import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryFromContentType, parseContentRange, parseMultipartByteranges } from '../src/multipart.mjs';

test('boundary is read from the HTTP header, quoted or bare', () => {
  assert.equal(boundaryFromContentType('multipart/byteranges; boundary="abc"'), 'abc');
  assert.equal(boundaryFromContentType('multipart/byteranges; boundary=abc'), 'abc');
  assert.equal(boundaryFromContentType('multipart/byteranges'), null);
  assert.equal(boundaryFromContentType('multipart/byteranges; boundary=""'), null);
});

test('content-range parsing rejects unsatisfied-range and malformed headers', () => {
  assert.deepEqual(parseContentRange('bytes 10-19/100'), { start: 10, end: 19, total: 100 });
  assert.equal(parseContentRange('bytes */100'), null);
  assert.equal(parseContentRange('items 10-19/100'), null);
  assert.equal(parseContentRange(null), null);
});

function build(boundary, parts, { close = true } = {}) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    for (const [name, value] of Object.entries(part.headers)) {
      chunks.push(Buffer.from(`${name}: ${value}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'), part.body, Buffer.from('\r\n'));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('parts split on declared delimiters regardless of part order', () => {
  const body = build('bnd', [
    { headers: { 'Content-Range': 'bytes 20-24/100' }, body: Buffer.from('20-24') },
    { headers: { 'Content-Range': 'bytes 0-9/100' }, body: Buffer.from('0123456789') },
  ]);
  const parsed = parseMultipartByteranges(body, 'bnd');
  assert.equal(parsed.complete, true);
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0].headers['content-range'], 'bytes 20-24/100');
  assert.deepEqual(parsed.parts[1].body, Buffer.from('0123456789'));
});

test('boundary-like bytes inside mail content do not create parts', () => {
  const mail = Buffer.concat([
    Buffer.from('Subject: report\r\n\r\nsee delimiter --bnd inside body'),
    Buffer.from('\r\n--bnd which is only mail text'),
  ]);
  const body = build('bnd', [
    { headers: { 'Content-Range': 'bytes 0-' + (mail.length - 1) + '/100' }, body: mail },
    { headers: { 'Content-Range': 'bytes 50-51/100' }, body: Buffer.from('xy') },
  ]);
  const parsed = parseMultipartByteranges(body, 'bnd');
  assert.equal(parsed.complete, true);
  assert.equal(parsed.parts.length, 2);
  assert.deepEqual(parsed.parts[0].body, mail);
  assert.deepEqual(parsed.parts[1].body, Buffer.from('xy'));
});

test('a marker followed by extra text is mail content, even at line start', () => {
  const mail = Buffer.from('line1\r\n--bnd not a boundary\r\n--bndx suffix\r\nend');
  const body = build('bnd', [
    { headers: { 'Content-Range': 'bytes 0-' + (mail.length - 1) + '/100' }, body: mail },
    { headers: { 'Content-Range': 'bytes 80-81/100' }, body: Buffer.from('zz') },
  ]);
  const parsed = parseMultipartByteranges(body, 'bnd');
  assert.equal(parsed.complete, true);
  assert.equal(parsed.parts.length, 2);
  assert.deepEqual(parsed.parts[0].body, mail);
  // No truncation view may borrow bytes of a half-arrived boundary line.
  for (let size = 1; size < body.length; size++) {
    const prefix = parseMultipartByteranges(body.subarray(0, size), 'bnd');
    for (const part of prefix.parts) {
      if (!part.headers['content-range']) continue;
      const finalPart = parsed.parts.find(row =>
        row.headers['content-range'] === part.headers['content-range']);
      assert.ok(finalPart.body.subarray(0, part.body.length).equals(part.body));
    }
  }
});

test('a cut-off transport keeps the received prefix and marks it incomplete', () => {
  const full = build('bnd', [
    { headers: { 'Content-Range': 'bytes 0-9/100' }, body: Buffer.from('0123456789') },
    { headers: { 'Content-Range': 'bytes 20-29/100' }, body: Buffer.from('abcdefghij') },
  ]);
  const cut = full.subarray(0, full.indexOf(Buffer.from('abcdefghij')) + 4);
  const parsed = parseMultipartByteranges(cut, 'bnd');
  assert.equal(parsed.complete, false);
  assert.equal(parsed.reason, 'truncated-part-body');
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0].complete, true);
  assert.equal(parsed.parts[1].complete, false);
  assert.deepEqual(parsed.parts[1].body, Buffer.from('abcd'));
});

test('parsing depends on the complete payload, never on network chunk boundaries', () => {
  const full = build('bnd', [
    { headers: { 'Content-Range': 'bytes 0-4/100' }, body: Buffer.from('hello') },
    { headers: { 'Content-Range': 'bytes 10-14/100' }, body: Buffer.from('world') },
  ]);
  const whole = parseMultipartByteranges(full, 'bnd');
  assert.equal(whole.complete, true);
  // Simulate the server flushing one byte at a time into a growing buffer.
  // No prefix may ever invent a part or yield bodies that contradict the
  // final parse; partial views are simply marked incomplete.
  let prefix = Buffer.alloc(0);
  for (let size = 1; size < full.length; size++) {
    prefix = full.subarray(0, size);
    const parsed = parseMultipartByteranges(prefix, 'bnd');
    assert.equal(parsed.complete, false);
    for (const part of parsed.parts) {
      // Fragments cut inside a header block carry no declared range yet and
      // are not data parts; only compare parts with an identity.
      if (!part.headers['content-range']) continue;
      const index = whole.parts.findIndex(finalPart =>
        finalPart.headers['content-range'] === part.headers['content-range']);
      assert.ok(index >= 0, 'partial part must correspond to a final part');
      const finalBody = whole.parts[index].body;
      assert.ok(finalBody.subarray(0, part.body.length).equals(part.body),
        'partial part body must be a prefix of the final part body');
    }
  }
  const finalParse = parseMultipartByteranges(full, 'bnd');
  assert.deepEqual(finalParse.parts.map(part => part.body), whole.parts.map(part => part.body));
});
