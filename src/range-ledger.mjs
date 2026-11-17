// Byte-level coverage ledger for authorized collection.
//
// The ledger only ever holds bytes that fall inside the authorized index
// entries. It never trusts HTTP part order or part boundaries: every received
// fragment is placed at the absolute offsets declared by its Content-Range.
// Overlapping retransmissions are only accepted where the shared bytes are
// byte-identical.

export function sortedEntries(index) {
  return [...index.entries].sort((a, b) => a.start - b.start);
}

// True when [start, end] is fully covered by the union of authorized entry
// intervals. Any unauthorized gap (including bytes past the last entry) makes
// the whole range ungrantable so callers never pull private bytes "for free".
export function isAuthorized(start, end, entries, totalSize) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  if (start < 0 || end < start) return false;
  if (totalSize !== undefined && (start >= totalSize || end >= totalSize)) return false;
  let cursor = start;
  for (const entry of entries) {
    if (entry.start > cursor) return false; // unauthorized gap ahead
    if (entry.end - 1 >= cursor) cursor = Math.max(cursor, entry.end);
    if (cursor > end) return true;
  }
  return cursor > end;
}

export class RangeLedger {
  constructor(index) {
    this.index = index;
    this.entries = sortedEntries(index);
    // disjoint, start-ordered list of { start, end (exclusive), data }
    this.segments = [];
  }

  // Applies a received fragment. Rejects unauthorized ranges, size mismatches
  // against the declared range, wrong package size and conflicting overlaps.
  add(start, end, totalSize, data) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      return { accepted: false, reason: 'invalid-range' };
    }
    if (totalSize !== this.index.totalSize) return { accepted: false, reason: 'package-size-mismatch' };
    const declaredLength = end - start + 1;
    if (data.length > declaredLength) return { accepted: false, reason: 'part-longer-than-declared' };
    if (!isAuthorized(start, end, this.entries, totalSize)) {
      return { accepted: false, reason: 'part-exceeds-grant' };
    }

    const fragmentEnd = start + data.length; // exclusive
    for (const segment of this.segments) {
      const overlapStart = Math.max(start, segment.start);
      const overlapEnd = Math.min(fragmentEnd, segment.end);
      if (overlapStart >= overlapEnd) continue;
      const incoming = data.subarray(overlapStart - start, overlapEnd - start);
      const existing = segment.data.subarray(overlapStart - segment.start, overlapEnd - segment.start);
      if (!incoming.equals(existing)) return { accepted: false, reason: 'overlap-conflict' };
    }

    // Keep only the still-missing offsets; overlaps were verified identical.
    const fresh = [];
    let cursor = start;
    for (const segment of this.segments) {
      if (segment.end <= cursor) continue;
      if (segment.start >= fragmentEnd) break;
      if (segment.start > cursor) fresh.push([cursor, Math.min(segment.start, fragmentEnd)]);
      cursor = Math.max(cursor, segment.end);
      if (cursor >= fragmentEnd) break;
    }
    if (cursor < fragmentEnd) fresh.push([cursor, fragmentEnd]);
    for (const [freshStart, freshEnd] of fresh) {
      this.segments.push({
        start: freshStart,
        end: freshEnd,
        data: data.subarray(freshStart - start, freshEnd - start),
      });
    }
    this.segments.sort((a, b) => a.start - b.start);
    return { accepted: true, truncated: data.length < declaredLength };
  }

  // Missing closed intervals inside an entry. Adjacent gaps are returned as
  // separate offsets only at entry borders; within an entry gaps are merged.
  missingRanges(entry) {
    const gaps = [];
    let cursor = entry.start;
    for (const segment of this.segments) {
      if (segment.end <= cursor) continue;
      if (segment.start >= entry.end) break;
      if (segment.start > cursor) gaps.push([cursor, Math.min(segment.start, entry.end) - 1]);
      cursor = Math.max(cursor, segment.end);
      if (cursor >= entry.end) break;
    }
    if (cursor < entry.end) gaps.push([cursor, entry.end - 1]);
    return gaps;
  }

  // Reassembles an entry only from ledger bytes; callers verify the digest
  // afterwards so a wrong reconstruction can never be reported as received.
  // A single segment may span several adjacent entries, so offsets must be
  // translated relative to both the entry and the segment.
  assemble(entry) {
    const length = entry.end - entry.start;
    const output = Buffer.allocUnsafe(length);
    let cursor = entry.start;
    for (const segment of this.segments) {
      if (segment.end <= cursor) continue;
      if (segment.start >= entry.end) break;
      if (segment.start > cursor) return null; // uncovered gap inside the entry
      const copyEnd = Math.min(segment.end, entry.end);
      segment.data.copy(
        output,
        cursor - entry.start,
        cursor - segment.start,
        copyEnd - segment.start,
      );
      cursor = copyEnd;
      if (cursor === entry.end) return output;
    }
    return cursor === entry.end ? output : null;
  }
}
