import { fixture } from './samples.mjs';
import { preview, collect } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await fixture();
const store = new Inbox();
try {
  const previewResult = await preview(source, store);
  const collectResult = await collect(source, store);
  console.log(JSON.stringify({
    preview: previewResult,
    collection: {
      status: collectResult.status,
      records: collectResult.records,
      pending: collectResult.pending,
      diagnostics: collectResult.diagnostics,
    },
    evidence: store.evidence(),
    runs: store.list('collection-runs'),
  }, null, 2));
} finally { store.close(); await source.close(); }
