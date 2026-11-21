import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addRelease,
  bucketOf,
  computeRuntimeVersion,
  emptyManifest,
  ManifestError,
  promote,
  resolveAll,
  resolveFeature,
  rollback,
  startCanary,
} from '../src/index.ts';
import type { ChannelManifest, Release } from '../src/index.ts';

const RT_NEW = 'rn0.76.9-aaaaaaaaaaaa';
const RT_OLD = 'rn0.75.4-bbbbbbbbbbbb';

let tick = 0;
function clock(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, tick));
}

function release(id: string, runtimeVersion = RT_NEW): Release {
  return {
    id,
    runtimeVersion,
    platforms: { android: [{ path: 'featureCart.container.js.bundle', sha256: 'x', size: 1 }] },
    createdAt: clock().toISOString(),
  };
}

function req(userId: string, runtimeVersion = RT_NEW) {
  return { platform: 'android' as const, runtimeVersion, userId };
}

function users(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `user-${i + 1}`);
}

function withStable(...ids: string[]): ChannelManifest {
  let m = emptyManifest('prod', clock());
  for (const id of ids) {
    m = addRelease(m, 'featureCart', release(id), clock());
    m = promote(m, 'featureCart', id, clock());
  }
  return m;
}

test('버킷은 같은 입력에 항상 같은 값이고 0~99 범위다', () => {
  for (const u of users(500)) {
    const b = bucketOf('featureCart', u);
    assert.equal(b, bucketOf('featureCart', u));
    assert.ok(b >= 0 && b < 100);
  }
});

test('버킷 분포가 한쪽으로 쏠리지 않는다 (10,000명, 비율 30 기준 ±3%p)', () => {
  const all = users(10_000);
  const inCanary = all.filter(u => bucketOf('featureCart', u) < 30).length;
  assert.ok(inCanary > 2_700 && inCanary < 3_300, `카나리 대상 ${inCanary}명`);
});

test('피처가 다르면 같은 사용자라도 버킷이 독립적이다', () => {
  const all = users(2_000);
  const both = all.filter(u => bucketOf('featureCart', u) < 10 && bucketOf('featureProfile', u) < 10).length;
  // 독립이면 약 1%(20명). 같은 버킷을 공유하면 10%(200명)가 된다.
  assert.ok(both < 60, `두 피처 모두 카나리인 사용자 ${both}명`);
});

test('등록만 한 릴리스는 아무에게도 내려가지 않는다', () => {
  let m = emptyManifest('prod', clock());
  m = addRelease(m, 'featureCart', release('r1'), clock());
  assert.equal(resolveFeature(m.features.featureCart!, 'featureCart', req('user-1')), null);
});

test('카나리 비율만큼만 새 릴리스를 받고, 나머지는 stable 을 받는다', () => {
  let m = withStable('r1');
  m = addRelease(m, 'featureCart', release('r2'), clock());
  m = startCanary(m, 'featureCart', 'r2', 30, clock());

  const picked = users(1_000).map(u => resolveFeature(m.features.featureCart!, 'featureCart', req(u))!);
  const canary = picked.filter(p => p.releaseId === 'r2');
  assert.ok(canary.every(p => p.track === 'canary'));
  assert.ok(picked.filter(p => p.releaseId === 'r1').every(p => p.track === 'stable'));
  assert.ok(canary.length > 240 && canary.length < 360, `카나리 ${canary.length}명`);
});

test('promote 하면 카나리가 끝나고 전원이 새 릴리스를 받는다', () => {
  let m = withStable('r1');
  m = addRelease(m, 'featureCart', release('r2'), clock());
  m = startCanary(m, 'featureCart', 'r2', 10, clock());
  m = promote(m, 'featureCart', undefined, clock());

  assert.equal(m.features.featureCart!.canary, null);
  for (const u of users(200)) {
    assert.equal(resolveFeature(m.features.featureCart!, 'featureCart', req(u))!.releaseId, 'r2');
  }
});

