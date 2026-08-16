import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({});
let cachedChannelAccessToken: string | undefined;
let cachedChannelSecret: string | undefined;

/**
 * LINE Messaging APIのチャネルアクセストークン・チャネルシークレットは
 * Secrets Managerに保管する(CDKのコードにもcdk.context.jsonにも平文を残さない)。
 * シークレット名は infra/lib/constructs/notification.ts で払い出す。
 */
async function getSecret(envVarName: string, cache: string | undefined): Promise<string> {
  if (cache) return cache;
  const secretId = process.env[envVarName]!;
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) throw new Error(`secret ${secretId} has no SecretString`);
  return result.SecretString;
}

export async function getChannelAccessToken(): Promise<string> {
  cachedChannelAccessToken = await getSecret('LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID', cachedChannelAccessToken);
  return cachedChannelAccessToken;
}

export async function getChannelSecret(): Promise<string> {
  cachedChannelSecret = await getSecret('LINE_CHANNEL_SECRET_SECRET_ID', cachedChannelSecret);
  return cachedChannelSecret;
}

/** Webhookの `X-Line-Signature` 検証 (LINEドキュメント: HMAC-SHA256 + Base64) */
export function verifySignature(rawBody: string, signatureHeader: string | undefined, channelSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** requirements.md §3.1: アプリ側で発行する連携コード(linkToken)。ユーザーはLINEアプリ内の
 * アカウント連携ダイアログでこれを承認し、webhookに accountLink イベントが飛んでくる。 */
export async function issueLinkToken(lineUserId: string): Promise<string> {
  const accessToken = await getChannelAccessToken();
  const res = await fetch(`https://api.line.me/v2/bot/user/${lineUserId}/linkToken`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`issueLinkToken failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { linkToken: string };
  return body.linkToken;
}

export interface RestockFlexItem {
  emoji: string;
  name: string;
  daysLeft: number;
}

/** requirements.md §5: Flex Message形式、「買った」アクションボタン付き */
export function buildRestockFlexMessage(items: RestockFlexItem[], appUrl: string) {
  return {
    type: 'flex',
    altText: `Time to restock: ${items.map((i) => i.name).join(', ')}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🔔 Time to restock soon', weight: 'bold', size: 'md' },
          ...items.map((it) => ({
            type: 'text' as const,
            text: `${it.emoji} ${it.name} (${it.daysLeft}d left)`,
            size: 'sm' as const,
            wrap: true,
          })),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: { type: 'uri', label: 'I bought this', uri: appUrl },
          },
        ],
      },
    },
  };
}

export async function replyMessage(replyToken: string, messages: unknown[]): Promise<void> {
  const accessToken = await getChannelAccessToken();
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) throw new Error(`replyMessage failed: ${res.status} ${await res.text()}`);
}

export async function pushMessage(lineUserId: string, messages: unknown[]): Promise<void> {
  const accessToken = await getChannelAccessToken();
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: lineUserId, messages }),
  });
  if (!res.ok) throw new Error(`pushMessage failed: ${res.status} ${await res.text()}`);
}
