import * as cdk from 'aws-cdk-lib';

import { OtaStack } from '../lib/stack.ts';

const app = new cdk.App();

// cdk deploy -c githubRepo=<owner>/<repo> 처럼 넘기면 CI 배포 역할까지 만든다.
const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
const githubOidcProviderArn = app.node.tryGetContext('githubOidcProviderArn') as string | undefined;
// -c githubEnvironments=prod,beta 처럼 쉼표로. 기본 prod.
const githubEnvironments = (app.node.tryGetContext('githubEnvironments') as string | undefined)?.split(',');
const reservedConcurrency = Number(app.node.tryGetContext('reservedConcurrency')) || undefined;

new OtaStack(app, 'RnFederatedOta', {
  ...(githubRepo ? { githubRepo } : {}),
  ...(githubOidcProviderArn ? { githubOidcProviderArn } : {}),
  ...(githubEnvironments ? { githubEnvironments } : {}),
  ...(reservedConcurrency ? { reservedConcurrency } : {}),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
