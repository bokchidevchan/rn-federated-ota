/**
 * 채널 매니페스트: "이 채널에서 각 피처의 어느 릴리스가 살아 있는가"를 담는 유일한 상태.
 *
 * 매니페스트는 S3에 채널당 JSON 하나(manifests/<channel>.json)로 저장한다.
 * 번들 파일은 한 번 올리면 바뀌지 않고(immutable), 배포, 카나리, 롤백은 전부
 * 이 파일의 포인터만 바꾼다. 그래서 롤백이 "파일 하나 다시 쓰기"로 끝난다.
 *
 * 이 모듈의 함수는 전부 순수 함수다. 입력 매니페스트를 고치지 않고 새 객체를 돌려준다.
 * 저장(S3 조건부 쓰기)과 결정(resolve)을 분리해야 둘 다 테스트가 쉬워진다.
 */

export type Platform = 'android' | 'ios';
export const PLATFORMS: readonly Platform[] = ['android', 'ios'];

export interface ReleaseFile {
  /** 릴리스 디렉터리 기준 상대 경로. 예: featureCart.container.js.bundle */
  path: string;
  sha256: string;
  size: number;
}

export interface Release {
  /** 시간 + 내용 해시. 예: 20261122T0310-3f2a9c */
  id: string;
  /**
   * 이 번들이 기대하는 호스트 런타임(공유 의존성 버전 묶음)의 지문.
   * 호스트 앱의 지문과 다르면 절대 내려주지 않는다. 아래 resolve.ts 참고.
   */
  runtimeVersion: string;
  platforms: Partial<Record<Platform, ReleaseFile[]>>;
  createdAt: string;
  note?: string;
  gitSha?: string;
  /** 한 번이라도 stable 이 된 시각. 런타임이 안 맞는 옛 앱의 대체 후보를 고를 때 쓴다. */
  promotedAt?: string;
  /** 롤백으로 회수된 시각. 회수된 릴리스는 어떤 경로로도 다시 내려가지 않는다. */
  revokedAt?: string;
}

export interface Canary {
  releaseId: string;
  /** 0 초과 100 미만. 사용자 버킷(0~99)이 이 값보다 작으면 카나리를 받는다. */
  ratio: number;
}

export interface FeatureState {
  /** 최신이 뒤. 추가만 하고 지우지 않는다(감사 기록 겸 롤백 후보). */
  releases: Release[];
  stable: string | null;
  canary: Canary | null;
}

export interface ChannelManifest {
  schemaVersion: 1;
  channel: string;
  updatedAt: string;
  features: Record<string, FeatureState>;
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

const NAME_PATTERN = /^[a-z][a-zA-Z0-9]{1,40}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export function assertFeatureName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ManifestError(`피처 이름 형식이 아닙니다: ${name} (예: featureCart)`);
  }
}

export function assertChannelName(name: string): void {
  if (!CHANNEL_PATTERN.test(name)) {
    throw new ManifestError(`채널 이름 형식이 아닙니다: ${name} (예: prod, beta)`);
  }
}

export function emptyManifest(channel: string, now: Date): ChannelManifest {
  assertChannelName(channel);
  return { schemaVersion: 1, channel, updatedAt: now.toISOString(), features: {} };
}

export function parseManifest(raw: unknown): ChannelManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError('매니페스트가 객체가 아닙니다');
  }
  const m = raw as Partial<ChannelManifest>;
  if (m.schemaVersion !== 1) {
    throw new ManifestError(`모르는 schemaVersion: ${String(m.schemaVersion)}`);
  }
  if (typeof m.channel !== 'string' || typeof m.features !== 'object' || m.features === null) {
    throw new ManifestError('channel 또는 features 가 없습니다');
  }
  return m as ChannelManifest;
}

export function findRelease(state: FeatureState, id: string | null | undefined): Release | undefined {
  if (!id) return undefined;
  return state.releases.find(r => r.id === id);
}

function featureOf(m: ChannelManifest, feature: string): FeatureState {
  const state = m.features[feature];
  if (!state) throw new ManifestError(`채널 ${m.channel} 에 피처 ${feature} 가 없습니다`);
  return state;
}

function withFeature(
  m: ChannelManifest,
  feature: string,
  next: FeatureState,
  now: Date,
): ChannelManifest {
  return { ...m, updatedAt: now.toISOString(), features: { ...m.features, [feature]: next } };
}

function replaceRelease(state: FeatureState, release: Release): Release[] {
  return state.releases.map(r => (r.id === release.id ? release : r));
}

