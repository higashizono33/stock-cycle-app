import type { StockItem } from '@stock-cycle-app/core';
import { computeStats } from '@stock-cycle-app/core';

export interface LineNotificationItem {
  emoji: string;
  name: string;
  daysLeft: number;
}

/**
 * Client-side preview of what the daily reminder batch (infra/lambda/reminder-batch)
 * will push over LINE. The actual send happens server-side once a day — this
 * just mirrors the same selection logic against the current stock data so the
 * Alerts tab can show it live.
 */
export function buildRestockAlert(items: StockItem[], thresholdDays: number): LineNotificationItem[] {
  return items
    .filter((it) => it.tracked && it.alertsOn)
    .map((it) => ({ item: it, stats: computeStats(it) }))
    .filter(({ stats }) => stats.daysLeft !== null && stats.daysLeft <= thresholdDays)
    .sort((a, b) => (a.stats.daysLeft ?? 0) - (b.stats.daysLeft ?? 0))
    .map(({ item, stats }) => ({ emoji: item.emoji, name: item.name, daysLeft: stats.daysLeft ?? 0 }));
}
