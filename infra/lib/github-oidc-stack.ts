import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** "owner/repo" 形式(例: "higashizono33/stock-cycle-app") */
  githubRepo: string;
  /** このロールを引き受けられるブランチ。デフォルトはmainのみ */
  allowedBranch?: string;
  /**
   * GitHubの repository_owner_id / repository_id (不変ID)。指定すると sub クレームの
   * 条件が `repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/<branch>` という
   * 不変ID付き形式になる。bilingual-appで実際にOIDCトークンをデコードして確認済みの形式
   * (2026-08-15)。未指定の場合は従来形式 `repo:<owner>/<repo>:ref:refs/heads/<branch>` を使う。
   */
  githubRepoOwnerId?: string;
  githubRepoId?: string;
}

/**
 * GitHub Actionsからのデプロイ用OIDC連携。長期アクセスキーをGitHub Secretsに
 * 置かず、GitHub OIDCでIAMロールを一時的にAssumeする方式(bilingual-appと同じ構成)。
 *
 * このスタックは他のスタック(StockCycleAppStack)をデプロイするためのIAMロールそのものを
 * 作るため、GitHub Actions自身にはデプロイさせず、Takashiさんが自分のAWS管理者権限で
 * 手動デプロイする:
 *
 *   cd infra && npx cdk deploy StockCycleAppGitHubOidcStack -c githubRepo=higashizono33/stock-cycle-app \
 *     -c githubRepoOwnerId=76578515 -c githubRepoId=<repo id>
 *
 * 出力される DeployRoleArn を GitHub Secrets の AWS_DEPLOY_ROLE_ARN に設定する。
 *
 * スタック名を "GitHubOidcStack" にしてはいけない: bilingual-appが同じAWSアカウント/
 * リージョンに同名のスタックをデプロイしており、CloudFormationのスタック名は
 * アカウント+リージョン単位でグローバルに一意なため、名前が衝突するとお互いの
 * デプロイロールを上書き・削除してしまう(実際に事故った)。
 */
export class GitHubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);

    const allowedBranch = props.allowedBranch ?? 'main';

    const [githubOwner, githubRepoName] = props.githubRepo.split('/');
    const subOwner = props.githubRepoOwnerId ? `${githubOwner}@${props.githubRepoOwnerId}` : githubOwner;
    const subRepo = props.githubRepoId ? `${githubRepoName}@${props.githubRepoId}` : githubRepoName;
    const subClaim = `repo:${subOwner}/${subRepo}:ref:refs/heads/${allowedBranch}`;

    // 1アカウントにつきGitHub用OIDCプロバイダは1つしか作成できない。bilingual-appの
    // デプロイで既に同じAWSアカウントに作成済みのため、新規作成せず既存のものをimportする。
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: 'stock-cycle-app-github-actions-deploy',
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': subClaim },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: `Deploy role for GitHub Actions (${props.githubRepo}@${allowedBranch}) to deploy StockCycleAppStack`,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStockCycleAppStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/StockCycleAppStack/*`],
      }),
    );

    // バケット名はStorageConstructで `stock-cycle-app-dashboard-<account>` に固定しているため、
    // ブートストラップ前でもこの時点でARNを組み立てられる
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncDashboardBucket',
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::stock-cycle-app-dashboard-${this.account}`,
          `arn:aws:s3:::stock-cycle-app-dashboard-${this.account}/*`,
        ],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateDashboardDistribution',
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}
