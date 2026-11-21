import type { FeatureEntry } from './ota/loadFeature';

/**
 * 호스트가 아는 피처 목록. 원격을 하나 늘릴 때 호스트에서 바꾸는 곳은
 * 여기와 rspack.config.mjs 의 FEATURES 두 군데다.
 *
 * import() 인자는 번들러가 빌드 때 정적으로 읽으므로 피처마다 함수를 따로 둔다.
 */
export const FEATURES: FeatureEntry[] = [
  { name: 'featureCart', title: '장바구니', expose: './Screen', load: () => import('featureCart/Screen') },
  { name: 'featureProfile', title: '프로필', expose: './Screen', load: () => import('featureProfile/Screen') },
];
