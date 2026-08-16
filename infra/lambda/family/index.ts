import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { FamilyMember } from '@stock-cycle-app/core';
import { ddb, FAMILY_MEMBERS_TABLE_NAME } from '../shared/db.js';
import { errorResponse, FAMILY_ID, jsonResponse } from '../shared/http.js';

/**
 * GET /family
 * requirements.md §2/§9: メンバーは初期セットアップ時に固定登録されるのみで、
 * MVPには追加・招待フローがない。よってこのLambdaは読み取り専用。
 * (メンバーの登録自体は `cdk deploy` 後に `aws dynamodb put-item` で1回だけ行う想定
 * — 家族全員の役割は同等なので管理APIを別途持つ必要がない)
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'GET') {
    return errorResponse(405, `unsupported method: ${event.requestContext.http.method}`);
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: FAMILY_MEMBERS_TABLE_NAME,
      KeyConditionExpression: 'familyId = :familyId',
      ExpressionAttributeValues: { ':familyId': FAMILY_ID },
    }),
  );

  const family: FamilyMember[] = (result.Items ?? []).map((m) => ({ id: m.memberId as string, name: m.name as string }));
  return jsonResponse(200, { family });
}
