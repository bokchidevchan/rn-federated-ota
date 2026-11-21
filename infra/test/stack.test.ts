import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { OtaStack } from '../lib/stack.ts';

// NodejsFunction 이 합성 때 esbuild 로 Lambda 를 묶으므로 한 번만 만든다.
const template = Template.fromStack(new OtaStack(new cdk.App(), 'Test', { githubRepo: 'example/rn-federated-ota' }));

test('버킷은 공개 접근을 전부 막고, 버전 관리와 HTTPS 강제를 켠다', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    VersioningConfiguration: { Status: 'Enabled' },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
      ]),
    },
  });
});

test('CDN 은 /releases/* 만 S3 로 보내고 길게 캐시한다. 나머지는 캐시 없는 Lambda 다', () => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as {
    Properties: { DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: string }; CacheBehaviors: { PathPattern: string; CachePolicyId: string }[] } };
  };
  const config = dist.Properties.DistributionConfig;
  assert.equal(config.CacheBehaviors.length, 1);
  assert.equal(config.CacheBehaviors[0]!.PathPattern, 'releases/*');
  // AWS 관리형 정책 id: CachingOptimized, CachingDisabled
  assert.equal(config.CacheBehaviors[0]!.CachePolicyId, '658327ea-f89d-4fab-a63d-7e88639e58f6');
  assert.equal(config.DefaultCacheBehavior.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
});

test('Lambda 는 IAM 인증 Function URL 뒤에 있고, CloudFront 만 부를 수 있다', () => {
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
});

test('Lambda 의 S3 권한은 manifests/* 읽기뿐이다', () => {
  const policies = template.findResources('AWS::IAM::Policy');
  const lambdaPolicy = Object.entries(policies).find(([id]) => id.startsWith('ResolveServiceRoleDefaultPolicy'));
  assert.ok(lambdaPolicy, 'Lambda 정책이 있어야 한다');
  const text = JSON.stringify(lambdaPolicy[1]);
  assert.match(text, /manifests\/\*/);
  assert.doesNotMatch(text, /s3:PutObject|s3:DeleteObject/);
  assert.doesNotMatch(text, /releases\//);
});

test('CI 역할은 이 저장소의 main 브랜치나 Environment OIDC 로만 맡을 수 있고 삭제 권한이 없다', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            StringLike: {
              'token.actions.githubusercontent.com:sub': [
                'repo:example/rn-federated-ota:ref:refs/heads/main',
                'repo:example/rn-federated-ota:environment:*',
              ],
            },
          },
        }),
      ],
    },
  });
  const ciPolicy = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('GithubDeployRole'));
  assert.ok(ciPolicy);
  assert.doesNotMatch(JSON.stringify(ciPolicy[1]), /s3:DeleteObject"/);
});