/** 새 릴리스를 등록한다. 등록만 하고 아무에게도 내려주지 않는다. */
export function addRelease(
  m: ChannelManifest,
  feature: string,
  release: Release,
  now: Date,
): ChannelManifest {
  assertFeatureName(feature);
  const state = m.features[feature] ?? { releases: [], stable: null, canary: null };
  if (findRelease(state, release.id)) {
    throw new ManifestError(`이미 있는 릴리스입니다: ${feature}/${release.id}`);
  }
  if (Object.keys(release.platforms).length === 0) {
    throw new ManifestError('플랫폼 산출물이 하나도 없는 릴리스는 등록할 수 없습니다');
  }
  return withFeature(m, feature, { ...state, releases: [...state.releases, release] }, now);
}

/** 일부 사용자에게만 먼저 내려준다. 진행 중인 카나리가 있으면 교체한다. */
export function startCanary(
  m: ChannelManifest,
  feature: string,
  releaseId: string,
  ratio: number,
  now: Date,
): ChannelManifest {
  const state = featureOf(m, feature);
  const release = findRelease(state, releaseId);
  if (!release) throw new ManifestError(`없는 릴리스입니다: ${feature}/${releaseId}`);
  if (release.revokedAt) throw new ManifestError(`회수된 릴리스는 카나리로 낼 수 없습니다: ${releaseId}`);
  if (state.stable === releaseId) throw new ManifestError(`이미 stable 인 릴리스입니다: ${releaseId}`);
  if (!Number.isInteger(ratio) || ratio <= 0 || ratio >= 100) {
    throw new ManifestError(`카나리 비율은 1~99 정수여야 합니다: ${ratio} (100%는 promote 로)`);
  }
  return withFeature(m, feature, { ...state, canary: { releaseId, ratio } }, now);
}

/**
 * stable 로 올린다. releaseId 를 생략하면 진행 중인 카나리를 올린다.
 * 카나리 없이 바로 올리는 것도 허용한다(긴급 수정). 판단은 사람 몫으로 둔다.
 */
export function promote(
  m: ChannelManifest,
  feature: string,
  releaseId: string | undefined,
  now: Date,
): ChannelManifest {
  const state = featureOf(m, feature);
  const targetId = releaseId ?? state.canary?.releaseId;
  if (!targetId) throw new ManifestError(`올릴 릴리스를 지정하세요. 진행 중인 카나리도 없습니다: ${feature}`);
  const release = findRelease(state, targetId);
  if (!release) throw new ManifestError(`없는 릴리스입니다: ${feature}/${targetId}`);
  if (release.revokedAt) throw new ManifestError(`회수된 릴리스는 올릴 수 없습니다: ${targetId}`);

  const promoted: Release = { ...release, promotedAt: now.toISOString() };
  return withFeature(
    m,
    feature,
    { releases: replaceRelease(state, promoted), stable: targetId, canary: null },
    now,
  );
}

/**
 * 되돌린다.
 *
 * - 카나리가 진행 중이면: 카나리만 거두고 그 릴리스를 회수한다. stable 은 그대로.
 * - 카나리가 없으면: 현재 stable 을 회수하고, 그 전에 stable 이었던 릴리스 중
 *   회수되지 않은 가장 최근 것으로 되돌린다.
 *
 * 회수(revokedAt)를 남기는 이유: 포인터만 되돌리면, 런타임이 안 맞는 앱을 위한
 * 대체 경로(resolve.ts 의 fallback)가 문제의 릴리스를 다시 고를 수 있다.
 */
export function rollback(m: ChannelManifest, feature: string, now: Date): ChannelManifest {
  const state = featureOf(m, feature);
  const at = now.toISOString();

  if (state.canary) {
    const target = findRelease(state, state.canary.releaseId);
    const releases = target ? replaceRelease(state, { ...target, revokedAt: at }) : state.releases;
    return withFeature(m, feature, { ...state, releases, canary: null }, now);
  }

  const current = findRelease(state, state.stable);
  if (!current) throw new ManifestError(`되돌릴 stable 이 없습니다: ${feature}`);

  const releases = replaceRelease(state, { ...current, revokedAt: at });
  const previous = releases
    .filter(r => r.id !== current.id && r.promotedAt && !r.revokedAt)
    .sort((a, b) => (a.promotedAt! < b.promotedAt! ? 1 : -1))[0];

  return withFeature(m, feature, { releases, stable: previous?.id ?? null, canary: null }, now);
}
