import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Category, PurchaseRecord, StockItem } from '@stock-cycle-app/core';
import { todayISO } from '@stock-cycle-app/core';
import { ddb, ITEMS_TABLE_NAME, itemKey, PURCHASES_TABLE_NAME } from '../shared/db.js';
import { errorResponse, FAMILY_ID, jsonResponse } from '../shared/http.js';

interface ItemRecord {
  familyId: string;
  itemId: string;
  name: string;
  emoji: string;
  category: Category;
  tracked: boolean;
  alertsOn: boolean;
}

async function fetchPurchases(itemId: string): Promise<PurchaseRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: PURCHASES_TABLE_NAME,
      KeyConditionExpression: 'itemKey = :itemKey',
      ExpressionAttributeValues: { ':itemKey': itemKey(FAMILY_ID, itemId) },
    }),
  );
  return (result.Items ?? []).map((p) => ({ date: p.date as string, qty: p.qty as number }));
}

/**
 * GET /items
 * requirements.md §3.3: 在庫一覧。サイクル推定(computeStats)はレスポンスに含めず、
 * StockItem[]をそのまま返す — フロントエンドはローカルモック時と同じ
 * @stock-cycle-app/core の computeStats を使って表示用の統計を算出する
 * (推定ロジックの実装場所を1箇所に保つ)。
 */
async function listItems(): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: ITEMS_TABLE_NAME,
      KeyConditionExpression: 'familyId = :familyId',
      ExpressionAttributeValues: { ':familyId': FAMILY_ID },
    }),
  );
  const records = (result.Items ?? []) as ItemRecord[];

  const items: StockItem[] = await Promise.all(
    records.map(async (r) => ({
      id: r.itemId,
      name: r.name,
      emoji: r.emoji,
      category: r.category,
      tracked: r.tracked,
      alertsOn: r.alertsOn,
      purchases: await fetchPurchases(r.itemId),
    })),
  );

  return jsonResponse(200, { items });
}

/** PATCH /items/{itemId} — トラッキング/アラートのON-OFF切り替え */
async function patchItem(itemId: string, body: string | undefined): Promise<APIGatewayProxyStructuredResultV2> {
  let patch: { tracked?: boolean; alertsOn?: boolean };
  try {
    patch = JSON.parse(body ?? '{}');
  } catch {
    return errorResponse(400, 'invalid JSON body');
  }

  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  if (typeof patch.tracked === 'boolean') {
    sets.push('tracked = :tracked');
    values[':tracked'] = patch.tracked;
  }
  if (typeof patch.alertsOn === 'boolean') {
    sets.push('alertsOn = :alertsOn');
    values[':alertsOn'] = patch.alertsOn;
  }
  if (sets.length === 0) return errorResponse(400, 'tracked and/or alertsOn required');

  await ddb.send(
    new UpdateCommand({
      TableName: ITEMS_TABLE_NAME,
      Key: { familyId: FAMILY_ID, itemId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
    }),
  );
  return jsonResponse(200, { itemId, ...patch });
}

/**
 * POST /items/{itemId}/bought
 * requirements.md §3.3手順4: LINE通知の「買った」ボタンからのディープリンク先。
 * 今日の日付で購入履歴を1件追記し、次回サイクルの起点をリセットする。
 */
async function markBought(itemId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const existing = await ddb.send(new GetCommand({ TableName: ITEMS_TABLE_NAME, Key: { familyId: FAMILY_ID, itemId } }));
  if (!existing.Item) return errorResponse(404, `item ${itemId} not found`);

  const date = todayISO();
  await ddb.send(
    new PutCommand({
      TableName: PURCHASES_TABLE_NAME,
      Item: { itemKey: itemKey(FAMILY_ID, itemId), sortKey: `${date}#${randomUUID()}`, date, qty: 1 },
    }),
  );
  return jsonResponse(200, { itemId, date });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const itemId = event.pathParameters?.itemId;
  const isBoughtRoute = event.requestContext.http.path.endsWith('/bought');

  if (method === 'GET' && !itemId) return listItems();
  if (method === 'PATCH' && itemId) return patchItem(itemId, event.body);
  if (method === 'POST' && itemId && isBoughtRoute) return markBought(itemId);

  return errorResponse(405, `unsupported route: ${method} ${event.requestContext.http.path}`);
}
