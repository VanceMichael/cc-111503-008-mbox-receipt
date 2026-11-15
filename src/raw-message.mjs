export function inspectMessage(bytes) {
  const divider = bytes.indexOf(Buffer.from('\n\n'));
  if (divider < 0) return { status: 'incomplete-headers', headers: [] };
  const lines = bytes.subarray(0, divider).toString('utf8').split('\n');
  const headers = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length) headers.at(-1).value += ' ' + line.trim();
    else {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error('malformed RFC header');
      headers.push({ name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1).trim() });
    }
  }
  return { status: 'headers-ready', headers, bodyOffset: divider + 2, bodyBytes: bytes.length - divider - 2 };
}
