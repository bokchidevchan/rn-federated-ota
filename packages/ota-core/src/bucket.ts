/**
 * 사용자를 0~99 버킷 중 하나에 결정적으로 배치한다.
 *
 * Math.random() 을 쓰면 같은 사용자가 앱을 켤 때마다 카나리와 stable 을 오간다.
 * 사용자에게는 버그처럼 보이고, 지표에서는 두 집단이 섞여 카나리를 판정할 수 없다.
 * 그래서 hash(피처 + 사용자) 로 고정한다.
 *
 * 피처 이름을 섞는 이유: 사용자 id 만 쓰면 버킷이 낮은 사용자가 모든 피처의
 * 카나리를 동시에 받는다. 문제가 생겼을 때 어느 피처 탓인지 가르기 어려워진다.
 *
 * 해시는 FNV-1a 32bit. 암호학적 성질은 필요 없고, 서버(Lambda)와 테스트에서
 * 같은 값을 의존성 없이 계산하는 것이 목적이다.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function bucketOf(feature: string, userId: string): number {
  return fnv1a32(`${feature}:${userId}`) % 100;
}
