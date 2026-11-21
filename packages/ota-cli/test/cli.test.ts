import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { promote, resolveFeature } from '@rn-federated-ota/core';
import { LocalObjectStore } from '@rn-federated-ota/storage';

import { readManifest, updateManifest } from '../src/manifestStore.ts';
import { publish } from '../src/publish.ts';
import { computeRuntimeVersion, runtimeVersionOf } from '../src/runtime.ts';

/** node_modules 까지 갖춘 가짜 피처 패키지를 만든다. 실제 RN 설치 없이 지문 계산을 시험하려고. */
async function fakeFeature(dir: string, rnVersion = '0.76.9'): Promise<void> {
  await mkdir(path.join(dir, 'node_modules/react'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules/react-native'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'f', ota: { shared: ['react', 'react-native'] } }));
  await writeFile(path.join(dir, 'node_modules/react/package.json'), JSON.stringify({ name: 'react', version: '18.3.1' }));
  await writeFile(path.join(dir, 'node_modules/react-native/package.json'), JSON.stringify({ name: 'react-native', version: rnVersion }));
  await mkdir(path.join(dir, 'build/android'), { recursive: true });
  await writeFile(path.join(dir, 'build/android/featureCart.container.js.bundle'), 'container');
  await writeFile(path.join(dir, 'build/android/src_Screen_js.chunk.bundle'), 'chunk');
  await writeFile(path.join(dir, 'build/android/featureCart.container.js.bundle.map'), 'sourcemap');
  await writeFile(path.join(dir, 'build/android/index.bundle'), 'entry with react-native copy');
  await writeFile(path.join(dir, 'build/android/mf-stats.json'), '{}');
}

async function env() {
  const base = await mkdtemp(path.join(tmpdir(), 'ota-cli-'));
  const app = path.join(base, 'feature');
  await fakeFeature(app);
  return { store: new LocalObjectStore(path.join(base, 'store')), app };
}

test('publish 는 파일을 올리고 릴리스를 등록만 한다 (아무에게도 노출 안 됨)', async () => {
  const { store, app } = await env();
  const release = await publish({
    store, channel: 'prod', feature: 'featureCart', appDir: app,
    outputs: { android: path.join(app, 'build/android') }, now: new Date('2026-11-22T03:10:00Z'),
  });

  assert.match(release.id, /^20261122T031000-[0-9a-f]{6}$/);
  assert.equal(release.runtimeVersion, await runtimeVersionOf(app));
  assert.deepEqual(release.platforms.android!.map(f => f.path), ['featureCart.container.js.bundle', 'src_Screen_js.chunk.bundle']);

  const uploaded = await store.get(`releases/featureCart/${release.id}/android/featureCart.container.js.bundle`);
  assert.equal(uploaded!.body.toString(), 'container');
  for (const skipped of ['featureCart.container.js.bundle.map', 'index.bundle', 'mf-stats.json']) {
    assert.equal(await store.get(`releases/featureCart/${release.id}/android/${skipped}`), null, `${skipped} 는 올리지 않는다`);
  }

  const { manifest } = await readManifest(store, 'prod');
  const state = manifest!.features.featureCart!;
  assert.equal(state.stable, null);
  assert.equal(resolveFeature(state, 'featureCart', { platform: 'android', runtimeVersion: release.runtimeVersion, userId: 'u' }), null);
});

test('같은 릴리스 파일은 덮어쓰지 않는다 (immutable)', async () => {
  const { store, app } = await env();
  const opts = { store, channel: 'prod', feature: 'featureCart', appDir: app, outputs: { android: path.join(app, 'build/android') }, now: new Date('2026-11-22T03:10:00Z') };
  await publish(opts);
  await assert.rejects(publish(opts), /이미 있습니다/);
});

test('컨테이너 번들이 없으면 업로드 전에 멈춘다', async () => {
  const { store, app } = await env();
  const empty = path.join(app, 'build/empty');
  await mkdir(empty, { recursive: true });
  await assert.rejects(
    publish({ store, channel: 'prod', feature: 'featureCart', appDir: app, outputs: { android: empty } }),
    /컨테이너 번들/,
  );
  assert.equal((await readManifest(store, 'prod')).manifest, null);
});

test('두 피처를 동시에 배포해도 어느 쪽 변경도 사라지지 않는다 (lost update 방지)', async () => {
  const { store, app } = await env();
  const out = { android: path.join(app, 'build/android') };
  const at = new Date('2026-11-22T01:00:00Z');

  // 두 배포가 같은 매니페스트(같은 etag)를 읽고 동시에 쓴다.
  // 조건부 쓰기가 없으면 늦게 쓴 쪽이 먼저 쓴 쪽의 피처를 지운다.
  const [cart, profile] = await Promise.all([
    publish({ store, channel: 'prod', feature: 'featureCart', appDir: app, outputs: out, now: at }),
    publish({ store, channel: 'prod', feature: 'featureProfile', appDir: app, outputs: out, now: at }),
  ]);
  await Promise.all([
    updateManifest(store, 'prod', (m, t) => promote(m, 'featureCart', cart.id, t)),
    updateManifest(store, 'prod', (m, t) => promote(m, 'featureProfile', profile.id, t)),
  ]);

  const { manifest } = await readManifest(store, 'prod');
  assert.equal(manifest!.features.featureCart!.stable, cart.id);
  assert.equal(manifest!.features.featureProfile!.stable, profile.id);
});

test('조건부 쓰기에 계속 지면 정해진 횟수 뒤 포기한다', async () => {
  const { store } = await env();
  let calls = 0;
  const losing = {
    description: 'losing',
    get: store.get.bind(store),
    put: async () => {
      calls++;
      const { PreconditionFailedError } = await import('@rn-federated-ota/storage');
      throw new PreconditionFailedError('항상 짐');
    },
  };
  await assert.rejects(updateManifest(losing, 'prod', m => m, { attempts: 3 }), /항상 짐/);
  assert.equal(calls, 3);
});

test('공유 의존성 버전이 다르면 런타임 지문이 다르다', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ota-rt-'));
  await fakeFeature(path.join(base, 'a'), '0.76.9');
  await fakeFeature(path.join(base, 'b'), '0.77.0');
  assert.notEqual(await runtimeVersionOf(path.join(base, 'a')), await runtimeVersionOf(path.join(base, 'b')));
});

test('런타임 지문은 입력 순서와 무관하고, 버전이 하나라도 다르면 바뀐다', () => {
  const a = computeRuntimeVersion({ react: '18.3.1', 'react-native': '0.76.9' });
  const b = computeRuntimeVersion({ 'react-native': '0.76.9', react: '18.3.1' });
  const c = computeRuntimeVersion({ react: '18.3.2', 'react-native': '0.76.9' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^rn0\.76\.9-[0-9a-f]{12}$/);
  assert.throws(() => computeRuntimeVersion({}));
});
