// 严格的 multipart/byteranges 解析器。
// boundary 只来自 HTTP 响应头；邮件正文中出现的相似字节不会被当成分界，
// 只有满足 RFC 2046 换行前缀的 boundary 行才是合法分界。
// 网络分块在进入本模块前已经拼成完整 body，因此 TCP 分段与部分边界无关。

const CRLF = Buffer.from('\r\n');

export function boundaryFromContentType(contentType) {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return null;
  const boundary = (match[1] ?? match[2]).trim();
  return boundary.length ? boundary : null;
}

function findDelimiters(body, boundary) {
  const marker = Buffer.concat([CRLF, Buffer.from('--' + boundary)]);
  const standalone = Buffer.from('--' + boundary);
  const hits = [];
  let index = 0;
  while (index < body.length) {
    const at = body.indexOf(marker, index);
    if (at < 0) break;
    const after = at + marker.length;
    const closing = body.subarray(after, after + 2).equals(Buffer.from('--'));
    const lineEnd = body.indexOf(CRLF, after);
    // 分界行只允许 "--" 收尾或直接以 CRLF 结束；其余字节说明这只是内容碰撞。
    const legal = closing || lineEnd === after;
    if (legal) hits.push({ at, after: closing ? after + 2 : lineEnd + 2, closing });
    index = after;
  }
  // 报文以分界行开头时没有前置 CRLF，单独识别第一个分界。
  if (body.subarray(0, standalone.length).equals(standalone)) {
    const after = standalone.length;
    const closing = body.subarray(after, after + 2).equals(Buffer.from('--'));
    const lineEnd = body.indexOf(CRLF, after);
    if (closing || lineEnd === after) {
      hits.unshift({ at: 0, after: closing ? after + 2 : lineEnd + 2, closing });
    }
  }
  hits.sort((left, right) => left.at - right.at);
  return hits;
}

// 解析单个部分的头/体分块，返回 { headers, payload } 或 null（畸形部分）。
function parsePart(block) {
  const headerEnd = block.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd < 0) return null;
  const headerText = block.subarray(0, headerEnd).toString('latin1');
  const headers = {};
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    headers[line.slice(0, colon).toLowerCase().trim()] = line.slice(colon + 1).trim();
  }
  const payload = block.subarray(headerEnd + 4);
  return { headers, payload };
}

// 返回 { parts: [{start,end,total,data}], truncated, problems }。
// 截断（缺少闭合分界、最后一部分不完整）时 truncated 为 true，
// 只有以完整分界行收尾的部分才会被返回。
export function parseMultipart(body, boundary) {
  const result = { parts: [], truncated: false, problems: [] };
  const delimiters = findDelimiters(body, boundary);
  if (!delimiters.length) {
    result.truncated = true;
    result.problems.push('no legal multipart boundary found in response body');
    return result;
  }
  for (let i = 0; i < delimiters.length - 1; i++) {
    const current = delimiters[i];
    const next = delimiters[i + 1];
    if (current.closing) {
      result.problems.push('ignored bytes after the closing boundary');
      break;
    }
    let block = body.subarray(current.after, next.at);
    // 部分与下一分界之间按 RFC 2046 有一个 CRLF 分隔。
    if (block.length >= 2 && block.subarray(block.length - 2).equals(CRLF)) {
      block = block.subarray(0, block.length - 2);
    }
    const parsed = parsePart(block);
    if (!parsed) {
      result.problems.push('skipped part with malformed part headers');
      continue;
    }
    const range = parseContentRange(parsed.headers['content-range']);
    if (!range) {
      result.problems.push('skipped part without a valid Content-Range header');
      continue;
    }
    result.parts.push({ ...range, data: parsed.payload });
  }
  if (!delimiters.some(delimiter => delimiter.closing)) {
    result.truncated = true;
    result.problems.push('response ended before the multipart closing boundary');
  }
  return result;
}

// 解析 "bytes start-end/total"（RFC 7233），畸形声明返回 null。
export function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec((value ?? '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null;
  if (start > end) return null;
  return { start, end, total };
}
