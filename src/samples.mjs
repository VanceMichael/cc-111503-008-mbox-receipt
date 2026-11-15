import { digest } from './store.mjs';

const first = `From sender@example.test Sun Nov 15 08:00:00 2026
Message-ID: <reused@example.test>
Subject: Service request
Content-Type: text/plain; charset=utf-8

Please visit our service point.
>From quoted sender line
>>From already quoted sender
中文说明
`;
const second = `From other@example.test Sun Nov 15 09:00:00 2026
Message-ID: <reused@example.test>
Subject: Follow up

Different original with same Message-ID.
`;

export async function fixture(scenario = 'normal') {
  let bytes = Buffer.from(scenario === 'reordered' ? second + first : first + second);
  const original = bytes;
  if (scenario === 'open-tail') bytes = bytes.subarray(0, bytes.length - 12);
  return { bytes, receipt: { archiveId: 'hotline-1', revision: scenario === 'reordered' ? 'r2' : 'r1',
    byteLength: original.length, sha256: digest(original), sealed: scenario !== 'open-tail' },
    async * chunks() { for (let offset = 0; offset < bytes.length; offset += 11) yield bytes.subarray(offset, offset + 11); },
    close: async () => {} };
}
