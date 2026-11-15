import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/samples.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('mbox encapsulation is separate from restored RFC bytes', async () => {
  await run('normal', async result => {
    assert.equal(result.status, 'complete'); assert.equal(result.records.length, 2);
    assert.notEqual(result.records[0].rawSha256, result.records[1].rawSha256);
    assert.ok(result.records[0].rfcText.includes('\nFrom quoted sender line\n>From already quoted sender'));
    assert.ok(result.records[0].end <= result.records[1].start);
  });
});
test('a package with an open tail retains earlier completed originals', async () => {
  await run('open-tail', async result => {
    assert.equal(result.status, 'incomplete'); assert.equal(result.records.filter(row => row.complete).length, 1);
    assert.ok(result.pending.length > 0);
  });
});
test('a reordered package has stable original content identities', async () => {
  let originals;
  await run('normal', async result => { originals = result.records.map(row => row.rawSha256).sort(); });
  await run('reordered', async result => { assert.deepEqual(result.records.map(row => row.rawSha256).sort(), originals); });
});
