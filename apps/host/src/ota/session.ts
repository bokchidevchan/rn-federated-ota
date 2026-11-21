import { OTA } from './config';

export interface FeatureResolution {
  releaseId: string;
  track: 'stable' | 'canary' | 'fallback';
  basePath: string;
}

export interface OtaSession {
  userId: string;
  features: Record<string, FeatureResolution | null>;
}

/**
 * 세션 = 앱 프로세스 하나. 세션당 resolve 를 한 번만 부르고 그 답을 끝까지 쓴다.
 *
 * 화면을 보는 도중에 배포 상태가 바뀌어도 이번 세션은 처음 받은 릴리스를 쓴다.
 * 중간에 바꾸면 이미 로드된 피처와 새로 로드할 피처의 릴리스가 섞이고,
 * Module Federation 런타임은 한 번 로드한 컨테이너를 교체하지 못한다.
 * 새 배포는 다음 콜드 스타트에 반영된다.
 *
 * 실패하면 약속을 버려서, 다음 호출(재시도 버튼)이 다시 요청하게 한다.
 */
let userId = 'anonymous';
let pending: Promise<OtaSession> | null = null;

export function setUserId(id: string): void {
  if (pending) {
    // 결정이 이미 난 뒤에 사용자를 바꾸면 버킷과 받은 번들이 어긋난다.
    console.warn('[OTA] 세션이 시작된 뒤에는 userId 를 바꿀 수 없습니다');
    return;
  }
  userId = id;
}

async function fetchSession(): Promise<OtaSession> {
  const query = [
    ['channel', OTA.channel],
    ['platform', OTA.platform],
    ['runtimeVersion', OTA.runtimeVersion],
    ['userId', userId],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTA.resolveTimeoutMs);
  try {
    const res = await fetch(`${OTA.baseUrl}/api/resolve?${query}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`resolve HTTP ${res.status}`);
    const body = (await res.json()) as { features?: OtaSession['features'] };
    if (typeof body.features !== 'object' || body.features === null) {
      throw new Error('resolve 응답 형식이 아닙니다');
    }
    console.log('[OTA] session', userId, JSON.stringify(body.features));
    return { userId, features: body.features };
  } finally {
    clearTimeout(timer);
  }
}

export function getSession(): Promise<OtaSession> {
  if (!pending) {
    pending = fetchSession().catch(err => {
      pending = null;
      throw err;
    });
  }
  return pending;
}
