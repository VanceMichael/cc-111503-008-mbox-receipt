import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/samples.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try { await check(await intake.collect(source, store), source, store); }
  finally { store.close(); await source.close(); }
}
test('actual authorized ranges are received even when HTTP parts arrive out of order', async () => {
  await run('normal', async (result, source) => {
    assert.equal(result.status, 'complete'); assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map(row => row.id).sort(), ['M1', 'M2', 'M3']);
    for (const row of result.records) assert.equal(row.sha256, source.index.entries.find(entry => entry.id === row.id).sha256);
    assert.ok(source.requests.length > 0 && source.requests.length <= 2);
    assert.ok(source.requests.every(row => row.ifMatch === source.index.etag && row.range));
  });
});
for (const scenario of ['full-200', 'changed']) {
  test(scenario + ' cannot be treated as authorized receipt', async () => {
    await run(scenario, async result => { assert.notEqual(result.status, 'complete'); assert.equal(result.records.length, 0); });
  });
}
test('truncated response does not claim all original bytes were acquired', async () => {
  await run('truncated', async result => { assert.equal(result.status, 'incomplete'); assert.ok(result.pending.length); });
});
