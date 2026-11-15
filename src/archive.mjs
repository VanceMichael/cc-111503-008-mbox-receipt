import { digest } from './store.mjs';

export async function preview(source, store) {
  const actual = digest(source.bytes);
  const evidence = store.saveEvidence('mbox-package', { archiveId: source.receipt.archiveId, revision: source.receipt.revision }, source.bytes);
  return { mode: 'archive-preview', evidence, bytes: source.bytes.length,
    envelopeCandidates: source.bytes.toString('utf8').split('\n').filter(line => line.startsWith('From ')).length,
    receiptMatched: actual === source.receipt.sha256 && source.bytes.length === source.receipt.byteLength,
    sealed: source.receipt.sealed };
}
