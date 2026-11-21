import { Script, ScriptManager } from '@callstack/repack/client';

import { OTA } from './config';
import { getSession } from './session';

/**
 * 원격 스크립트의 주소를 정하는 단 하나의 지점.
 *
 * Module Federation 이 피처 컨테이너나 그 청크를 필요로 하면 Re.Pack 의
 * ScriptManager 가 리졸버에게 "이 스크립트는 어디 있나"를 묻는다.
 * 여기서 resolve API 의 답(릴리스별 basePath)으로 CDN 주소를 만든다.
 *
 * 채널, 카나리, 롤백, 런타임 호환성 판단은 전부 서버에서 끝났다.
 * 앱이 아는 것은 "피처 이름 → 이번 세션의 basePath" 뿐이다.
 */

const FEATURES = new Set<string>(OTA.features);

ScriptManager.shared.on('loading', (script: { locator: { url: string } }) =>
  console.log('[OTA] loading', script.locator.url),
);
ScriptManager.shared.on('error', (err: unknown) =>
  console.log('[OTA] script error', String((err as Error)?.message ?? err)),
);

ScriptManager.shared.addResolver(
  async (scriptId: string, caller?: string) => {
    // 컨테이너는 scriptId 가 피처 이름이고, 청크는 caller 가 피처 이름이다.
    const feature = FEATURES.has(scriptId) ? scriptId : caller;
    if (!feature || !FEATURES.has(feature)) return undefined;

    const session = await getSession();
    const resolution = session.features[feature];
    if (!resolution) {
      // 이 앱의 런타임에 맞는 릴리스가 없다. 다른 런타임 번들을 받느니 실패가 낫다.
      throw new Error(`${feature}: 이 앱 버전에서 쓸 수 있는 릴리스가 없습니다`);
    }

    const file = scriptId === feature ? `${feature}.container.js.bundle` : `${scriptId}.chunk.bundle`;
    return {
      url: Script.getRemoteURL(`${OTA.baseUrl}/${resolution.basePath}${file}`, { excludeExtension: true }),
      // 주소에 릴리스 id 가 들어가므로, 캐시를 켜도 새 배포는 새 주소라 섞이지 않는다.
      cache: true,
    };
  },
  // Re.Pack 의 federation 기본 리졸버보다 먼저 돈다. 자리표시자 주소(ota://)로 가지 않게.
  { priority: 100 },
);
