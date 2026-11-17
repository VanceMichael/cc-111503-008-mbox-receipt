import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeLedger, isAuthorized } from '../src/range-ledger.mjs';

const index = {
  archiveId: 'a1', revision: 'r1', etag: '"e"', totalSize: 30,
  entries: [
    { id: 'M1', start: 0, end: 10, sha256: null },
    { id: 'M2', start: 15, end: 25, sha256: null },
  ],
};

test('authorization covers entry bytes but never the gap or the tail', () => {
  const entries = [...index.entries].sort((a, b) => a.start - b.start);
  assert.equal(isAuthorized(0, 9, entries, 30), true);
  assert.equal(isAuthorized(2, 8, entries, 30), true);
  assert.equal(isAuthorized(0, 15, entries, 30), false); // crosses gap 10-14
  assert.equal(isAuthorized(10, 14, entries, 30), false); // the gap itself
  assert.equal(isAuthorized(20, 29, entries, 30), false); // reaches package tail
  assert.equal(isAuthorized(-1, 5, entries, 30), false);
});

test('fragments are placed by declared offsets, independent of arrival order', () => {
  const ledger = new RangeLedger(index);
  assert.deepEqual(ledger.add(5, 9, 30, Buffer.from('56789')), { accepted: true, truncated: false });
  assert.deepEqual(ledger.add(0, 4, 30, Buffer.from('01234')), { accepted: true, truncated: false });
  assert.deepEqual(ledger.missingRanges(index.entries[0]), []);
  assert.deepEqual(ledger.assemble(index.entries[0]), Buffer.from('0123456789'));
});

test('overlapping retransmissions are accepted only when shared bytes match', () => {
  const ledger = new RangeLedger(index);
  assert.equal(ledger.add(0, 9, 30, Buffer.from('0123456789')).accepted, true);
  assert.equal(ledger.add(5, 9, 30, Buffer.from('56789')).accepted, true);
  const conflict = ledger.add(5, 9, 30, Buffer.from('XXXXX'));
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, 'overlap-conflict');
  assert.deepEqual(ledger.assemble(index.entries[0]), Buffer.from('0123456789'));
});

test('a part crossing an unauthorized gap is refused wholesale', () => {
  const ledger = new RangeLedger(index);
  const result = ledger.add(8, 16, 30, Buffer.alloc(9, 0x7a));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'part-exceeds-grant');
  assert.equal(ledger.segments.length, 0);
});

test('wrong package size and size mismatches are refused', () => {
  const ledger = new RangeLedger(index);
  assert.equal(ledger.add(0, 9, 31, Buffer.alloc(10)).reason, 'package-size-mismatch');
  assert.equal(ledger.add(0, 9, 30, Buffer.alloc(11)).reason, 'part-longer-than-declared');
});

test('a truncated part credits only the received prefix and exposes the gap', () => {
  const ledger = new RangeLedger(index);
  const result = ledger.add(0, 9, 30, Buffer.from('01234'));
  assert.deepEqual(result, { accepted: true, truncated: true });
  assert.deepEqual(ledger.missingRanges(index.entries[0]), [[5, 9]]);
  assert.equal(ledger.add(5, 9, 30, Buffer.from('56789')).accepted, true);
  assert.deepEqual(ledger.assemble(index.entries[0]), Buffer.from('0123456789'));
});

test('a merged segment spanning adjacent entries reassembles each entry correctly', () => {
  const adjacent = {
    ...index,
    entries: [
      { id: 'M1', start: 0, end: 10, sha256: null },
      { id: 'M2', start: 10, end: 20, sha256: null },
    ],
  };
  const ledger = new RangeLedger(adjacent);
  assert.equal(ledger.add(0, 19, 30, Buffer.from('0123456789abcdefghij')).accepted, true);
  assert.deepEqual(ledger.assemble(adjacent.entries[0]), Buffer.from('0123456789'));
  assert.deepEqual(ledger.assemble(adjacent.entries[1]), Buffer.from('abcdefghij'));
  assert.deepEqual(ledger.missingRanges(adjacent.entries[0]), []);
});

test('reissue planning only contains still-uncovered authorized offsets', () => {
  const ledger = new RangeLedger(index);
  ledger.add(0, 4, 30, Buffer.from('01234'));
  assert.deepEqual(ledger.missingRanges(index.entries[0]), [[5, 9]]);
  assert.deepEqual(ledger.missingRanges(index.entries[1]), [[15, 24]]);
});
