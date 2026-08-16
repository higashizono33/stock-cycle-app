import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface AuthConstructProps {
  /**
   * LINEデベロッパーコンソールで発行するLINE LoginチャネルのChannel ID。
   * `cdk deploy -c lineChannelId=xxxx` で指定する。
   */
  lineChannelId: string;
  /**
   * LINE LoginチャネルのChannel secret。**平文でコミットしない。**
   * `cdk deploy -c lineChannelSecret=xxxx` のように deploy 時のみ渡す想定
   * (contextの明示的な `-c` 指定はcdk.context.jsonにキャッシュされない)。
   */
  lineChannelSecret: string;
  /** デプロイ済みフロントエンドのURL(S3静的ホスティング)。Cognitoのコールバック/ログアウト先として登録する。 */
  dashboardUrl: string;
}

/**
 * 認証レイヤー(要件定義書 5章・6章「認証方式: LINEログイン連携」)。
 * LINE LoginはOIDC準拠(issuer: https://access.line.me)のため、Cognito User Poolの
 * 外部OIDC IDプロバイダとして連携する。Cognito自体のユーザー名/パスワードでの
 * セルフサインアップは無効化し、LINEログインのみを許可する。
 */
export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly lineIdentityProvider: cognito.UserPoolIdentityProviderOidc;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'stock-cycle-app-family',
      selfSignUpEnabled: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.lineIdentityProvider = new cognito.UserPoolIdentityProviderOidc(this, 'LineIdP', {
      userPool: this.userPool,
      name: 'LINE',
      clientId: props.lineChannelId,
      clientSecret: props.lineChannelSecret,
      issuerUrl: 'https://access.line.me',
      scopes: ['openid', 'profile'],
      attributeMapping: {
        preferredUsername: cognito.ProviderAttribute.other('name'),
        profilePicture: cognito.ProviderAttribute.other('picture'),
      },
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: `stock-cycle-app-${Stack.of(this).account}` },
    });

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      generateSecret: false,
      // LINE経由の認可コードフローのみ許可(Cognito自前のユーザー名/パスワード直入力は不可)
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.custom(this.lineIdentityProvider.providerName)],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        // Cognitoはcallback/logout URLを完全一致で照合するため、末尾スラッシュあり/なし両方を登録しておく
        callbackUrls: ['http://localhost:5173/', props.dashboardUrl, `${props.dashboardUrl}/`],
        logoutUrls: ['http://localhost:5173/', props.dashboardUrl, `${props.dashboardUrl}/`],
      },
      accessTokenValidity: Duration.hours(12),
      idTokenValidity: Duration.hours(12),
      refreshTokenValidity: Duration.days(30),
    });
    this.userPoolClient.node.addDependency(this.lineIdentityProvider);
  }
}
