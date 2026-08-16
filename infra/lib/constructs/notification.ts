import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { StorageConstruct } from './storage.js';

export interface NotificationConstructProps {
  storage: StorageConstruct;
  dashboardUrl: string;
}

const LAMBDA_DIR = path.join(__dirname, '..', '..', 'lambda');

/**
 * LINEリマインドバッチ(要件定義書5章・7章)。EventBridge Schedulerで毎日1回起動し、
 * 予想購入日が近いアイテムをLINE Messaging APIでプッシュ通知する。
 *
 * LINEのチャネルシークレット/チャネルアクセストークンはCDKコードにもコンテキストにも
 * 平文を残さないよう、空のSecrets Managerシークレットだけをここで作成する。
 * 実際の値は `cdk deploy` 後に手動で投入する:
 *   aws secretsmanager put-secret-value --secret-id <LineChannelSecretArn> --secret-string '...'
 *   aws secretsmanager put-secret-value --secret-id <LineChannelAccessTokenSecretArn> --secret-string '...'
 */
export class NotificationConstruct extends Construct {
  public readonly lineChannelSecret: secretsmanager.ISecret;
  public readonly lineChannelAccessTokenSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: NotificationConstructProps) {
    super(scope, id);

    this.lineChannelSecret = new secretsmanager.Secret(this, 'LineChannelSecret', {
      description: 'LINE Messaging API channel secret (webhook署名検証用)。デプロイ後に手動投入する。',
    });
    this.lineChannelAccessTokenSecret = new secretsmanager.Secret(this, 'LineChannelAccessTokenSecret', {
      description: 'LINE Messaging API channel access token (push/reply送信用)。デプロイ後に手動投入する。',
    });

    const { storage } = props;

    const reminderBatchFn = new NodejsFunction(this, 'ReminderBatchFn', {
      runtime: lambda.Runtime.NODEJS_LATEST,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      entry: path.join(LAMBDA_DIR, 'reminder-batch', 'index.ts'),
      environment: {
        FAMILY_ID: 'default',
        ITEMS_TABLE_NAME: storage.itemsTable.tableName,
        PURCHASES_TABLE_NAME: storage.purchasesTable.tableName,
        FAMILY_MEMBERS_TABLE_NAME: storage.familyMembersTable.tableName,
        SETTINGS_TABLE_NAME: storage.settingsTable.tableName,
        LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: this.lineChannelAccessTokenSecret.secretArn,
        DASHBOARD_URL: props.dashboardUrl,
      },
    });

    storage.itemsTable.grantReadWriteData(reminderBatchFn); // read + lastNotifiedForの書き戻し
    storage.purchasesTable.grantReadData(reminderBatchFn);
    storage.familyMembersTable.grantReadData(reminderBatchFn);
    storage.settingsTable.grantReadData(reminderBatchFn);
    this.lineChannelAccessTokenSecret.grantRead(reminderBatchFn);

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    reminderBatchFn.grantInvoke(schedulerRole);

    // requirements.md §3.3手順3: 予想購入日の2〜3日前チェックを毎日実施
    new scheduler.CfnSchedule(this, 'DailyReminderSchedule', {
      scheduleExpression: 'cron(0 14 * * ? *)', // UTC 14:00 = US東部 9-10時台(DST考慮せず概算)
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: reminderBatchFn.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });
  }
}
