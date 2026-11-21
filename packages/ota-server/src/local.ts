import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { LocalObjectStore } from '@rn-federated-ota/storage';

import { createResolveHandler } from './handler.ts';

/**
 * 로컬 검증용 서버. AWS 의 두 역할을 한 프로세스에서 흉내 낸다.
 *
 *   /api/resolve  → Lambda (handler.ts 를 그대로 씀)
 *   /releases/... → CloudFront + S3 (저장소 디렉터리를 정적 서빙)
 *
 * CloudFront 에서 /releases/* 는 S3 로, /api/* 는 Lambda 로 가는 것과 같은 경로 규칙이다.
 * 앱은 기준 주소 하나만 알면 되고, 로컬과 AWS 의 차이는 그 주소뿐이다.
 *
 * 모든 요청을 한 줄씩 남긴다. "어떤 사용자가 어떤 릴리스 파일을 받았나"를
 * 에뮬레이터 밖에서 확인하는 유일한 증거라서다.
 */
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '4300' },
    store: { type: 'string', default: './.ota-storage' },
  },
});

const root = path.resolve(values.store!);
const store = new LocalObjectStore(root);
// 로컬에서는 CLI 로 바꾼 상태가 바로 보이도록 캐시를 끈다.
const resolve = createResolveHandler({ store, cacheMs: 0 });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const started = Date.now();
  let status = 500;
  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await resolve({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      });
      status = out.status;
      res.writeHead(out.status, out.headers).end(out.body);
    } else if (url.pathname.startsWith('/releases/') && req.method === 'GET') {
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) {
        status = 400;
        res.writeHead(400).end();
      } else {
        const body = await readFile(file).catch(() => null);
        status = body ? 200 : 404;
        if (body) {
          res.writeHead(200, {
            'content-type': 'application/javascript',
            'cache-control': 'public, max-age=31536000, immutable',
          }).end(body);
        } else {
          res.writeHead(404).end();
        }
      }
    } else {
      status = 404;
      res.writeHead(404).end();
    }
  } catch (err) {
    console.error(err);
    res.writeHead(500).end();
  } finally {
    const who = url.searchParams.get('userId');
    console.log(`${new Date().toISOString()} ${req.method} ${status} ${url.pathname}${who ? ` user=${who}` : ''} ${Date.now() - started}ms`);
  }
});

server.listen(Number(values.port), () => {
  console.log(`ota 로컬 서버: http://localhost:${values.port} (저장소 ${root})`);
});
