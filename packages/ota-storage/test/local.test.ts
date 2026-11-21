import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalObjectStore, openStore, PreconditionFailedError } from '../src/index.ts';

const opts = { contentType: 'application/json', cacheControl: 'no-cache' };

async function fresh(): Promise<LocalObjectStore> {
  return new LocalObjectStore(await mkdtemp(path.join(tmpdir(), 'ota-store-')));
}

test('없는 키는 null, 쓴 뒤에는 내용과 etag 를 돌려준다', async () => {
  const store = await fresh();
  assert.equal(await store.get('manifests/prod.json'), null);
  const { etag } = await store.put('manifests/prod.json', Buffer.from('{"a":1}'), opts);
  const got = await store.get('manifests/prod.json');
  assert.equal(got!.body.toString(), '{"a":1}');
  assert.equal(got!.etag, etag);
});

test('ifMatch:null 은 이미 있으면 실패한다 (처음 만드는 쪽만 이긴다)', async () => {
  const store = await fresh();
  await store.put('k', Buffer.from('1'), { ...opts, ifMatch: null });
  await assert.rejects(store.put('k', Buffer.from('2'), { ...opts, ifMatch: null }), PreconditionFailedError);
});

test('ifMatch 는 etag 가 바뀌었으면 실패한다 (lost update 방지)', async () => {
  const store = await fresh();
  const { etag } = await store.put('k', Buffer.from('v1'), opts);
  await store.put('k', Buffer.from('v2'), { ...opts, ifMatch: etag });
  await assert.rejects(store.put('k', Buffer.from('v3'), { ...opts, ifMatch: etag }), PreconditionFailedError);
  assert.equal((await store.get('k'))!.body.toString(), 'v2');
});

test('같은 etag 로 동시에 쓰면 정확히 하나만 성공한다', async () => {
  const store = await fresh();
  const { etag } = await store.put('k', Buffer.from('base'), opts);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => store.put('k', Buffer.from(`w${i}`), { ...opts, ifMatch: etag })),
  );
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

test('저장소 밖을 가리키는 키는 거부한다', async () => {
  const store = await fresh();
  await assert.rejects(store.put('../escape', Buffer.from('x'), opts), /저장소 밖/);
  await assert.rejects(store.get('../../etc/passwd'), /저장소 밖/);
});

test('openStore 는 주소 형식으로 구현을 고른다', () => {
  assert.match(openStore('local:./tmp-store').description, /^local:/);
  assert.equal(openStore('s3://my-bucket/ota').description, 's3://my-bucket/ota');
  assert.throws(() => openStore('ftp://x'), /모르는 저장소/);
});
