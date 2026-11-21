import { assertChannelName, parseManifest, PLATFORMS, resolveAll } from '@rn-federated-ota/core';
import type { ChannelManifest, Platform, ResolveResponse } from '@rn-federated-ota/core';
import type { ObjectStore } from '@rn-federated-ota/storage';

/**
 * resolve API 의 본체. Lambda 와 로컬 서버가 같은 함수를 쓴다.
 *
 *   GET /api/resolve?channel=prod&platform=android&runtimeVersion=...&userId=...
 *   → { channel, runtimeVersion, features: { featureCart: { releaseId, track, basePath } | null } }
 *
 * 앱은 세션 시작에 이걸 한 번 부르고, 받은 basePath 로 CDN 에서 번들을 받는다.
 * 결정을 서버에 둔 이유는 README 의 "결정은 어디서 하나"에 적었다. 요약하면
 * 매니페스트 전체(회수된 릴리스, 다른 사용자의 카나리 비율)를 앱에 내려보내지 않고,
 * 정책을 바꿀 때 앱 릴리스가 필요 없게 하려는 것이다.
 */

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandlerOptions {
  store: ObjectStore;
  /** 매니페스트를 메모리에 들고 있을 시간. 0 이면 매번 읽는다. */
  cacheMs?: number;
  now?: () => number;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  body: JSON.stringify(body),
});

/** 사용자 id 와 런타임 지문은 로그와 해시에만 쓰지만, 길이와 문자는 제한한다. */
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

export function createResolveHandler({ store, cacheMs = 5_000, now = Date.now }: HandlerOptions) {
  const cache = new Map<string, { at: number; manifest: ChannelManifest | null }>();

  async function manifestOf(channel: string): Promise<ChannelManifest | null> {
    const hit = cache.get(channel);
    if (hit && now() - hit.at < cacheMs) return hit.manifest;
    const obj = await store.get(`manifests/${channel}.json`);
    const manifest = obj ? parseManifest(JSON.parse(obj.body.toString('utf8'))) : null;
    cache.set(channel, { at: now(), manifest });
    return manifest;
  }

  return async function handle(req: HttpRequest): Promise<HttpResponse> {
    if (req.path !== '/api/resolve') return json(404, { error: 'not_found' });
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });

    const { channel = 'prod', platform, runtimeVersion, userId } = req.query;
    try {
      assertChannelName(channel);
    } catch {
      return json(400, { error: 'bad_channel' });
    }
    if (!PLATFORMS.includes(platform as Platform)) return json(400, { error: 'bad_platform' });
    if (!runtimeVersion || !TOKEN.test(runtimeVersion)) return json(400, { error: 'bad_runtime_version' });
    if (!userId || !TOKEN.test(userId)) return json(400, { error: 'bad_user_id' });

    const manifest = await manifestOf(channel);
    const body: ResolveResponse = manifest
      ? resolveAll(manifest, { platform: platform as Platform, runtimeVersion, userId })
      : { channel, runtimeVersion, features: {} };

    // 사용자마다 답이 다르므로 공유 캐시(CDN)에 두면 안 된다.
    return json(200, body, { 'cache-control': 'private, no-store' });
  };
}
