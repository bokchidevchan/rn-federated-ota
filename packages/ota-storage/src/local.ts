import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PreconditionFailedError } from './types.ts';
import type { ObjectStore, PutOptions, StoredObject } from './types.ts';

/**
 * 디렉터리를 S3 버킷처럼 쓴다. 로컬 검증과 테스트용.
 *
 * S3 와 같은 의미를 지키려고 두 가지를 맞췄다.
 * - etag 는 내용 해시다. 같은 내용을 다시 쓰면 etag 도 같다.
 * - 조건부 쓰기(ifMatch)를 지원한다. 단, 한 프로세스 안의 경쟁만 막는다.
 *   여러 프로세스가 동시에 쓰는 상황은 S3 에서만 보장된다.
 *
 * 쓰기는 임시 파일에 쓴 뒤 rename 한다. 서버가 읽는 도중에 반쯤 쓴 JSON 을
 * 보지 않게 하려는 것이다.
 */
export class LocalObjectStore implements ObjectStore {
  readonly root: string;
  readonly description: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.description = `local:${this.root}`;
  }

  private pathOf(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) {
      throw new Error(`저장소 밖을 가리키는 키입니다: ${key}`);
    }
    return full;
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const body = await readFile(this.pathOf(key));
      return { body, etag: etagOf(body) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  put(key: string, body: Buffer, options: PutOptions): Promise<{ etag: string }> {
    // 같은 프로세스 안의 쓰기를 한 줄로 세워서, 읽고-비교하고-쓰는 사이에 끼어들지 못하게 한다.
    const run = this.queue.then(() => this.putNow(key, body, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async putNow(key: string, body: Buffer, options: PutOptions): Promise<{ etag: string }> {
    if (options.ifMatch !== undefined) {
      const current = await this.get(key);
      const ok = options.ifMatch === null ? current === null : current?.etag === options.ifMatch;
      if (!ok) throw new PreconditionFailedError(`조건부 쓰기 실패: ${key}`);
    }
    const file = this.pathOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
    return { etag: etagOf(body) };
  }
}

function etagOf(body: Buffer): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}
