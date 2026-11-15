import { digest } from './store.mjs';
import { serve } from './http.mjs';

export async function fixture(scenario = 'normal') {
  const first = Buffer.from('Message-ID: <one@example.test>\nSubject: first\n\nFrom body text\n');
  const privateMail = Buffer.from('Message-ID: <not-authorized@example.test>\n\nprivate department\n');
  const second = Buffer.from('Message-ID: <two@example.test>\nSubject: second\n\n中文原件\n');
  const bytes = Buffer.concat([first, privateMail, second]);
  const index = { archiveId: 'mail-1', revision: 'r1', etag: '"mail-r1"', totalSize: bytes.length,
    entries: [{ id: 'M1', start: 0, end: first.length, sha256: digest(first) },
      { id: 'M2', start: first.length + privateMail.length, end: bytes.length, sha256: digest(second) }] };
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
    if (ranges.length > 4 || ranges.some(([start, end]) => !index.entries.some(entry => start >= entry.start && end < entry.end && start <= end))) {
      response.writeHead(403); return response.end('range exceeds department grant');
    }
    const boundary = 'mail-grant-boundary';
    response.writeHead(206, { 'content-type': 'multipart/byteranges; boundary="' + boundary + '"', etag: index.etag });
    const parts = [];
    for (const [start, end] of [...ranges].reverse()) {
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
