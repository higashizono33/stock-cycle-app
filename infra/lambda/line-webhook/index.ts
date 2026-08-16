import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FAMILY_MEMBERS_TABLE_NAME, LINK_CODES_TABLE_NAME } from '../shared/db.js';
import { errorResponse, jsonResponse } from '../shared/http.js';
import { getChannelSecret, replyMessage, verifySignature } from '../shared/line.js';

const CODE_PATTERN = /^\d{6}$/;

interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source: { userId?: string };
  message?: { type: string; text?: string };
}

async function handleLinkCode(event: LineWebhookEvent, code: string): Promise<void> {
  const userId = event.source.userId;
  if (!userId || !event.replyToken) return;

  const codeRecord = await ddb.send(new GetCommand({ TableName: LINK_CODES_TABLE_NAME, Key: { code } }));
  if (!codeRecord.Item) {
    await replyMessage(event.replyToken, [{ type: 'text', text: 'That code is invalid or expired. Please generate a new one in the app.' }]);
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: FAMILY_MEMBERS_TABLE_NAME,
      Key: { familyId: codeRecord.Item.familyId, memberId: codeRecord.Item.memberId },
      UpdateExpression: 'SET lineUserId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }),
  );
  await ddb.send(new DeleteCommand({ TableName: LINK_CODES_TABLE_NAME, Key: { code } }));
  await replyMessage(event.replyToken, [{ type: 'text', text: "Linked! You'll get restock reminders here." }]);
}

/**
 * POST /line/webhook (Cognito未認証 — LINEプラットフォームから直接叩かれるため
 * `X-Line-Signature` をチャネルシークレットで検証する)。
 * requirements.md §3.1: 友だち追加(follow)と、連携コード送信(message)の2種類だけを扱う。
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const rawBody = event.body ?? '';
  const signature = event.headers?.['x-line-signature'];
  const channelSecret = await getChannelSecret();

  if (!verifySignature(rawBody, signature, channelSecret)) {
    return errorResponse(401, 'invalid signature');
  }

  const payload = JSON.parse(rawBody) as { events: LineWebhookEvent[] };

  for (const evt of payload.events ?? []) {
    if (evt.type === 'follow' && evt.replyToken) {
      await replyMessage(evt.replyToken, [
        { type: 'text', text: 'Thanks for adding StockCycle! Open the app, pick your name, and send the 6-digit code here to finish linking.' },
      ]);
      continue;
    }

    if (evt.type === 'message' && evt.message?.type === 'text' && CODE_PATTERN.test(evt.message.text ?? '')) {
      await handleLinkCode(evt, evt.message.text!);
    }
  }

  return jsonResponse(200, { ok: true });
}
