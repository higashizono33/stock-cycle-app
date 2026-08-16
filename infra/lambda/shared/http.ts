import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, message: string): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(statusCode, { error: message });
}

/**
 * requirements.md §2/§9: MVPは招待フローなしの単一の固定家族を前提とする
 * (Takashiさんの世帯専用デプロイ)。DynamoDBのパーティションキーには
 * familyId を持たせ、将来のマルチテナント化に備える設計にはしておくが、
 * MVPでは全Lambdaで固定値を使う。
 */
export const FAMILY_ID = process.env.FAMILY_ID ?? 'default';
