import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { computeRuntimeVersion } from '@rn-federated-ota/core';

/**
 * 앱(호스트나 피처) 디렉터리의 package.json 에서 ota.shared 목록을 읽고,
 * 그 패키지들이 node_modules 에 "실제로 설치된" 버전으로 런타임 지문을 만든다.
 *
 * package.json 의 버전 범위(^18.3.0)가 아니라 설치 버전을 보는 이유:
 * 범위가 같아도 lockfile 에 따라 다른 버전이 깔릴 수 있고, 공유 스코프에서
 * 실제로 만나는 것은 설치된 코드다.
 */
export async function sharedVersionsOf(appDir: string): Promise<Record<string, string>> {
  const pkgPath = path.resolve(appDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { ota?: { shared?: string[] } };
  const names = pkg.ota?.shared;
  if (!names || names.length === 0) {
    throw new Error(`${pkgPath} 에 ota.shared 목록이 없습니다`);
  }
  const require = createRequire(pkgPath);
  const versions: Record<string, string> = {};
  for (const name of names) {
    const depPkg = require(`${name}/package.json`) as { version: string };
    versions[name] = depPkg.version;
  }
  return versions;
}

export async function runtimeVersionOf(appDir: string): Promise<string> {
  return computeRuntimeVersion(await sharedVersionsOf(appDir));
}

/** 호스트 빌드 전에 지문을 소스 파일로 써 둔다. 번들에 그대로 박힌다. */
export async function writeRuntimeModule(appDir: string, outFile: string): Promise<string> {
  const version = await runtimeVersionOf(appDir);
  const source =
    '// 자동 생성 파일. `npm run ota -- runtime-version` 이 만든다. 직접 고치지 않는다.\n' +
    `export const RUNTIME_VERSION = ${JSON.stringify(version)};\n`;
  await writeFile(outFile, source);
  return version;
}
