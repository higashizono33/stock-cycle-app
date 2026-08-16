import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Category, PurchaseRecord } from '@stock-cycle-app/core';
import { computeStats } from '@stock-cycle-app/core';
import { ddb, FAMILY_MEMBERS_TABLE_NAME, ITEMS_TABLE_NAME, itemKey, PURCHASES_TABLE_NAME, SETTINGS_TABLE_NAME } from '../shared/db.js';
import { FAMILY_ID } from '../shared/http.js';
import { buildRestockFlexMessage, pushMessage } from '../shared/line.js';

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? '';

interface ItemRecord {
  itemId: string;
  name: string;
  emoji: string;
  category: Category;
  tracked: boolean;
  alertsOn: boolean;
  lastNotifiedFor?: string;
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
 * EventBridge Schedulerから毎日起動される(要件定義書5章・7章)。
 * requirements.md §5「再通知はMVPでは不要(1回のみ)」を満たすため、アイテムごとに
 * `lastNotifiedFor`(通知済みの起点購入日)を記録し、次の購入で起点がリセットされる
 * まで同じサイクルについて再通知しない。
 */
export async function handler(): Promise<void> {
  const [itemsResult, settingsResult] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: ITEMS_TABLE_NAME,
        KeyConditionExpression: 'familyId = :familyId',
        FilterExpression: 'tracked = :true AND alertsOn = :true',
        ExpressionAttributeValues: { ':familyId': FAMILY_ID, ':true': true },
      }),
    ),
    ddb.send(new GetCommand({ TableName: SETTINGS_TABLE_NAME, Key: { familyId: FAMILY_ID } })),
  ]);

  const notificationTiming = (settingsResult.Item?.notificationTiming as number | undefined) ?? 2;
  const records = (itemsResult.Items ?? []) as ItemRecord[];

  const due: Array<{ record: ItemRecord; daysLeft: number; lastBought: string }> = [];
  for (const record of records) {
    const purchases = await fetchPurchases(record.itemId);
    const stats = computeStats({ id: record.itemId, purchases, name: record.name, emoji: record.emoji, category: record.category, tracked: record.tracked, alertsOn: record.alertsOn });
    if (stats.daysLeft === null || stats.lastBought === null) continue;
    if (stats.daysLeft > notificationTiming) continue;
    if (record.lastNotifiedFor === stats.lastBought) continue; // このサイクルは通知済み
    due.push({ record, daysLeft: stats.daysLeft, lastBought: stats.lastBought });
  }

  if (due.length === 0) return;

  const membersResult = await ddb.send(
    new QueryCommand({
      TableName: FAMILY_MEMBERS_TABLE_NAME,
      KeyConditionExpression: 'familyId = :familyId',
      FilterExpression: 'attribute_exists(lineUserId)',
      ExpressionAttributeValues: { ':familyId': FAMILY_ID },
    }),
  );
  const linkedLineUserIds = (membersResult.Items ?? []).map((m) => m.lineUserId as string);

  if (linkedLineUserIds.length > 0) {
    const message = buildRestockFlexMessage(
      due.map((d) => ({ emoji: d.record.emoji, name: d.record.name, daysLeft: d.daysLeft })),
      DASHBOARD_URL,
    );
    await Promise.all(linkedLineUserIds.map((userId) => pushMessage(userId, [message])));
  }

  await Promise.all(
    due.map((d) =>
      ddb.send(
        new UpdateCommand({
          TableName: ITEMS_TABLE_NAME,
          Key: { familyId: FAMILY_ID, itemId: d.record.itemId },
          UpdateExpression: 'SET lastNotifiedFor = :date',
          ExpressionAttributeValues: { ':date': d.lastBought },
        }),
      ),
    ),
  );
}