test('카나리 중 rollback 은 카나리만 거두고 그 릴리스를 회수한다', () => {
  let m = withStable('r1');
  m = addRelease(m, 'featureCart', release('r2'), clock());
  m = startCanary(m, 'featureCart', 'r2', 50, clock());
  m = rollback(m, 'featureCart', clock());

  const state = m.features.featureCart!;
  assert.equal(state.stable, 'r1');
  assert.equal(state.canary, null);
  assert.ok(state.releases.find(r => r.id === 'r2')!.revokedAt);
  assert.throws(() => promote(m, 'featureCart', 'r2', clock()), ManifestError);
});

test('stable rollback 은 직전 stable 로 돌아가고, 회수된 것은 다시 고르지 않는다', () => {
  let m = withStable('r1', 'r2', 'r3');
  m = rollback(m, 'featureCart', clock());
  assert.equal(m.features.featureCart!.stable, 'r2');
  m = rollback(m, 'featureCart', clock());
  assert.equal(m.features.featureCart!.stable, 'r1');
  m = rollback(m, 'featureCart', clock());
  assert.equal(m.features.featureCart!.stable, null);
  assert.throws(() => rollback(m, 'featureCart', clock()), ManifestError);
});

test('런타임이 다른 앱에는 stable 대신 런타임이 맞는 예전 stable 을 준다', () => {
  let m = emptyManifest('prod', clock());
  m = addRelease(m, 'featureCart', release('old-1', RT_OLD), clock());
  m = promote(m, 'featureCart', 'old-1', clock());
  m = addRelease(m, 'featureCart', release('new-1', RT_NEW), clock());
  m = promote(m, 'featureCart', 'new-1', clock());

  const state = m.features.featureCart!;
  const fresh = resolveFeature(state, 'featureCart', req('u', RT_NEW))!;
  assert.equal(fresh.releaseId, 'new-1');
  assert.equal(fresh.track, 'stable');
  const old = resolveFeature(state, 'featureCart', req('u', RT_OLD))!;
  assert.equal(old.releaseId, 'old-1');
  assert.equal(old.track, 'fallback');
});

test('맞는 런타임이 하나도 없으면 null 이다 (다른 런타임 번들을 절대 주지 않는다)', () => {
  const m = withStable('r1');
  assert.equal(resolveFeature(m.features.featureCart!, 'featureCart', req('u', RT_OLD)), null);
});

test('요청한 플랫폼 산출물이 없는 릴리스는 고르지 않는다', () => {
  const m = withStable('r1');
  const ios = { platform: 'ios' as const, runtimeVersion: RT_NEW, userId: 'u' };
  assert.equal(resolveFeature(m.features.featureCart!, 'featureCart', ios), null);
});

test('basePath 는 피처, 릴리스, 플랫폼으로 만든다', () => {
  const m = withStable('r1');
  const res = resolveAll(m, req('u'));
  assert.equal(res.features.featureCart!.basePath, 'releases/featureCart/r1/android/');
});

test('잘못된 입력은 매니페스트를 바꾸기 전에 막는다', () => {
  const m = withStable('r1');
  assert.throws(() => startCanary(m, 'featureCart', 'r1', 10, clock()), /이미 stable/);
  assert.throws(() => startCanary(m, 'featureCart', 'nope', 10, clock()), /없는 릴리스/);
  assert.throws(() => addRelease(m, 'featureCart', release('r1'), clock()), /이미 있는/);
  assert.throws(() => addRelease(m, 'Bad Name', release('x'), clock()), /피처 이름/);
  assert.throws(() => emptyManifest('PROD', clock()), /채널 이름/);
  let m2 = addRelease(m, 'featureCart', release('r2'), clock());
  for (const ratio of [0, 100, 12.5, -1]) {
    assert.throws(() => startCanary(m2, 'featureCart', 'r2', ratio, clock()), /1~99/);
  }
  m2 = startCanary(m2, 'featureCart', 'r2', 5, clock());
  assert.equal(m2.features.featureCart!.canary!.ratio, 5);
});

test('순수 함수다: 입력 매니페스트를 고치지 않는다', () => {
  const m = withStable('r1');
  const before = JSON.stringify(m);
  const m2 = addRelease(m, 'featureCart', release('r2'), clock());
  startCanary(m2, 'featureCart', 'r2', 10, clock());
  rollback(m, 'featureCart', clock());
  assert.equal(JSON.stringify(m), before);
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
