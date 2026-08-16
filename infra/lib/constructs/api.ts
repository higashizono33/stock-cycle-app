import * as path from 'node:path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { AuthConstruct } from './auth.js';
import type { StorageConstruct } from './storage.js';

export interface ApiConstructProps {
  storage: StorageConstruct;
  auth: AuthConstruct;
  lineChannelSecret: secretsmanager.ISecret;
  lineChannelAccessTokenSecret: secretsmanager.ISecret;
  bedrockModelId: string;
  /** レシート画像のOCR+構造化抽出に使うvision対応モデル(要件定義書3.2章参照)。
   * Textract(AnalyzeExpense)は英語のみ対応で日本語レシートが読めないため、
   * こちらのマルチモーダルモデルに置き換えた(2026-08-16)。 */
  bedrockVisionModelId: string;
}

const LAMBDA_DIR = path.join(__dirname, '..', '..', 'lambda');

/**
 * Lambda関数群 + HTTP API(要件定義書3章 ユーザーフロー / 7章 AWS技術スタック案 に対応)。
 * すべてサーバーレス構成(API Gateway + Lambda)、Cognito(LINEログイン連携)でJWT認証する。
 * `/line/webhook` のみLINEプラットフォームから直接呼ばれるため認証なし(署名検証は
 * Lambda内で実施)。
 */
export class ApiConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    const { storage, auth } = props;
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    const commonEnv = {
      FAMILY_ID: 'default',
      ITEMS_TABLE_NAME: storage.itemsTable.tableName,
      PURCHASES_TABLE_NAME: storage.purchasesTable.tableName,
      FAMILY_MEMBERS_TABLE_NAME: storage.familyMembersTable.tableName,
      SETTINGS_TABLE_NAME: storage.settingsTable.tableName,
      LINK_CODES_TABLE_NAME: storage.linkCodesTable.tableName,
      RECEIPTS_BUCKET_NAME: storage.receiptsBucket.bucketName,
      LINE_CHANNEL_SECRET_SECRET_ID: props.lineChannelSecret.secretArn,
      LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: props.lineChannelAccessTokenSecret.secretArn,
      BEDROCK_MODEL_ID: props.bedrockModelId,
      BEDROCK_VISION_MODEL_ID: props.bedrockVisionModelId,
    };

    const nodeJsFunctionDefaults: Partial<NodeJsFunctionPropsLike> = {
      runtime: lambda.Runtime.NODEJS_LATEST,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    };

    const fn = (name: string, extra: Partial<NodeJsFunctionPropsLike> = {}) =>
      new NodejsFunction(this, `${pascalCase(name)}Fn`, {
        ...nodeJsFunctionDefaults,
        ...extra,
        entry: path.join(LAMBDA_DIR, name, 'index.ts'),
        environment: commonEnv,
      });

    // --- receipts: presigned upload + OCR/LLMスキャン(要件定義書3.2章) ---
    const presignReceiptUploadFn = fn('presign-receipt-upload');
    storage.receiptsBucket.grantPut(presignReceiptUploadFn);

    const scanReceiptFn = fn('scan-receipt', { timeout: Duration.seconds(60), memorySize: 512 });
    storage.receiptsBucket.grantRead(scanReceiptFn);
    // us-east-2はNova/Claude系モデルの直接提供リージョンではなく、クロスリージョン推論プロファイル
    // ("us."プレフィックスのモデルID)経由でしか呼べない(2026-08-16判明)。そのため
    // InvokeModelの許可は (1) このリージョンの推論プロファイルARN と
    // (2) プロファイルが実際にルーティングし得る先の各リージョンのfoundation-model ARN
    // の両方が必要。ルーティング先リージョンはAWS側で変わり得るため、リージョン部分は
    // ワイルドカードにしておく(foundation-model ARNはそもそもアカウントIDを含まない)。
    scanReceiptFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/${props.bedrockModelId}`,
          `arn:aws:bedrock:${region}:${account}:inference-profile/${props.bedrockVisionModelId}`,
          `arn:aws:bedrock:*::foundation-model/*`,
        ],
      }),
    );

    // --- purchases / items: 在庫一覧・購入履歴(要件定義書3.2-3.3章) ---
    const purchasesFn = fn('purchases');
    storage.itemsTable.grantReadWriteData(purchasesFn);
    storage.purchasesTable.grantWriteData(purchasesFn);

    const itemsFn = fn('items');
    storage.itemsTable.grantReadWriteData(itemsFn);
    storage.purchasesTable.grantReadWriteData(itemsFn);

    // --- family / settings ---
    const familyFn = fn('family');
    storage.familyMembersTable.grantReadData(familyFn);

    const settingsFn = fn('settings');
    storage.settingsTable.grantReadWriteData(settingsFn);

    // --- LINEアカウント連携(要件定義書3.1章) ---
    const lineLinkFn = fn('line-link');
    storage.linkCodesTable.grantWriteData(lineLinkFn);

    const lineWebhookFn = fn('line-webhook');
    storage.linkCodesTable.grantReadWriteData(lineWebhookFn);
    storage.familyMembersTable.grantReadWriteData(lineWebhookFn);
    props.lineChannelSecret.grantRead(lineWebhookFn);
    props.lineChannelAccessTokenSecret.grantRead(lineWebhookFn);

    // --- HTTP API (Cognito JWT認証。/line/webhookだけ認証なし) ---
    const authorizer = new HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${region}.amazonaws.com/${auth.userPool.userPoolId}`,
      { jwtAudience: [auth.userPoolClient.userPoolClientId] },
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH],
        allowHeaders: ['authorization', 'content-type'],
      },
      defaultAuthorizer: authorizer,
    });

    this.httpApi.addRoutes({
      path: '/receipts/upload-url',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PresignReceiptUploadIntegration', presignReceiptUploadFn),
    });
    this.httpApi.addRoutes({
      path: '/receipts/scan',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ScanReceiptIntegration', scanReceiptFn),
    });
    this.httpApi.addRoutes({
      path: '/purchases',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PurchasesIntegration', purchasesFn),
    });
    this.httpApi.addRoutes({
      path: '/items',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ListItemsIntegration', itemsFn),
    });
    this.httpApi.addRoutes({
      path: '/items/{itemId}',
      methods: [apigwv2.HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('PatchItemIntegration', itemsFn),
    });
    this.httpApi.addRoutes({
      path: '/items/{itemId}/bought',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('MarkBoughtIntegration', itemsFn),
    });
    this.httpApi.addRoutes({
      path: '/family',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('FamilyIntegration', familyFn),
    });
    this.httpApi.addRoutes({
      path: '/settings',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration('SettingsIntegration', settingsFn),
    });
    this.httpApi.addRoutes({
      path: '/line/link',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('LineLinkIntegration', lineLinkFn),
    });
    this.httpApi.addRoutes({
      path: '/line/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('LineWebhookIntegration', lineWebhookFn),
      authorizer: new apigwv2.HttpNoneAuthorizer(), // LINEプラットフォームが直接呼ぶため。署名検証はLambda内で実施
    });
  }
}

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// NodejsFunctionPropsの一部だけを共通デフォルトとして使い回すためのゆるい型
type NodeJsFunctionPropsLike = {
  runtime: lambda.Runtime;
  architecture: lambda.Architecture;
  memorySize: number;
  timeout: Duration;
  bundling: { minify: boolean; sourceMap: boolean; target: string };
};
