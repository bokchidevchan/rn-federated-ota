import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';

import { PreconditionFailedError } from './types.ts';
import type { ObjectStore, PutOptions, StoredObject } from './types.ts';

/**
 * S3 구현.
 *
 * 매니페스트 갱신에 S3 조건부 쓰기(If-Match, If-None-Match)를 쓴다.
 * CI 에서 두 피처가 동시에 배포되면 둘 다 같은 매니페스트를 읽고 각자 고쳐 쓰는데,
 * 조건 없이 쓰면 늦게 쓴 쪽이 먼저 쓴 쪽의 변경을 지운다(lost update).
 * DynamoDB 로 잠금을 따로 두는 방법도 있지만, 매니페스트가 채널당 파일 하나라
 * S3 조건부 쓰기만으로 충분하고 관리할 리소스가 하나 줄어든다.
 */
export class S3ObjectStore implements ObjectStore {
  readonly description: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(bucket: string, prefix = '', client = new S3Client({})) {
    this.bucket = bucket;
    this.prefix = prefix.replace(/^\/+|\/+$/g, '');
    this.client = client;
    this.description = `s3://${bucket}/${this.prefix}`;
  }

  private keyOf(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }));
      const bytes = await res.Body!.transformToByteArray();
      return { body: Buffer.from(bytes), etag: res.ETag ?? '' };
    } catch (err) {
      if (err instanceof S3ServiceException && (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404)) {
        return null;
      }
      throw err;
    }
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<{ etag: string }> {
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.keyOf(key),
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
          ...(options.ifMatch === null ? { IfNoneMatch: '*' } : {}),
          ...(typeof options.ifMatch === 'string' ? { IfMatch: options.ifMatch } : {}),
        }),
      );
      return { etag: res.ETag ?? '' };
    } catch (err) {
      const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
      // 412: 조건 불일치, 409: 같은 키에 동시 조건부 쓰기가 겹침. 둘 다 "다시 읽고 다시 시도"가 답이다.
      if (status === 412 || status === 409) {
        throw new PreconditionFailedError(`조건부 쓰기 실패: ${key} (HTTP ${status})`);
      }
      throw err;
    }
  }
}
