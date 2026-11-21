import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export interface OtaStackProps extends cdk.StackProps {
  /**
   * GitHub Actions 가 배포할 저장소(owner/name). 주면 OIDC 로 맡을 수 있는 배포 역할을 만든다.
   * 계정에 GitHub OIDC 공급자가 이미 있으면 githubOidcProviderArn 으로 넘긴다(계정당 하나만 가능).
   */
  githubRepo?: string;
  githubOidcProviderArn?: string;
}

/**
 * 배포 인프라 전체.
 *
 *   앱 ──HTTPS──▶ CloudFront ─┬─ /releases/*  ──OAC──▶ S3 (번들, 변경 불가, 길게 캐시)
 *                             └─ 그 외(/api/*) ──OAC──▶ Lambda Function URL (resolve, 캐시 없음)
 *
 * 하나의 도메인 아래 두 경로를 둔 이유: 앱은 기준 주소 하나만 알면 되고, TLS 연결도
 * 하나로 재사용된다. 로컬 검증 서버(packages/ota-server/src/local.ts)도 같은 경로 규칙이다.
 *
 * 기본 동작(*)을 Lambda 로 둔 이유: S3 를 기본으로 두면 manifests/*.json 까지 CDN 으로
 * 공개된다. 매니페스트에는 회수된 릴리스와 카나리 비율이 들어 있어 밖에 보일 이유가 없다.
 * /releases/* 만 S3 로 보내고, 나머지는 Lambda 가 404 로 답한다.
 */
export class OtaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OtaStackProps = {}) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'Bundles', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 매니페스트를 실수로 덮어써도 이전 판을 꺼낼 수 있게 한다. 번들은 애초에 덮어쓰지 않는다.
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const resolveFn = new NodejsFunction(this, 'Resolve', {
      entry: path.join(repoRoot, 'packages/ota-server/src/lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment: { OTA_BUCKET: bucket.bucketName },
      // 동시 실행을 묶어 둔다. 앱 시작마다 한 번 불리는 API 라 갑작스러운 폭주가
      // 비용 폭주로 번지지 않게 하는 안전장치. 실제 트래픽에 맞게 조정한다.
      reservedConcurrentExecutions: 50,
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        // Lambda 런타임에 들어 있는 SDK 를 쓴다. 번들이 작아지고 콜드 스타트가 짧아진다.
        externalModules: ['@aws-sdk/*'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
    // Lambda 는 매니페스트만 읽는다. 번들 파일에 대한 권한도, 쓰기 권한도 없다.
    bucket.grantRead(resolveFn, 'manifests/*');

    const resolveUrl = resolveFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'rn-federated-ota',
      defaultBehavior: {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(resolveUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        // 사용자마다 답이 다르다(카나리 버킷). 공유 캐시에 두면 남의 답을 받는다.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        'releases/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          // 릴리스 경로는 내용이 절대 안 바뀐다(id 에 내용 해시). 오래 캐시해도 안전하다.
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    new cdk.CfnOutput(this, 'BaseUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: '앱 빌드 때 OTA_BASE_URL 로 넣는 값',
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'CLI 의 OTA_STORE=s3://<이 값>',
    });

    if (props.githubRepo) {
      this.addGithubDeployRole(bucket, props.githubRepo, props.githubOidcProviderArn);
    }
  }

  /**
   * CI 배포 역할. 장기 액세스 키를 GitHub 에 저장하지 않고 OIDC 로 잠깐 맡는다.
   * 이 저장소의 main 브랜치 실행과 GitHub Environment 실행만 맡을 수 있다.
   * 권한은 번들 업로드와 매니페스트 읽기/쓰기뿐이다. 삭제 권한은 주지 않는다.
   */
  private addGithubDeployRole(bucket: s3.Bucket, repo: string, providerArn?: string): void {
    const provider = providerArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', providerArn)
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const role = new iam.Role(this, 'GithubDeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        // main 브랜치 푸시(deploy-feature)와 승인 규칙이 걸린 Environment 실행(release-control)만.
        // Environment 를 쓰는 job 은 토큰 sub 가 ref 대신 environment 로 바뀌므로 둘 다 적는다.
        StringLike: {
          'token.actions.githubusercontent.com:sub': [`repo:${repo}:ref:refs/heads/main`, `repo:${repo}:environment:*`],
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
      description: 'rn-federated-ota CI deploy',
    });
    bucket.grantPut(role, 'releases/*');
    bucket.grantReadWrite(role, 'manifests/*');

    new cdk.CfnOutput(this, 'GithubDeployRoleArn', { value: role.roleArn });
  }
}
