import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

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

/**
 * 런타임 지문: 호스트와 피처 사이의 계약을 문자열 하나로 만든 것.
 *
 * Module Federation 에서 피처 번들은 react, react-native 같은 공유 의존성을
 * 자기 번들에 넣지 않고 호스트 것을 빌린다. 그래서 피처가 "어떤 호스트 위에서
 * 빌드됐는가"가 호환성의 전부다. 앱 버전(1.4.2)으로 판단하면, 네이티브 변경 없는
 * 앱 업데이트에도 피처를 다시 내야 하고, 반대로 앱 버전은 같은데 공유 의존성이
 * 바뀐 경우를 못 잡는다.
 *
 * 그래서 앱 버전 대신 "공유 의존성 이름과 실제 설치 버전"을 해시한다.
 * 호스트는 빌드할 때 이 값을 번들에 박고, 피처는 배포할 때 이 값을 매니페스트에 적는다.
 * resolve 는 두 값이 같을 때만 번들을 내려준다.
 *
 * 입력 순서에 따라 값이 달라지면 안 되므로 이름으로 정렬한 뒤 해시한다.
 */
export function computeRuntimeVersion(shared: Record<string, string>): string {
  const entries = Object.entries(shared).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) {
    throw new Error('공유 의존성이 비어 있습니다. 최소한 react, react-native 가 있어야 합니다');
  }
  const canonical = entries.map(([name, version]) => `${name}@${version}`).join('\n');
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  const rn = shared['react-native'];
  return rn ? `rn${rn}-${digest}` : digest;
}
