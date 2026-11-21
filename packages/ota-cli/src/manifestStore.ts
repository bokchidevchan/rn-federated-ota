import { emptyManifest, manifestKey, parseManifest } from '@rn-federated-ota/core';
import type { ChannelManifest } from '@rn-federated-ota/core';
import { PreconditionFailedError } from '@rn-federated-ota/storage';
import type { ObjectStore } from '@rn-federated-ota/storage';

export async function readManifest(store: ObjectStore, channel: string): Promise<{ manifest: ChannelManifest | null; etag: string | null }> {
  const obj = await store.get(manifestKey(channel));
  if (!obj) return { manifest: null, etag: null };
  return { manifest: parseManifest(JSON.parse(obj.body.toString('utf8'))), etag: obj.etag };
}

/**
 * 읽고, 고치고, 조건부로 쓴다. 다른 배포가 먼저 썼으면 처음부터 다시 한다.
 *
 * change 는 순수 함수이고, 같은 의도를 두 번 적용해도 결과가 같아야 한다(멱등).
 * 재시도 때 최신 매니페스트에 같은 변경을 다시 적용하기 때문이다. 첫 쓰기가 사실은
 * 성공했는데 응답만 잃은 경우에도 다시 적용된다. 그래서 rollback, promote 는
 * "지금 것"이 아니라 대상 릴리스 id 를 받는다.
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
        // 매니페스트는 CDN 으로 나가지 않고 resolve API 만 읽는다. API 는 인스턴스마다
        // 최대 5초 메모리에 들고 있으므로(handler.ts), 변경은 길어야 5초 뒤에 반영된다.
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
