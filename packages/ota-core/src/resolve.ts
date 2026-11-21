import { bucketOf } from './bucket.ts';
import { findRelease } from './manifest.ts';
import type { ChannelManifest, FeatureState, Platform, Release } from './manifest.ts';

export interface ResolveRequest {
  platform: Platform;
  /** 호스트 앱에 박힌 런타임 지문. runtime.ts 참고. */
  runtimeVersion: string;
  /** 카나리 버킷 계산용. 로그인 id 나 설치 id. */
  userId: string;
}

export type Track = 'stable' | 'canary' | 'fallback';

export interface FeatureResolution {
  releaseId: string;
  track: Track;
  /** CDN 기준 상대 경로. 끝이 / 로 끝난다. 예: releases/featureCart/<id>/android/ */
  basePath: string;
}

export interface ResolveResponse {
  channel: string;
  runtimeVersion: string;
  features: Record<string, FeatureResolution | null>;
}

function servable(release: Release | undefined, req: ResolveRequest): release is Release {
  return (
    release !== undefined &&
    !release.revokedAt &&
    release.runtimeVersion === req.runtimeVersion &&
    (release.platforms[req.platform]?.length ?? 0) > 0
  );
}

function toResolution(feature: string, release: Release, track: Track, platform: Platform): FeatureResolution {
  return { releaseId: release.id, track, basePath: `releases/${feature}/${release.id}/${platform}/` };
}

/**
 * 이 사용자, 이 앱에게 어떤 릴리스를 줄지 정한다. 순서가 곧 정책이다.
 *
 * 1. 카나리 대상(버킷 < 비율)이고 카나리 릴리스가 이 앱에서 돌 수 있으면 카나리.
 * 2. 아니면 stable.
 * 3. stable 이 이 앱의 런타임과 안 맞으면(스토어에서 아직 업데이트 안 한 옛 앱),
 *    예전에 stable 이었던 것 중 런타임이 맞는 가장 최근 릴리스. 이게 fallback.
 * 4. 그것도 없으면 null. 호스트는 그 피처를 "지금 쓸 수 없음"으로 보여준다.
 *
 * 런타임이 다른 번들을 내려주는 것은 절대 하지 않는다. 피처 번들은 react,
 * react-native 를 호스트에게서 빌려 쓰므로(Module Federation 공유 스코프),
 * 버전이 어긋나면 화면이 깨지는 정도가 아니라 앱이 죽을 수 있다.
 */
export function resolveFeature(
  state: FeatureState,
  feature: string,
  req: ResolveRequest,
): FeatureResolution | null {
  if (state.canary && bucketOf(feature, req.userId) < state.canary.ratio) {
    const canary = findRelease(state, state.canary.releaseId);
    if (servable(canary, req)) return toResolution(feature, canary, 'canary', req.platform);
  }

  const stable = findRelease(state, state.stable);
  if (servable(stable, req)) return toResolution(feature, stable, 'stable', req.platform);

  const fallback = state.releases
    .filter(r => r.promotedAt && servable(r, req))
    .sort((a, b) => (a.promotedAt! < b.promotedAt! ? 1 : -1))[0];
  if (fallback) return toResolution(feature, fallback, 'fallback', req.platform);

  return null;
}

export function resolveAll(manifest: ChannelManifest, req: ResolveRequest): ResolveResponse {
  const features: Record<string, FeatureResolution | null> = {};
  for (const [name, state] of Object.entries(manifest.features)) {
    features[name] = resolveFeature(state, name, req);
  }
  return { channel: manifest.channel, runtimeVersion: req.runtimeVersion, features };
}
