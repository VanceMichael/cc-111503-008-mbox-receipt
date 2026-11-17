import { createHash } from 'node:crypto';
import { RangeLedger } from './range-ledger.mjs';
import { boundaryFromContentType, parseContentRange, parseMultipartByteranges } from './multipart.mjs';

const REQUEST_BUDGET = 2;
const MAX_RANGES_PER_REQUEST = 4;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Plans the next request: only offsets still missing, capped at 4 ranges.
// Every emitted range is a subset of the authorized entry intervals and never
// crosses an unauthorized gap.
function planRanges(ledger, entries) {
  const ranges = [];
  for (const entry of entries) {
    for (const [start, end] of ledger.missingRanges(entry)) {
      ranges.push({ start, end });
      if (ranges.length === MAX_RANGES_PER_REQUEST) return ranges;
    }
  }
  return ranges;
}

export async function collect(source, store) {
  const index = source.index;
  const entries = [...index.entries].sort((a, b) => a.start - b.start);
  const ledger = new RangeLedger(index);
  const diagnostics = [];

  // The grant itself is retained as evidence before any byte is requested.
  store.saveEvidence('authorization-index', {
    archiveId: index.archiveId, revision: index.revision, etag: index.etag, totalSize: index.totalSize,
  }, Buffer.from(JSON.stringify(index)));

  for (let requestNo = 1; requestNo <= REQUEST_BUDGET; requestNo++) {
    const ranges = planRanges(ledger, entries);
    if (ranges.length === 0) break;

    const rangeHeader = 'bytes=' + ranges.map(range => `${range.start}-${range.end}`).join(',');
    let response;
    try {
      response = await fetch(source.url + source.path, {
        headers: { Range: rangeHeader, 'If-Match': index.etag },
      });
    } catch (error) {
      diagnostics.push({ code: 'request-failed', request: requestNo, message: error.message });
      break;
    }

    const rawBody = Buffer.from(await response.arrayBuffer());
    store.saveEvidence('http-exchange', {
      request: requestNo, range: rangeHeader, ifMatch: index.etag,
      status: response.status, contentType: response.headers.get('content-type'),
    }, rawBody);

    if (response.status === 412) {
      diagnostics.push({ code: 'etag-changed', request: requestNo, etag: response.headers.get('etag') });
      break; // package revision moved: no byte from this answer may be accepted
    }
    if (response.status === 200) {
      diagnostics.push({ code: 'full-package-200', request: requestNo, bytes: rawBody.length });
      break; // a 200 offers the whole mailbox; the grant never authorizes that
    }
    if (response.status !== 206) {
      diagnostics.push({ code: 'unexpected-status', request: requestNo, status: response.status });
      break;
    }
    if (response.headers.get('etag') && response.headers.get('etag') !== index.etag) {
      diagnostics.push({ code: 'etag-changed', request: requestNo, etag: response.headers.get('etag') });
      break;
    }

    const contentType = response.headers.get('content-type') || '';
    let parts;
    if (contentType.toLowerCase().includes('multipart/byteranges')) {
      const boundary = boundaryFromContentType(contentType);
      if (!boundary) {
        diagnostics.push({ code: 'missing-boundary', request: requestNo });
        continue;
      }
      const parsed = parseMultipartByteranges(rawBody, boundary);
      parts = parsed.parts;
      if (!parsed.complete) diagnostics.push({ code: 'multipart-' + parsed.reason, request: requestNo });
    } else {
      // Single-range 206: same coverage/grant rules as a multipart part.
      parts = [{ headers: { 'content-range': response.headers.get('content-range') || '' }, body: rawBody, complete: true }];
    }

    for (const part of parts) {
      const declared = parseContentRange(part.headers['content-range']);
      if (!declared) {
        diagnostics.push({ code: 'invalid-content-range', request: requestNo, header: part.headers['content-range'] ?? null });
        continue;
      }
      const result = ledger.add(declared.start, declared.end, declared.total, part.body);
      if (!result.accepted) {
        diagnostics.push({ code: result.reason, request: requestNo, declared: { start: declared.start, end: declared.end } });
        continue;
      }
      if (result.truncated) {
        diagnostics.push({
          code: 'part-truncated', request: requestNo,
          declared: { start: declared.start, end: declared.end }, receivedBytes: part.body.length,
        });
      }
    }
  }

  const records = [];
  const pending = [];

  for (const entry of entries) {
    const missing = ledger.missingRanges(entry);
    if (missing.length > 0) {
      pending.push({ id: entry.id, missing: missing.map(([start, end]) => ({ start, end })) });
      continue;
    }
    const bytes = ledger.assemble(entry);
    if (!bytes) {
      pending.push({ id: entry.id, missing: 'reassembly-failed' });
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== entry.sha256) {
      diagnostics.push({ code: 'digest-mismatch', id: entry.id, expected: entry.sha256, actual });
      pending.push({ id: entry.id, missing: 'digest-mismatch' });
      continue;
    }
    const evidenceId = store.saveEvidence('mail-original', {
      id: entry.id, archiveId: index.archiveId, revision: index.revision, start: entry.start, end: entry.end, sha256: actual,
    }, bytes);
    records.push({ id: entry.id, sha256: actual, start: entry.start, end: entry.end, bytes: bytes.length, evidence: evidenceId });
  }

  const status = pending.length === 0 ? 'complete' : 'incomplete';
  store.put('collection-runs', `${index.archiveId}:${index.revision}`, {
    status, requestedAt: new Date().toISOString(),
    records: records.map(record => record.id), pending: pending.map(item => item.id), diagnostics,
  });

  return { status, records, pending, diagnostics };
}
