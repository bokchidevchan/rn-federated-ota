import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Repack from '@callstack/repack';
import { rspack } from '@rspack/core';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(dirname, 'package.json'), 'utf8'));
const { name, expose } = pkg.ota;

/**
 * 피처 번들(원격 컨테이너) 설정. 피처마다 이 파일은 같고, 이름과 노출 경로는
 * package.json 의 ota 필드에서 읽는다.
 *
 * 핵심은 shared 의 eager: false 다. Re.Pack 의 MF 플러그인 기본값은 eager: true 라
 * 그대로 두면 react-native 가 컨테이너 안에 통째로 들어가(수백 KB) 호스트와 두 벌이 된다.
 * false 로 두면 호스트가 공유 스코프에 올린 것을 빌려 쓰고, 컨테이너에는 화면 코드와
 * federation 런타임만 남는다.
 *
 * requiredVersion 은 설치된 실제 버전이다. 런타임 지문(ota runtime-version)과 같은 값을
 * 보므로, 지문이 같으면 여기 버전 요구도 만족한다.
 */
const shared = Object.fromEntries(
  pkg.ota.shared.map(dep => [
    dep,
    {
      singleton: true,
      eager: false,
      requiredVersion: require(`${dep}/package.json`).version,
      // 폴백 사본을 만들지 않는다. 기본값이면 호스트 것을 못 찾을 때 쓸 react-native 사본이
      // 청크로 같이 빌드되고, 그게 로드되면 런타임이 두 벌이 되어 앱이 죽는다.
      // 호스트 것이 없으면 차라리 로드가 실패하는 편이 낫다(호스트는 그 실패를 화면으로 보여 준다).
      import: false,
    },
  ]),
);

export default env => {
  const { mode = 'production', platform, ...rest } = env;

  return {
    mode,
    context: dirname,
    // 원격 컨테이너에는 진입점이 없다. CLI 가 --entry-file 을 요구해서 빈 파일을 준다.
    entry: {},
    resolve: { ...Repack.getResolveOptions(platform) },
    module: {
      rules: [...Repack.getJsTransformRules(), ...Repack.getAssetTransformRules()],
    },
    plugins: [
      new Repack.RepackPlugin({ platform, ...rest }),
      new Repack.plugins.ModuleFederationPluginV2({
        name,
        // 이름을 정하지 않으면 엔트리 번들과 파일명이 겹쳐 빌드가 실패한다.
        filename: `${name}.container.js.bundle`,
        // 호스트가 import('<name>/Screen') 으로 부르는 계약. 바꾸면 호스트도 같이 내야 한다.
        exposes: { './Screen': expose },
        shared,
      }),
      // 같은 코드로 v1, v2 를 만들어 카나리를 검증하려고 라벨을 빌드 때 주입한다.
      new rspack.DefinePlugin({
        __RELEASE_LABEL__: JSON.stringify(process.env.OTA_LABEL ?? 'v1'),
      }),
    ],
  };
};
