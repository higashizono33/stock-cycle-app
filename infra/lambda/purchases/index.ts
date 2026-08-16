import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { PurchaseUpsertRow } from '@stock-cycle-app/core';
import { emojiForCategory, slugify, todayISO } from '@stock-cycle-app/core';
import { ddb, ITEMS_TABLE_NAME, itemKey, PURCHASES_TABLE_NAME } from '../shared/db.js';
import { errorResponse, FAMILY_ID, jsonResponse } from '../shared/http.js';

interface RequestBody {
  rows?: PurchaseUpsertRow[];
}

/**
 * POST /purchases
 * requirements.md §3.2手順4-5・§3.3手順4: 確認済み/手動入力された購入行を保存する。
 * 同じ商品名(=itemId)が既にあれば購入履歴を追記するだけ、なければ新規アイテムとして
 * 作成する。フロントエンドのADD_PURCHASESリデューサ(app/src/state/StoreContext.tsx)と
 * 完全に同じ意味論(itemId=slugify(name)で名寄せ)にしてある。
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errorResponse(400, 'invalid JSON body');
  }
  const rows = body.rows?.filter((r) => r.name?.trim());
  if (!rows || rows.length === 0) return errorResponse(400, 'rows is required and must be non-empty');

  for (const row of rows) {
    const name = row.name.trim();
    const id = slugify(name);
    const date = row.date ?? todayISO();

    const existing = await ddb.send(new GetCommand({ TableName: ITEMS_TABLE_NAME, Key: { familyId: FAMILY_ID, itemId: id } }));

    if (existing.Item) {
      await ddb.send(
        new UpdateCommand({
          TableName: ITEMS_TABLE_NAME,
          Key: { familyId: FAMILY_ID, itemId: id },
          UpdateExpression: 'SET tracked = :tracked',
          ExpressionAttributeValues: { ':tracked': true },
        }),
      );
    } else {
      await ddb.send(
        new PutCommand({
          TableName: ITEMS_TABLE_NAME,
          Item: {
            familyId: FAMILY_ID,
            itemId: id,
            name,
            emoji: emojiForCategory(row.category),
            category: row.category,
            tracked: true,
            alertsOn: true,
          },
        }),
      );
    }

    await ddb.send(
      new PutCommand({
        TableName: PURCHASES_TABLE_NAME,
        Item: {
          itemKey: itemKey(FAMILY_ID, id),
          sortKey: `${date}#${randomUUID()}`,
          date,
          qty: row.qty,
        },
      }),
    );
  }

  return jsonResponse(200, { saved: rows.length });
}
