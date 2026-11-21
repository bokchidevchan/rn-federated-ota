import type { ComponentType } from 'react';
import { ScriptManager } from '@callstack/repack/client';

/** 피처가 지켜야 하는 계약. 바꾸면 모든 피처와 호스트를 같이 내야 한다. */
export interface FeatureModule {
  default: ComponentType<{ userId: string }>;
  RELEASE_LABEL?: string;
}

export interface FeatureEntry {
  name: string;
  title: string;
  expose: string;
  load: () => Promise<unknown>;
}

function asFeatureModule(mod: unknown): FeatureModule {
  const m = mod as { default?: unknown; __otaLoadError?: string } | null;
  if (m?.__otaLoadError) throw new Error(m.__otaLoadError);
  if (typeof m?.default !== 'function') throw new Error('피처 모듈에 default 컴포넌트가 없습니다');
  return m as FeatureModule;
}

/**
 * 재시도 경로. import() 를 다시 부르면 federation 런타임이 첫 실패 때 캐시한
 * 표식 객체를 그대로 돌려줘서 네트워크를 타지 않는다. 그래서 컨테이너를 직접
 * 받아 공유 스코프에 연결하고 모듈을 꺼낸다. import() 한 줄이 하는 일을 풀어 쓴 것이다.
 */
async function loadBypassingCache(name: string, expose: string): Promise<unknown> {
  await ScriptManager.shared.loadScript(name);
  const container = (globalThis as Record<string, any>)[name];
  if (!container) throw new Error(`${name}: 컨테이너를 받았지만 등록되지 않았습니다`);
  const host = (globalThis as Record<string, any>).__otaFederationHost;
  try {
    await container.init(host?.shareScopeMap?.default ?? {});
  } catch {
    // 이미 초기화된 컨테이너면 다시 init 할 때 던진다. 무시해도 된다.
  }
  const factory = await container.get(expose);
  return factory();
}

export async function loadFeature(entry: FeatureEntry, retry: boolean): Promise<FeatureModule> {
  const mod = retry ? await loadBypassingCache(entry.name, entry.expose) : await entry.load();
  return asFeatureModule(mod);
}
