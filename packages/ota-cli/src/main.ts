#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { bucketOf, ManifestError, promote, rollback, rollbackTarget, startCanary } from '@rn-federated-ota/core';
import type { Platform } from '@rn-federated-ota/core';
import { openStore } from '@rn-federated-ota/storage';

import { readManifest, updateManifest } from './manifestStore.ts';
import { publish } from './publish.ts';
import { runtimeVersionOf, writeRuntimeModule } from './runtime.ts';

const HELP = `ota <명령> [옵션]

  runtime-version <앱 디렉터리> [--write <파일>]   런타임 지문 출력(또는 소스 파일로 기록)
  publish <피처> --app <디렉터리> --android <산출물> [--ios <산출물>] [--note 메모]
                                                  산출물 업로드 + 릴리스 등록(노출 안 함)
  canary  <피처> <릴리스> --ratio <1~99>           일부 사용자에게만 노출
  promote <피처> [릴리스]                          stable 로 올림(생략 시 진행 중인 카나리)
  rollback <피처> [릴리스]                         카나리 회수, 없으면 직전 stable 로(생략 시 지금 상태 기준)
  status [피처]                                    채널 상태 출력
  bucket <피처> <사용자...>                         사용자의 카나리 버킷(0~99) 확인

공통 옵션
  --channel <이름>   기본 prod
  --store <주소>     s3://버킷/접두사 또는 local:./디렉터리. 기본은 OTA_STORE 환경변수, 없으면 local:./.ota-storage
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channel: { type: 'string', default: 'prod' },
      store: { type: 'string', default: process.env.OTA_STORE ?? 'local:./.ota-storage' },
      app: { type: 'string' },
      android: { type: 'string' },
      ios: { type: 'string' },
      note: { type: 'string' },
      ratio: { type: 'string' },
      write: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    process.stdout.write(HELP);
    return;
  }

  const channel = values.channel!;
  const store = () => openStore(values.store!);
  const need = (value: string | undefined, label: string): string => {
    if (!value) throw new Error(`${label} 이(가) 필요합니다\n\n${HELP}`);
    return value;
  };

  switch (command) {
    case 'runtime-version': {
      const appDir = need(args[0], '앱 디렉터리');
      const version = values.write ? await writeRuntimeModule(appDir, values.write) : await runtimeVersionOf(appDir);
      console.log(version);
      return;
    }
    case 'publish': {
      const outputs: Partial<Record<Platform, string>> = {};
      if (values.android) outputs.android = values.android;
      if (values.ios) outputs.ios = values.ios;
      const release = await publish({
        store: store(),
        channel,
        feature: need(args[0], '피처 이름'),
        appDir: need(values.app, '--app'),
        outputs,
        ...(values.note ? { note: values.note } : {}),
        ...(process.env.GITHUB_SHA ? { gitSha: process.env.GITHUB_SHA } : {}),
      });
      console.log(JSON.stringify({ releaseId: release.id, runtimeVersion: release.runtimeVersion }));
      return;
    }
    case 'canary': {
      const feature = need(args[0], '피처 이름');
      const releaseId = need(args[1], '릴리스 id');
      const ratio = Number(need(values.ratio, '--ratio'));
      await updateManifest(store(), channel, (m, at) => startCanary(m, feature, releaseId, ratio, at));
      console.log(`${channel}/${feature}: ${releaseId} 카나리 ${ratio}%`);
      return;
    }
    case 'promote': {
      const feature = need(args[0], '피처 이름');
      const s = store();
      // 대상 id 를 먼저 정해 고정한다. 재시도 때 "그사이 바뀐 카나리"를 올리지 않게.
      const { manifest } = await readManifest(s, channel);
      const state = manifest?.features[feature];
      const target = args[1] ?? state?.canary?.releaseId;
      if (!target) throw new ManifestError(`올릴 릴리스를 지정하세요. 진행 중인 카나리도 없습니다: ${feature}`);
      if (state?.canary && state.canary.releaseId !== target) {
        console.warn(`주의: 진행 중이던 카나리 ${state.canary.releaseId} 는 회수 없이 종료됩니다`);
      }
      const m = await updateManifest(s, channel, (cur, at) => promote(cur, feature, target, at));
      console.log(`${channel}/${feature}: stable = ${m.features[feature]!.stable}`);
      return;
    }
    case 'rollback': {
      const feature = need(args[0], '피처 이름');
      const s = store();
      const { manifest } = await readManifest(s, channel);
      if (!manifest) throw new ManifestError(`${channel}: 매니페스트가 없습니다`);
      const target = args[1] ?? rollbackTarget(manifest, feature);
      const m = await updateManifest(s, channel, (cur, at) => rollback(cur, feature, target, at));
      console.log(`${channel}/${feature}: ${target} 회수, stable = ${m.features[feature]!.stable ?? '(없음)'}, canary = 없음`);
      return;
    }
    case 'status': {
      const { manifest } = await readManifest(store(), channel);
      if (!manifest) {
        console.log(`${channel}: 매니페스트 없음`);
        return;
      }
      const names = args[0] ? [args[0]] : Object.keys(manifest.features);
      for (const name of names) {
        const s = manifest.features[name];
        if (!s) continue;
        console.log(`${name}  stable=${s.stable ?? '-'}  canary=${s.canary ? `${s.canary.releaseId}@${s.canary.ratio}%` : '-'}`);
        for (const r of s.releases) {
          const flags = [r.id === s.stable ? 'STABLE' : '', r.revokedAt ? 'REVOKED' : ''].filter(Boolean).join(',');
          console.log(`  ${r.id}  ${r.runtimeVersion}  ${Object.keys(r.platforms).join('+')}  ${flags}  ${r.note ?? ''}`);
        }
      }
      return;
    }
    case 'bucket': {
      const feature = need(args[0], '피처 이름');
      for (const user of args.slice(1)) console.log(`${user}\t${bucketOf(feature, user)}`);
      return;
    }
    default:
      throw new Error(`모르는 명령: ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
