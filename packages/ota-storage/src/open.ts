import { LocalObjectStore } from './local.ts';
import { S3ObjectStore } from './s3.ts';
import type { ObjectStore } from './types.ts';

/**
 * 저장소 주소 문자열로 구현을 고른다.
 *   s3://bucket/prefix   → S3
 *   local:./.ota-storage → 디렉터리
 */
export function openStore(spec: string): ObjectStore {
  if (spec.startsWith('s3://')) {
    const [bucket, ...rest] = spec.slice('s3://'.length).split('/');
    if (!bucket) throw new Error(`버킷 이름이 없습니다: ${spec}`);
    return new S3ObjectStore(bucket, rest.join('/'));
  }
  if (spec.startsWith('local:')) {
    return new LocalObjectStore(spec.slice('local:'.length));
  }
  throw new Error(`모르는 저장소 형식입니다: ${spec} (s3://bucket 또는 local:./dir)`);
}
