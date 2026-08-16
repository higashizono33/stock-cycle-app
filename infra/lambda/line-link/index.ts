import { randomInt } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, LINK_CODES_TABLE_NAME } from '../shared/db.js';
import { errorResponse, FAMILY_ID, jsonResponse } from '../shared/http.js';

const CODE_TTL_SECONDS = 15 * 60;

interface RequestBody {
  memberId?: string;
}

/**
 * POST /line/link
 * requirements.md §3.1「アプリ側で連携コードを発行し、LINEアカウントとアプリアカウントを
 * 紐付け」。LINEの公式Account Link APIより単純な、チャット送信ベースの連携:
 * 1. ログイン中のユーザーが「自分はどのメンバーか」を選び、このAPIでコードを発行
 * 2. アプリ画面に表示されたコードをLINE公式アカウントのチャットに送信してもらう
 * 3. webhook(line-webhook)がコードをメッセージから受け取り、Messaging APIのuserIdを
 *    FamilyMembersTableに書き込む
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return errorResponse(405, `unsupported method: ${event.requestContext.http.method}`);
  }

  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errorResponse(400, 'invalid JSON body');
  }
  if (!body.memberId) return errorResponse(400, 'memberId is required');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;

  await ddb.send(
    new PutCommand({
      TableName: LINK_CODES_TABLE_NAME,
      Item: { code, familyId: FAMILY_ID, memberId: body.memberId, expiresAt },
    }),
  );

  return jsonResponse(200, { code, expiresInSeconds: CODE_TTL_SECONDS });
}
