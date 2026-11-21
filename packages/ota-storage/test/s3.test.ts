import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';

import { PreconditionFailedError, S3ObjectStore } from '../src/index.ts';

/** S3Client.send 만 흉내 낸다. 보낸 명령을 기록하고, 정해 둔 응답이나 에러를 돌려준다. */
function fakeClient(reply: (cmd: unknown) => unknown) {
  const sent: unknown[] = [];
  const client = {
    send: async (cmd: unknown) => {
      sent.push(cmd);
      const out = reply(cmd);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as S3Client;
  return { client, sent };
}

function s3Error(name: string, status: number): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status } });
}

const opts = { contentType: 'application/json', cacheControl: 'no-cache' };

test('ifMatch:null 은 If-None-Match: *, 문자열은 If-Match 로 보낸다', async () => {
  const { client, sent } = fakeClient(() => ({ ETag: '"e2"' }));
  const store = new S3ObjectStore('b', 'ota', client);
  await store.put('k', Buffer.from('x'), { ...opts, ifMatch: null });
  await store.put('k', Buffer.from('x'), { ...opts, ifMatch: '"e1"' });
  await store.put('k', Buffer.from('x'), opts);

  const inputs = sent.map(c => (c as PutObjectCommand).input);
  assert.equal(inputs[0]!.IfNoneMatch, '*');
  assert.equal(inputs[0]!.IfMatch, undefined);
  assert.equal(inputs[1]!.IfMatch, '"e1"');
  assert.equal(inputs[2]!.IfMatch, undefined);
  assert.equal(inputs[2]!.IfNoneMatch, undefined);
  assert.equal(inputs[0]!.Key, 'ota/k', '접두사를 붙인다');
});

test('412 와 409 는 PreconditionFailedError 로, 그 외 에러는 그대로 던진다', async () => {
  for (const status of [412, 409]) {
    const { client } = fakeClient(() => s3Error('PreconditionFailed', status));
    await assert.rejects(new S3ObjectStore('b', '', client).put('k', Buffer.from('x'), opts), PreconditionFailedError);
  }
  const { client } = fakeClient(() => s3Error('AccessDenied', 403));
  await assert.rejects(new S3ObjectStore('b', '', client).put('k', Buffer.from('x'), opts), /AccessDenied|UnknownError|403/);
});

test('없는 키(NoSuchKey, 404)는 null, 있으면 내용과 etag', async () => {
  const missing = fakeClient(() => s3Error('NoSuchKey', 404));
  assert.equal(await new S3ObjectStore('b', '', missing.client).get('k'), null);

  const found = fakeClient(cmd => {
    assert.ok(cmd instanceof GetObjectCommand);
    return { ETag: '"e9"', Body: { transformToByteArray: async () => new TextEncoder().encode('{"a":1}') } };
  });
  const got = await new S3ObjectStore('b', '', found.client).get('k');
  assert.equal(got!.body.toString(), '{"a":1}');
  assert.equal(got!.etag, '"e9"');
});

test('권한 없음(403)은 null 로 숨기지 않고 던진다', async () => {
  const { client } = fakeClient(() => s3Error('AccessDenied', 403));
  await assert.rejects(new S3ObjectStore('b', '', client).get('k'));
});
