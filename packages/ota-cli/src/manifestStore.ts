import { emptyManifest, parseManifest } from '@rn-federated-ota/core';
import type { ChannelManifest } from '@rn-federated-ota/core';
import { PreconditionFailedError } from '@rn-federated-ota/storage';
import type { ObjectStore } from '@rn-federated-ota/storage';

export const manifestKey = (channel: string): string => `manifests/${channel}.json`;

export async function readManifest(store: ObjectStore, channel: string): Promise<{ manifest: ChannelManifest | null; etag: string | null }> {
  const obj = await store.get(manifestKey(channel));
  if (!obj) return { manifest: null, etag: null };
  return { manifest: parseManifest(JSON.parse(obj.body.toString('utf8'))), etag: obj.etag };
}

/**
 * 읽고, 고치고, 조건부로 쓴다. 다른 배포가 먼저 썼으면 처음부터 다시 한다.
 *
 * change 는 순수 함수여야 한다(ota-core 의 연산들). 재시도 때 최신 매니페스트에
 * 같은 변경을 다시 적용하기 때문이다. "카나리 30% 시작" 같은 의도를 다시 적용하는
 * 것이지, 이전에 계산한 결과를 덮어쓰는 것이 아니다.
 */
export async function updateManifest(
  store: ObjectStore,
  channel: string,
  change: (current: ChannelManifest, now: Date) => ChannelManifest,
  { attempts = 5, now = () => new Date() } = {},
): Promise<ChannelManifest> {
  for (let attempt = 1; ; attempt++) {
    const { manifest, etag } = await readManifest(store, channel);
    const at = now();
    const next = change(manifest ?? emptyManifest(channel, at), at);
    try {
      await store.put(manifestKey(channel), Buffer.from(JSON.stringify(next, null, 2)), {
        contentType: 'application/json',
        // 매니페스트는 resolve API 만 읽고, API 는 캐시 없이 저장소에서 읽는다.
        cacheControl: 'no-cache',
        ifMatch: etag,
      });
      return next;
    } catch (err) {
      if (err instanceof PreconditionFailedError && attempt < attempts) continue;
      throw err;
    }
  }
}
