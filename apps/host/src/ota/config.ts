import { Platform } from 'react-native';

import { RUNTIME_VERSION } from './runtimeVersion.generated';

declare const __OTA_BASE_URL__: string;
declare const __OTA_CHANNEL__: string;
declare const __OTA_FEATURES__: string[];

/**
 * 빌드 때 정해지는 값들. 로컬 검증에서는 기준 주소가 에뮬레이터에서 본
 * 개발 머신(10.0.2.2)이고, AWS 에서는 CloudFront 도메인이다.
 * /api/resolve 와 /releases/* 가 같은 기준 주소 아래 있다.
 */
export const OTA = {
  baseUrl: __OTA_BASE_URL__.replace(/\/+$/, ''),
  channel: __OTA_CHANNEL__,
  features: __OTA_FEATURES__,
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  runtimeVersion: RUNTIME_VERSION,
  resolveTimeoutMs: 3000,
} as const;
