import { S3ObjectStore } from '@rn-federated-ota/storage';

import { createResolveHandler } from './handler.ts';

/**
 * Lambda 진입점. CloudFront → Lambda Function URL 로 들어온다.
 *
 * 핸들러를 모듈 최상단에서 만들어 두면, 같은 실행 환경이 재사용되는 동안
 * 매니페스트 캐시(5초)가 살아 있어 S3 읽기 횟수가 줄어든다.
 */
const bucket = process.env.OTA_BUCKET;
if (!bucket) throw new Error('OTA_BUCKET 환경변수가 없습니다');

const handle = createResolveHandler({ store: new S3ObjectStore(bucket) });

interface FunctionUrlEvent {
  rawPath: string;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: { http: { method: string } };
}

export async function handler(event: FunctionUrlEvent) {
  try {
    const res = await handle({
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.queryStringParameters ?? {},
    });
    return { statusCode: res.status, headers: res.headers, body: res.body };
  } catch (err) {
    console.error('resolve 실패', err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: '{"error":"internal"}',
    };
  }
}
