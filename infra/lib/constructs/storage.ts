import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * 保存レイヤー: S3(レシート画像・ダッシュボード静的サイト) + DynamoDB(商品マスタ・購入履歴・家族・設定)。
 * 要件定義書 4章(データ設計)・6章(非機能要件)・7章(AWS技術スタック案)に対応。
 */
export class StorageConstruct extends Construct {
  /** レシート画像を保存する非公開バケット。30日でライフサイクル自動削除(要件定義書6章) */
  public readonly receiptsBucket: s3.Bucket;
  /** フロントエンド(React/Vite build成果物)の非公開格納バケット。配信はCloudFront経由 */
  public readonly dashboardBucket: s3.Bucket;
  /** ダッシュボードを配信するCloudFrontディストリビューション。HTTPS URLを持つ */
  public readonly dashboardDistribution: cloudfront.Distribution;

  /** 商品マスタ + トラッキング/アラートON-OFF状態。PK: familyId, SK: itemId */
  public readonly itemsTable: dynamodb.Table;
  /** 購入履歴(追記のみ)。PK: itemKey(`${familyId}#${itemId}`), SK: `${date}#${purchaseId}` */
  public readonly purchasesTable: dynamodb.Table;
  /** 固定メンバー一覧(要件定義書9章: MVPでは追加/招待フロー対象外)。PK: familyId, SK: memberId */
  public readonly familyMembersTable: dynamodb.Table;
  /** 家族単位の設定(通知タイミング等)。PK: familyId */
  public readonly settingsTable: dynamodb.Table;
  /**
   * LINEアカウント連携コード(要件定義書3.1章)。PK: code(6桁)。
   * アプリ側で発行した連携コードをユーザーがLINE公式アカウントのチャットに送信し、
   * webhookで受け取ったMessaging API側のuserIdをFamilyMembersTableに書き込む。
   * expiresAt(TTL)で15分後に自動失効・削除する。
   */
  public readonly linkCodesTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // --- S3: レシート画像(非公開、SSE-S3暗号化、30日で自動削除) ---
    // 要件定義書6章「レシート画像の保存: OCR処理後30日で自動削除。個人情報を含む元画像は残さない」
    this.receiptsBucket = new s3.Bucket(this, 'ReceiptsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ id: 'expire-after-30-days', expiration: Duration.days(30) }],
    });

    // クライアントからPresigned URLで直接PUTアップロードできるようCORSを許可
    // (bilingual-appと同じ方針: API Gatewayのペイロード上限を避け、転送コストも抑える)
    this.receiptsBucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
      allowedOrigins: ['*'],
      allowedHeaders: ['*'],
      exposedHeaders: ['ETag'],
      maxAge: 3000,
    });

    // --- S3 + CloudFront: フロントエンド配信 ---
    // 要件定義書7章の想定通りS3+CloudFrontを採用。bilingual-appはS3静的ホスティングのみで
    // 済ませたが、このアプリはCognito Hosted UI(LINEログイン)のコールバックURLが
    // HTTPSでないと登録できない制約があり、S3の素の静的ホスティング(HTTPのみ)では
    // 動かないため、CloudFrontによるHTTPS終端が必須。CloudFrontの無料枠(1TB/月・
    // 1000万リクエスト/月まで恒久無料)の範囲に収まる想定でコストへの影響はほぼない。
    this.dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
      bucketName: `stock-cycle-app-dashboard-${Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.dashboardDistribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.dashboardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      // SPAのクライアントサイドルーティング用に404/403もindex.htmlへフォールバック
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // --- DynamoDB(オンデマンドモード。個人開発規模での無料枠活用を優先) ---

    this.itemsTable = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.purchasesTable = new dynamodb.Table(this, 'PurchasesTable', {
      partitionKey: { name: 'itemKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.familyMembersTable = new dynamodb.Table(this, 'FamilyMembersTable', {
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'memberId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.settingsTable = new dynamodb.Table(this, 'SettingsTable', {
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.linkCodesTable = new dynamodb.Table(this, 'LinkCodesTable', {
      partitionKey: { name: 'code', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY, // 短命な一時データのみのため保持不要
    });
  }
}
