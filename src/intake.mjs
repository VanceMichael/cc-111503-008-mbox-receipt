import { createHash } from 'node:crypto';
import { digest } from './store.mjs';
import { CoverageLedger, missingIntervals } from './coverage-ledger.mjs';
import { boundaryFromContentType, parseContentRange, parseMultipart } from './multipart.mjs';

export { preview } from './archive.mjs';

const REQUEST_BUDGET = 2;
const MAX_RANGES_PER_REQUEST = 4;

function validateIndex(index) {
  if (!index || typeof index !== 'object') throw new Error('authorization index is missing');
  const { archiveId, revision, etag, totalSize, entries } = index;
  if (!archiveId || !revision || !etag) throw new Error('authorization index lacks archive identity fields');
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) throw new Error('authorization index has an invalid totalSize');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('authorization index has no entries');
  let cursor = 0;
  for (const entry of entries) {
    if (!entry.id || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`entry ${entry.id ?? '<unknown>'} has an invalid digest declaration`);
    }
    const { start, end } = entry;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > totalSize || start >= end) {
      throw new Error(`entry ${entry.id} declares an invalid byte span`);
    }
    if (start < cursor) throw new Error(`entry ${entry.id} overlaps another authorized entry`);
    cursor = end;
  }
}

// 按授权索引一次领取多个字节区间的收件流程。
// 全程只通过受限 HTTP 来源取件，绝不读取 source.bytes 整包。
export async function collect(source, store) {
  validateIndex(source.index);
  const index = source.index;
  const diagnostics = [];
  const pushDiagnostic = (code, message, extra = {}) => diagnostics.push({ code, message, ...extra });

  // 授权索引本身作为交接证据保留。
  const indexEvidence = store.saveEvidence(
    'authorization-index',
    { archiveId: index.archiveId, revision: index.revision, etag: index.etag, totalSize: index.totalSize,
      entries: index.entries.map(({ id, start, end, sha256 }) => ({ id, start, end, sha256 })) },
    Buffer.from(JSON.stringify(index)),
  );

  const ledger = new CoverageLedger(index.entries.map(entry => [entry.start, entry.end - 1]));
  const records = [];
  const recorded = new Set();
  let hardRejection = false;

  function assessEntries() {
    for (const entry of index.entries) {
      if (recorded.has(entry.id)) continue;
      const gaps = missingIntervals(ledger.coverage, entry.start, entry.end - 1);
      if (gaps.length) continue;
      const bytes = ledger.slice(entry.start, entry.end - 1);
      const actual = digest(bytes);
      if (actual !== entry.sha256) {
        pushDiagnostic('digest-mismatch',
          `entry ${entry.id} is fully covered but its sha256 does not match the index`,
          { id: entry.id, expected: entry.sha256, actual });
        continue;
      }
      const evidenceId = store.saveEvidence(
        'received-original',
        { id: entry.id, archiveId: index.archiveId, revision: index.revision, start: entry.start, end: entry.end, sha256: actual },
        bytes,
      );
      recorded.add(entry.id);
      records.push({ id: entry.id, start: entry.start, end: entry.end, bytes: bytes.length, sha256: actual, evidenceId });
    }
  }

  async function ingestPart(part, requestNo) {
    if (part.total !== index.totalSize) {
      pushDiagnostic('package-size-mismatch',
        'part declares a package size different from the authorized index',
        { requestNo, declared: part.total, expected: index.totalSize });
      return;
    }
    try {
      ledger.add(part.start, part.end, part.data);
    } catch (error) {
      pushDiagnostic(error.code, `${error.message} (request ${requestNo}, bytes ${part.start}-${part.end})`, { requestNo });
      if (error.code === 'outside-authorization') hardRejection = true;
    }
  }

  for (let requestNo = 1; requestNo <= REQUEST_BUDGET; requestNo++) {
    assessEntries();
    // 补领只请求尚无可信覆盖的授权区间，绝不把未授权空隙并入请求。
    const wanted = [];
    for (const entry of index.entries) {
      if (recorded.has(entry.id)) continue;
      for (const [start, end] of missingIntervals(ledger.coverage, entry.start, entry.end - 1)) {
        wanted.push([start, end]);
      }
    }
    if (!wanted.length) break;
    const ranges = wanted.slice(0, MAX_RANGES_PER_REQUEST);
    const rangeHeader = 'bytes=' + ranges.map(([start, end]) => `${start}-${end}`).join(',');

    let response;
    try {
      response = await fetch(source.url + (source.path ?? '/archive'), {
        headers: { Range: rangeHeader, 'If-Match': index.etag },
      });
    } catch (error) {
      pushDiagnostic('network-error', `range request failed before a response was received: ${error.message}`, { requestNo });
      break;
    }

    // 普通 200 表示来源无视 Range 回整包，不能据此收下任何原件。
    if (response.status === 200) {
      await response.arrayBuffer().catch(() => undefined);
      hardRejection = true;
      pushDiagnostic('full-package-200', 'source returned the whole package instead of authorized byte ranges', { requestNo });
      break;
    }
    if (response.status === 412) {
      hardRejection = true;
      pushDiagnostic('version-conflict',
        'If-Match precondition failed: the package revision no longer matches the authorized index',
        { requestNo, etag: response.headers.get('etag') });
      break;
    }
    if (response.status !== 206) {
      await response.arrayBuffer().catch(() => undefined);
      pushDiagnostic('unexpected-status', `source answered with status ${response.status}`, { requestNo, status: response.status });
      break;
    }
    if (response.headers.get('etag') !== index.etag) {
      hardRejection = true;
      pushDiagnostic('version-conflict', '206 response ETag does not match the authorized index',
        { requestNo, etag: response.headers.get('etag') });
      break;
    }

    const wire = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    store.saveEvidence(
      'http-exchange',
      { requestNo, path: source.path ?? '/archive', range: rangeHeader, ifMatch: index.etag,
        status: 206, contentType, bytes: wire.length },
      wire,
    );

    if (/multipart\/byteranges/i.test(contentType)) {
      const boundary = boundaryFromContentType(contentType);
      if (!boundary) {
        pushDiagnostic('malformed-multipart', 'multipart response does not declare a boundary', { requestNo });
        break;
      }
      const parsed = parseMultipart(wire, boundary);
      for (const problem of parsed.problems) pushDiagnostic('multipart-parse', problem, { requestNo });
      if (parsed.truncated) pushDiagnostic('transfer-truncated', 'multipart response ended before all parts were framed', { requestNo });
      // 不按部分先后配给：每个部分都凭自身声明的实际范围独立核对。
      for (const part of parsed.parts) await ingestPart(part, requestNo);
    } else {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range) {
        pushDiagnostic('malformed-single-part', 'single-range 206 response lacks a valid Content-Range header', { requestNo });
        break;
      }
      await ingestPart({ ...range, data: wire }, requestNo);
      if (wire.length !== range.end - range.start + 1) {
        pushDiagnostic('transfer-truncated',
          'single-range body is shorter or longer than its declared Content-Range',
          { requestNo, declared: range.end - range.start + 1, received: wire.length });
      }
    }
  }

  assessEntries();

  const recordsById = new Map(records.map(record => [record.id, record]));
  const pending = [];
  for (const entry of index.entries) {
    if (recordsById.has(entry.id)) continue;
    const missing = missingIntervals(ledger.coverage, entry.start, entry.end - 1).map(([start, end]) => ({ start, end }));
    pending.push({ id: entry.id, start: entry.start, end: entry.end, sha256: entry.sha256, missing,
      reason: missing.length ? 'authorized bytes not yet covered' : 'covered bytes failed index digest verification' });
  }

  let status;
  if (!pending.length) status = 'complete';
  else if (records.length > 0) status = 'incomplete';
  else status = hardRejection ? 'rejected' : 'incomplete';

  const result = { status, records, pending, diagnostics, evidence: { indexEvidence } };
  store.put('collection-runs', `${index.archiveId}:${index.revision}`, {
    status, archiveId: index.archiveId, revision: index.revision, etag: index.etag,
    records: records.map(({ id, sha256, evidenceId }) => ({ id, sha256, evidenceId })),
    pending: pending.map(({ id, missing }) => ({ id, missing })),
    diagnostics,
  });
  return result;
}
