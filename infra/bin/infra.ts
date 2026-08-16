#!/usr/bin/env node
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { StockCycleAppStack } from '../lib/stock-cycle-app-stack.js';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-2',
};

// LINE Developersコンソールで発行するLINE LoginチャネルのID/シークレット。
// シークレットは平文でリポジトリに残さないこと: `cdk deploy -c lineChannelId=xxx -c lineChannelSecret=xxx`
// のように明示的な-cフラグでのみ渡す(cdk.context.jsonには自動キャッシュされない)。
const lineChannelId = (app.node.tryGetContext('lineChannelId') as string | undefined) ?? '';
const lineChannelSecret = (app.node.tryGetContext('lineChannelSecret') as string | undefined) ?? '';

new StockCycleAppStack(app, 'StockCycleAppStack', {
  env,
  description: 'Stock Cycle App (requirements.md v1) - 日用品消耗品の購入サイクルをレシートOCR+LLMで学習し、LINEでリマインドする家族共有アプリ',
  lineChannelId,
  lineChannelSecret,
  budgetAlertEmail: app.node.tryGetContext('budgetAlertEmail') as string | undefined,
});
