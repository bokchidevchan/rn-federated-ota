import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Repack from '@callstack/repack';
import { rspack } from '@rspack/core';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(dirname, 'package.json'), 'utf8'));

/**
 * 호스트가 공유 스코프에 내놓는 의존성. package.json 의 ota.shared 가 유일한 원본이다.
 * 런타임 지문(ota runtime-version)도 같은 목록으로 계산하므로, 여기와 지문이 어긋날 수 없다.
 */
const shared = Object.fromEntries(
  pkg.ota.shared.map(name => [
    name,
    { singleton: true, eager: true, requiredVersion: require(`${name}/package.json`).version },
  ]),
);

/**
 * 피처 목록. 원격 주소는 여기 적지 않는다.
 *
 * Module Federation 은 remotes 에 주소를 요구하지만, 이 앱에서 실제 주소는
 * 런타임에 resolve API 가 정한다(src/ota/scriptManager.ts). 그래서 여기에는
 * 절대 요청되지 않는 자리표시자를 둔다. 리졸버가 이 주소를 가로채지 못하면
 * ota:// 는 열 수 없는 스킴이라 조용히 엉뚱한 서버로 가는 대신 바로 실패한다.
 */
const FEATURES = ['featureCart', 'featureProfile'];
const remotes = Object.fromEntries(
  FEATURES.map(name => [name, `${name}@ota://resolved-at-runtime/${name}.container.js.bundle`]),
);

export default env => {
  const { mode = 'production', platform, ...rest } = env;

  return {
    mode,
    context: dirname,
    entry: './index.js',
    resolve: { ...Repack.getResolveOptions(platform) },
    module: {
      rules: [...Repack.getJsTransformRules(), ...Repack.getAssetTransformRules()],
    },
    plugins: [
      new Repack.RepackPlugin({ platform, ...rest }),
      new Repack.plugins.ModuleFederationPluginV2({
        name: 'host',
        remotes,
        shared,
        runtimePlugins: [path.join(dirname, 'src/ota/mfFallbackPlugin.js')],
      }),
      // 빌드 환경마다 달라지는 값. 앱 코드에서는 상수로 보인다.
      new rspack.DefinePlugin({
        __OTA_BASE_URL__: JSON.stringify(process.env.OTA_BASE_URL ?? 'http://10.0.2.2:4300'),
        __OTA_CHANNEL__: JSON.stringify(process.env.OTA_CHANNEL ?? 'prod'),
        __OTA_FEATURES__: JSON.stringify(FEATURES),
      }),
    ],
  };
};
