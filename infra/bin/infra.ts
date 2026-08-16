#!/usr/bin/env node
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { StockCycleAppStack } from '../lib/stock-cycle-app-stack.js';
import { GitHubOidcStack } from '../lib/github-oidc-stack.js';

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

// GitHub Actionsからのデプロイ用OIDCロール。このスタックだけはTakashiさんが自分のAWS管理者
// 権限で手動デプロイする(CI/CD自身の認証手段をCI/CDには作らせない)。
// `cdk deploy StockCycleAppGitHubOidcStack -c githubRepo=owner/repo` で明示的に指定する。
//
// スタック名は "GitHubOidcStack" にしないこと: bilingual-appの同名スタックと同じAWSアカウント
// /リージョンにデプロイされるため、CloudFormationのスタック名衝突でお互いのデプロイロールを
// 上書きしてしまう(2026-08-16に実際に発生し、bilingual-app側のロールを一度壊した事故の教訓)。
const githubRepo = (app.node.tryGetContext('githubRepo') as string | undefined) ?? 'higashizono33/stock-cycle-app';
const githubRepoOwnerId = (app.node.tryGetContext('githubRepoOwnerId') as string | undefined) ?? '76578515';
const githubRepoId = app.node.tryGetContext('githubRepoId') as string | undefined;
new GitHubOidcStack(app, 'StockCycleAppGitHubOidcStack', {
  env,
  description: 'GitHub Actions用のOIDCデプロイ用IAMロール(手動デプロイ専用)',
  githubRepo,
  githubRepoOwnerId,
  githubRepoId,
});
