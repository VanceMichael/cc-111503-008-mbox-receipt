// HTTP multipart/byteranges parsing.
//
// Part boundaries come exclusively from the boundary delimiter declared in the
// HTTP Content-Type header. Bytes belonging to a mail body never decide where a
// part starts or ends: a boundary marker is only recognized at the start of the
// body or immediately after a CRLF, so marker-like sequences embedded in mail
// text are ordinary content.

export function boundaryFromContentType(headerValue) {
  if (!headerValue) return null;
  const match = /boundary=(?:"([^"]*)"|([^;]+))/i.exec(headerValue);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  const boundary = (raw ?? '').trim();
  return boundary.length > 0 ? boundary : null;
}

// Parses `bytes start-end/total`. Returns null for any other shape, including
// unsatisfied-range `bytes */total` responses.
export function parseContentRange(headerValue) {
  if (!headerValue) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(headerValue.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null;
  if (start > end) return null;
  return { start, end, total };
}

function parseHeaderBlock(block) {
  const headers = {};
  for (const line of block.toString('utf8').split('\r\n')) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function findBoundary(body, marker, from) {
  let position = from;
  for (;;) {
    const found = body.indexOf(marker, position);
    if (found < 0) return -1;
    // A real delimiter sits at body start or directly after a CRLF, and the
    // boundary line must end there with CRLF (next part) or "--" (close).
    const atLineStart = found === 0 || (body[found - 2] === 0x0d && body[found - 1] === 0x0a);
    const after = found + marker.length;
    const validLineEnd = (body[after] === 0x0d && body[after + 1] === 0x0a)
      || (body[after] === 0x2d && body[after + 1] === 0x2d);
    if (atLineStart && validLineEnd) return found;
    position = found + 1;
  }
}

// Splits a multipart/byteranges payload into parts without interpreting the
// transported content. Returns:
//   { complete: true, parts }                       when the closing delimiter was seen
//   { complete: false, reason, parts }              on truncation/malformation
// Each part is { headers, body, complete } where complete=false marks the
// final part whose bytes were cut off mid-transport. Its body is the received
// prefix; callers must reconcile it against the declared Content-Range.
export function parseMultipartByteranges(body, boundary) {
  const parts = [];
  const marker = Buffer.from('--' + boundary);
  let cursor = 0;

  let index = findBoundary(body, marker, 0);
  if (index < 0) return { complete: false, reason: 'no-boundary', parts };
  cursor = index + marker.length;

  for (;;) {
    // Closing delimiter line "--boundary--" followed by CRLF. A payload cut
    // before that CRLF (including one ending exactly after the dashes) is
    // truncation, not a well-formed end of the multipart body.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      const afterClose = cursor + 2;
      if (body[afterClose] === 0x0d && body[afterClose + 1] === 0x0a) {
        return { complete: true, parts };
      }
      return { complete: false, reason: 'truncated-close-delimiter', parts };
    }
    // An ordinary boundary line must be followed by CRLF.
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) {
      return { complete: false, reason: 'malformed-boundary-line', parts };
    }
    cursor += 2;

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) {
      // Cut off inside the part headers: the fragment carries no usable range.
      return { complete: false, reason: 'truncated-part-headers', parts };
    }
    const headers = parseHeaderBlock(body.subarray(cursor, headerEnd));
    const bodyStart = headerEnd + 4;

    const nextBoundary = findBoundary(body, marker, bodyStart);
    if (nextBoundary < 0) {
      // Transport ended before a complete next delimiter. Walk back any
      // trailing transport framing (the CRLF before the boundary line, a
      // partial marker, a partial close "--", or a partial CRLF) so bytes of
      // a cut-off boundary line can never inflate the part body. A marker-like
      // sequence is only framing when it starts a line (body start or after
      // CRLF); identical bytes inside mail content stay part of the body.
      let partEnd = body.length;
      for (;;) {
        if (partEnd > bodyStart && body[partEnd - 1] === 0x0d) { partEnd -= 1; continue; }
        if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) { partEnd -= 2; continue; }
        const lineStart = body.lastIndexOf('\r\n', partEnd - 1);
        const candidate = lineStart >= bodyStart ? lineStart + 2 : -1;
        if (candidate < 0 || candidate >= partEnd) break;
        const atLineStart = candidate === bodyStart
          || (body[candidate - 2] === 0x0d && body[candidate - 1] === 0x0a);
        if (!atLineStart) break;
        const tail = body.subarray(candidate, partEnd);
        if (tail.length === 0) break;
        const markerPrefix = tail.length <= marker.length
          && marker.subarray(0, tail.length).equals(tail);
        const closePrefix = tail.length === marker.length + 1
          && marker.equals(tail.subarray(0, marker.length)) && tail[marker.length] === 0x2d;
        if (markerPrefix || closePrefix) partEnd = candidate;
        else break;
      }
      parts.push({ headers, body: body.subarray(bodyStart, partEnd), complete: false });
      return { complete: false, reason: 'truncated-part-body', parts };
    }

    let partEnd = nextBoundary;
    if (partEnd >= bodyStart + 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      partEnd -= 2; // strip the CRLF that belongs to the boundary transport
    }
    parts.push({ headers, body: body.subarray(bodyStart, partEnd), complete: true });
    cursor = nextBoundary + marker.length;
  }
}
