import { digest } from './store.mjs';
import { serve } from './http.mjs';

export async function fixture(scenario = 'normal') {
  const first = Buffer.from('Message-ID: <one@example.test>\nSubject: first\n\nFrom body text\n');
  const adjacent = Buffer.from('Message-ID: <adjacent@example.test>\nSubject: adjacent grant\n\nauthorized\n');
  const privateMail = Buffer.from('Message-ID: <not-authorized@example.test>\n\nprivate department\n');
  const second = Buffer.from('Message-ID: <two@example.test>\nSubject: second\n\n中文原件\n');
  const bytes = Buffer.concat([first, adjacent, privateMail, second]);
  const index = { archiveId: 'mail-1', revision: 'r1', etag: '"mail-r1"', totalSize: bytes.length,
    entries: [{ id: 'M1', start: 0, end: first.length, sha256: digest(first) },
      { id: 'M2', start: first.length, end: first.length + adjacent.length, sha256: digest(adjacent) },
      { id: 'M3', start: first.length + adjacent.length + privateMail.length, end: bytes.length, sha256: digest(second) }] };
  const requests = [];
  const source = await serve(async (request, response) => {
    requests.push({ range: request.headers.range || null, ifMatch: request.headers['if-match'] || null });
    if (requests.length > 2) { response.writeHead(429); return response.end('body request budget exhausted'); }
    if (scenario === 'changed') { response.writeHead(412, { etag: '"mail-r2"' }); return response.end(); }
    if (request.headers['if-match'] !== index.etag) { response.writeHead(412); return response.end(); }
    if (scenario === 'full-200') { response.writeHead(200, { etag: index.etag }); return response.end(bytes); }
    const raw = request.headers.range?.match(/^bytes=(.*)$/)?.[1];
    if (!raw) { response.writeHead(416); return response.end(); }
    const ranges = raw.split(',').map(value => value.trim().split('-').map(Number));
    const permitted = ([start, end]) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return false;
      let covered = start;
      for (const entry of index.entries) {
        if (entry.start > covered) break;
        if (entry.end > covered) covered = entry.end;
        if (covered > end) return true;
      }
      return false;
    };
    if (ranges.length > 4 || ranges.some(range => !permitted(range))) {
      response.writeHead(403); return response.end('range exceeds department grant');
    }
    if (ranges.length === 1) {
      const [start, end] = ranges[0];
      response.writeHead(206, { 'content-type': 'message/rfc822', 'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: index.etag });
      const content = bytes.subarray(start, end + 1);
      return response.end(scenario === 'truncated' ? content.subarray(0, -2) : content);
    }
    const boundary = 'mail-grant-boundary';
    response.writeHead(206, { 'content-type': 'multipart/byteranges; boundary="' + boundary + '"', etag: index.etag });
    const parts = [];
    const merged = [];
    for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    for (const [start, end] of merged.reverse()) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Type: message/rfc822\r\nContent-Range: bytes ${start}-${end}/${bytes.length}\r\n\r\n`));
      parts.push(bytes.subarray(start, end + 1), Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    let wire = Buffer.concat(parts);
    if (scenario === 'truncated') wire = wire.subarray(0, Math.floor(wire.length * 0.65));
    for (let offset = 0; offset < wire.length; offset += 9) {
      response.write(wire.subarray(offset, offset + 9)); await new Promise(resolve => setImmediate(resolve));
    }
    response.end();
  });
  return { ...source, path: '/archive', index, requests, bytes,
    receipt: { archiveId: 'mail-1', revision: 'r1', byteLength: bytes.length, sha256: digest(bytes), sealed: true } };
}
