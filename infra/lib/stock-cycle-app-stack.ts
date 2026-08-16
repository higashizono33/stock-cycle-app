import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StorageConstruct } from './constructs/storage.js';
import { AuthConstruct } from './constructs/auth.js';
import { ApiConstruct } from './constructs/api.js';
import { NotificationConstruct } from './constructs/notification.js';
import { BudgetConstruct } from './constructs/budget.js';

export interface StockCycleAppStackProps extends cdk.StackProps {
  /** LINE LoginチャネルのChannel ID (`cdk deploy -c lineChannelId=...`) */
  lineChannelId: string;
  /** LINE LoginチャネルのChannel secret (`cdk deploy -c lineChannelSecret=...`)。平文でコミットしない */
  lineChannelSecret: string;
  /** AWS Budgets通知先メールアドレス */
  budgetAlertEmail?: string;
  monthlyBudgetLimitUsd?: number;
  /** Bedrockでの商品名正規化に使うモデルID(要件定義書7章「低コストなNova Microに固定」) */
  bedrockModelId?: string;
  /** レシート画像のOCR+構造化抽出に使うvision対応モデルID。Textractは日本語レシートに
   * 対応していないため、こちらのマルチモーダルモデルを使う(2026-08-16変更) */
  bedrockVisionModelId?: string;
}

/**
 * ストックサイクルアプリのAWSインフラ一式(要件定義書 v1 7章に対応)。
 * コスト最小構成: サーバーレス・オンデマンド課金のみで構成。
 */
export class StockCycleAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StockCycleAppStackProps) {
    super(scope, id, props);

    // 2026-08-16: us-east-2はNova系モデルの直接提供リージョンではなく、クロスリージョン
    // 推論プロファイル("us."プレフィックス)経由でのみ呼び出せる。そのためモデルIDは
    // プロファイルID形式にする(ApiConstruct側のIAMポリシーも合わせて対応済み)。
    const bedrockModelId = props.bedrockModelId ?? 'us.amazon.nova-micro-v1:0';
    const bedrockVisionModelId = props.bedrockVisionModelId ?? 'us.amazon.nova-lite-v1:0';

    const storage = new StorageConstruct(this, 'Storage');
    const dashboardUrl = `https://${storage.dashboardDistribution.distributionDomainName}`;
    const auth = new AuthConstruct(this, 'Auth', {
      lineChannelId: props.lineChannelId,
      lineChannelSecret: props.lineChannelSecret,
      dashboardUrl,
    });
    const notification = new NotificationConstruct(this, 'Notification', {
      storage,
      dashboardUrl,
    });
    const api = new ApiConstruct(this, 'Api', {
      storage,
      auth,
      lineChannelSecret: notification.lineChannelSecret,
      lineChannelAccessTokenSecret: notification.lineChannelAccessTokenSecret,
      bedrockModelId,
      bedrockVisionModelId,
    });
    new BudgetConstruct(this, 'Budget', {
      alertEmail: props.budgetAlertEmail,
      monthlyLimitUsd: props.monthlyBudgetLimitUsd,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'DashboardUrl', { value: dashboardUrl });
    new cdk.CfnOutput(this, 'DashboardBucketName', { value: storage.dashboardBucket.bucketName });
    new cdk.CfnOutput(this, 'DashboardDistributionId', { value: storage.dashboardDistribution.distributionId });
    new cdk.CfnOutput(this, 'ReceiptsBucketName', { value: storage.receiptsBucket.bucketName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolHostedUiDomain', { value: auth.userPoolDomain.domainName });
    new cdk.CfnOutput(this, 'LineChannelSecretArn', { value: notification.lineChannelSecret.secretArn });
    new cdk.CfnOutput(this, 'LineChannelAccessTokenSecretArn', {
      value: notification.lineChannelAccessTokenSecret.secretArn,
    });
  }
}
