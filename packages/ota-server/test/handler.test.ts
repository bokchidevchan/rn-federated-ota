import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addRelease, emptyManifest, promote } from '@rn-federated-ota/core';
import { LocalObjectStore } from '@rn-federated-ota/storage';

import { createResolveHandler } from '../src/handler.ts';

const RT = 'rn0.76.9-aaaaaaaaaaaa';

async function setup() {
  const store = new LocalObjectStore(await mkdtemp(path.join(tmpdir(), 'ota-srv-')));
  const t = new Date('2026-01-01T00:00:00Z');
  let m = emptyManifest('prod', t);
  m = addRelease(m, 'featureCart', {
    id: 'r1',
    runtimeVersion: RT,
    platforms: { android: [{ path: 'featureCart.container.js.bundle', sha256: 'x', size: 1 }] },
    createdAt: t.toISOString(),
  }, t);
  m = promote(m, 'featureCart', 'r1', t);
  await store.put('manifests/prod.json', Buffer.from(JSON.stringify(m)), { contentType: 'application/json', cacheControl: 'no-cache' });
  return store;
}

const get = (query: Record<string, string>) => ({ method: 'GET', path: '/api/resolve', query });
const ok = { channel: 'prod', platform: 'android', runtimeVersion: RT, userId: 'user-1' };

test('정상 요청은 피처별 해석 결과를 주고, CDN 캐시를 막는다', async () => {
  const handle = createResolveHandler({ store: await setup() });
  const res = await handle(get(ok));
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  const body = JSON.parse(res.body);
  assert.deepEqual(body.features.featureCart, {
    releaseId: 'r1',
    track: 'stable',
    basePath: 'releases/featureCart/r1/android/',
  });
});

test('없는 채널은 빈 features 로 답한다 (앱은 원격 피처 없이 뜬다)', async () => {
  const handle = createResolveHandler({ store: await setup() });
  const res = await handle(get({ ...ok, channel: 'beta' }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).features, {});
});

test('입력 검증: 형식이 틀리면 400', async () => {
  const handle = createResolveHandler({ store: await setup() });
  const cases: [Record<string, string>, string][] = [
    [{ ...ok, platform: 'web' }, 'bad_platform'],
    [{ ...ok, channel: '../etc' }, 'bad_channel'],
    [{ ...ok, userId: 'a b' }, 'bad_user_id'],
    [{ ...ok, userId: 'x'.repeat(200) }, 'bad_user_id'],
    [{ ...ok, runtimeVersion: '' }, 'bad_runtime_version'],
  ];
  for (const [query, error] of cases) {
    const res = await handle(get(query));
    assert.equal(res.status, 400, error);
    assert.equal(JSON.parse(res.body).error, error);
  }
});

test('경로와 메서드가 다르면 404, 405', async () => {
  const handle = createResolveHandler({ store: await setup() });
  assert.equal((await handle({ ...get(ok), path: '/api/other' })).status, 404);
  assert.equal((await handle({ ...get(ok), method: 'POST' })).status, 405);
});

test('매니페스트 캐시는 정한 시간 동안만 유지된다', async () => {
  const store = await setup();
  let clock = 0;
  let reads = 0;
  const counting = { ...store, description: store.description, get: (k: string) => { reads++; return store.get(k); }, put: store.put.bind(store) };
  const handle = createResolveHandler({ store: counting, cacheMs: 1000, now: () => clock });
  await handle(get(ok));
  await handle(get(ok));
  assert.equal(reads, 1);
  clock = 1500;
  await handle(get(ok));
  assert.equal(reads, 2);
});
