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
   * 対応していないため、こちらのマルチモーダルモデルを使う(2026-08-16変更)。
   * 当初はAnthropicモデル利用の申請フォーム未提出でClaudeを呼び出せず、Amazon自社
   * モデルの中で最上位のNova Proを暫定採用していたが、フォーム提出・承認後は
   * 精度の高いClaude Sonnet 4.5に切り替えた(2026-08-16)。 */
  bedrockVisionModelId?: string;
}

/**
 * ストックサイクルアプリのAWSインフラ一式(要件定義書 v1 7章に対応)。
 * コスト最小構成: サーバーレス・オンデマンド課金のみで構成。
 */
export class StockCycleAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StockCycleAppStackProps) {
    super(scope, id, props);

    // 2026-08-16: us-east-2はNova/Claude系モデルの直接提供リージョンではなく、クロス
    // リージョン推論プロファイル("us."プレフィックス)経由でのみ呼び出せる。そのため
    // モデルIDはプロファイルID形式にする(ApiConstruct側のIAMポリシーも合わせて対応済み)。
    const bedrockModelId = props.bedrockModelId ?? 'us.amazon.nova-micro-v1:0';
    // vision(レシートOCR)はNova Liteで実機検証したところ、回転・ブレた実物の日本語
    // レシート写真で店舗名・日付・明細のすべてが実在しない内容に化ける事例が発生した。
    // 当初はAnthropicモデル利用の申請フォーム未提出でClaudeを呼び出せずNova Proを
    // 暫定採用していたが、フォーム提出・承認後はClaude Sonnet 4.5に切り替えた。
    const bedrockVisionModelId = props.bedrockVisionModelId ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

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
