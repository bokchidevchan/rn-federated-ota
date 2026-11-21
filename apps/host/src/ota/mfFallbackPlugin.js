/**
 * Module Federation 런타임 플러그인: 원격 로드 실패를 크래시 대신 값으로 바꾼다.
 *
 * CDN 이 죽었거나 resolve 가 "릴리스 없음"이라고 하면 import('featureCart/Screen') 이
 * 실패한다. 이 실패는 항상 promise reject 로 오지 않는다. federation 런타임 내부에서
 * 던진 에러가 처리되지 않은 채 남으면 릴리스 빌드에서는 앱이 통째로 죽는다.
 * errorLoadRemote 훅이 그 에러를 가로채는 공식 통로다.
 *
 * 돌려주는 값은 default 가 없는 표식 객체다. 받는 쪽(loadFeature.ts)은
 * default 유무로 성공과 실패를 가른다.
 *
 * 이 파일은 빌드 설정(rspack)이 경로로 읽어 들이므로 CommonJS 로 둔다.
 */
module.exports = function otaFallbackPlugin() {
  return {
    name: 'ota-fallback',
    errorLoadRemote(args) {
      // 런타임은 이 표식을 정상 모듈로 캐시한다. 재시도 경로가 캐시를 우회할 수 있게
      // 런타임 인스턴스(공유 스코프를 가진)를 밖에 남긴다.
      if (args && args.origin) {
        global.__otaFederationHost = args.origin;
      }
      const message = String((args && args.error && args.error.message) || (args && args.error) || 'unknown');
      // __esModule 이 없으면 ESM interop 이 { default: marker } 로 한 번 더 감싸 default 검사가 뚫린다.
      const marker = { __esModule: true, __otaLoadError: message };
      return args && args.lifecycle === 'onLoad' ? () => marker : marker;
    },
  };
};
