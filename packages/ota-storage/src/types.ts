/**
 * 저장소 추상화. 실제로는 S3, 로컬 검증에서는 디렉터리 하나.
 *
 * 인터페이스를 두 메서드로 좁힌 이유: 배포 도구가 저장소에 바라는 것은
 * "읽기"와 "조건부 쓰기" 둘뿐이다. 목록 조회나 삭제를 넣으면 로컬 구현과
 * S3 구현의 동작 차이(일관성, 페이지네이션)가 테스트에 새어 나온다.
 */

export interface StoredObject {
  body: Buffer;
  etag: string;
}

export interface PutOptions {
  contentType: string;
  cacheControl: string;
  /**
   * 낙관적 잠금.
   * - 문자열: 저장소의 현재 etag 가 이 값일 때만 쓴다(S3 If-Match).
   * - null: 아직 객체가 없을 때만 쓴다(S3 If-None-Match: *).
   * - undefined: 조건 없이 덮어쓴다.
   */
  ifMatch?: string | null;
}

export interface ObjectStore {
  /** 사람이 읽는 위치. 로그용. */
  readonly description: string;
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Buffer, options: PutOptions): Promise<{ etag: string }>;
}

/** 다른 배포가 먼저 매니페스트를 바꿨다. 다시 읽고 다시 적용해야 한다. */
export class PreconditionFailedError extends Error {
  override name = 'PreconditionFailedError';
}
