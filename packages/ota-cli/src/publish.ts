import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { addRelease, assertFeatureName } from '@rn-federated-ota/core';
import type { Platform, Release, ReleaseFile } from '@rn-federated-ota/core';
import { PreconditionFailedError } from '@rn-federated-ota/storage';
import type { ObjectStore } from '@rn-federated-ota/storage';

import { updateManifest } from './manifestStore.ts';
import { runtimeVersionOf } from './runtime.ts';

export interface PublishInput {
  store: ObjectStore;
  channel: string;
  feature: string;
  /** 피처 패키지 디렉터리. 런타임 지문 계산에 쓴다. */
  appDir: string;
  /** 플랫폼별 빌드 산출물 디렉터리. 예: { android: 'features/cart/build/android' } */
  outputs: Partial<Record<Platform, string>>;
  note?: string;
  gitSha?: string;
  now?: Date;
}

/** 번들 파일 하나는 한 번 올리면 영원히 그 주소에 그 내용이다. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * 올리지 않는 것들.
 * - 소스맵(*.map): 기기에 내려갈 이유가 없고, 공개 CDN 에 두면 원본 코드가 드러난다.
 *   크래시 분석용으로는 별도 비공개 저장소에 둔다.
 * - mf-stats.json: 빌드 분석용 통계. 런타임은 읽지 않는다.
 * - index.bundle: 원격 컨테이너 빌드에 딸려 나오는 엔트리 번들. react-native 사본을
 *   통째로 담고 있어(수백 KB) 받을 이유가 없고, 실수로라도 로드되면 런타임이 두 벌이 된다.
 */
const SKIP = new Set(['mf-stats.json', 'index.bundle']);
const isShippable = (file: string): boolean => !file.endsWith('.map') && !SKIP.has(file);

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (isShippable(entry.name)) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function contentTypeOf(file: string): string {
  if (file.endsWith('.bundle') || file.endsWith('.js')) return 'application/javascript';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

/**
 * 릴리스 id = 시각 + 내용 해시.
 * 시각은 사람이 순서를 읽기 위해, 해시는 같은 시각의 다른 빌드를 가르기 위해 넣는다.
 * 같은 산출물을 두 번 올리면 해시는 같고 시각만 다르다.
 */
function releaseIdOf(now: Date, files: Record<string, ReleaseFile[]>): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15); // 20261122T031005
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 6);
  return `${stamp}-${digest}`;
}

/**
 * 1) 산출물을 읽어 해시를 계산하고
 * 2) 파일을 releases/<피처>/<릴리스>/<플랫폼>/ 아래 올리고
 * 3) 매니페스트에 릴리스를 "등록만" 한다.
 *
 * 등록과 노출을 나눈 이유: 올리는 일(CI 가 자동으로)과 사용자에게 내보내는 일
 * (카나리 비율, promote)은 판단 주체가 다르다. 파일 업로드가 중간에 실패해도
 * 매니페스트에는 흔적이 남지 않으므로, 반쯤 올라간 릴리스가 사용자에게 갈 일이 없다.
 */
export async function publish(input: PublishInput): Promise<Release> {
  assertFeatureName(input.feature);
  const now = input.now ?? new Date();
  const runtimeVersion = await runtimeVersionOf(input.appDir);

  const platforms: Partial<Record<Platform, ReleaseFile[]>> = {};
  const bodies = new Map<string, Buffer>();
  for (const [platform, dir] of Object.entries(input.outputs) as [Platform, string][]) {
    if (!(await stat(dir).catch(() => null))?.isDirectory()) {
      throw new Error(`${platform} 산출물 디렉터리가 없습니다: ${dir}`);
    }
    const names = await listFiles(dir);
    if (!names.some(n => n.endsWith('.container.js.bundle'))) {
      throw new Error(`${dir} 에 컨테이너 번들(*.container.js.bundle)이 없습니다. 피처 빌드를 먼저 하세요`);
    }
    const files: ReleaseFile[] = [];
    for (const name of names) {
      const body = await readFile(path.join(dir, name));
      files.push({ path: name, sha256: createHash('sha256').update(body).digest('hex'), size: body.length });
      bodies.set(`${platform}/${name}`, body);
    }
    platforms[platform] = files;
  }
  if (Object.keys(platforms).length === 0) throw new Error('올릴 플랫폼이 없습니다');

  const id = releaseIdOf(now, platforms as Record<string, ReleaseFile[]>);
  for (const [rel, body] of bodies) {
    const key = `releases/${input.feature}/${id}/${rel}`;
    try {
      await input.store.put(key, body, {
        contentType: contentTypeOf(rel),
        cacheControl: IMMUTABLE,
        // 이미 있는 릴리스 파일을 덮어쓰지 않는다. 캐시된 사본과 내용이 갈라지는 것을 막는다.
        ifMatch: null,
      });
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        throw new Error(
          `${key} 가 이미 있습니다. 같은 산출물을 같은 초에 다시 올렸거나, 이전 업로드가 중간에 끊긴 경우입니다. 잠시 뒤 다시 publish 하세요`,
        );
      }
      throw err;
    }
  }

  const release: Release = {
    id,
    runtimeVersion,
    platforms,
    createdAt: now.toISOString(),
    ...(input.note ? { note: input.note } : {}),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
  };
  await updateManifest(input.store, input.channel, (m, at) => addRelease(m, input.feature, release, at));
  return release;
}
