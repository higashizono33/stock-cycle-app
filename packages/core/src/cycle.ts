import type { ItemStats, StockItem } from './types.js';
import { daysBetween, todayISO } from './date.js';

export type StatusClass = 'urgent' | 'soon' | 'normal' | 'muted';

// requirements.md §4: "異常に短い／長い購入間隔（買いだめ・買い忘れ等）を検出し、
// 推定計算から除外する" — drop intervals that are less than half or more than
// double the median before averaging.
function excludeOutliers(intervals: number[]): number[] {
  if (intervals.length < 3) return intervals;
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const filtered = intervals.filter((v) => v >= median * 0.5 && v <= median * 2);
  return filtered.length > 0 ? filtered : intervals;
}

// requirements.md §4: "直近の購入間隔を重視した加重移動平均" — weight more
// recent intervals higher so the estimate follows lifestyle changes faster.
function weightedAverage(intervals: number[]): number {
  let weightedSum = 0;
  let weightTotal = 0;
  intervals.forEach((value, idx) => {
    const weight = idx + 1; // chronological order: later entries are more recent
    weightedSum += value * weight;
    weightTotal += weight;
  });
  return Math.max(1, Math.round(weightedSum / weightTotal));
}

export function computeStats(item: StockItem, today: string = todayISO()): ItemStats {
  const purchases = [...item.purchases].sort((a, b) => a.date.localeCompare(b.date));
  const purchaseCount = purchases.length;

  if (purchaseCount === 0) {
    return { avgCycleDays: null, lastBought: null, daysLeft: null, progress: 0, purchaseCount };
  }

  const lastBought = purchases[purchaseCount - 1].date;

  // requirements.md §4: estimation only starts once a 2nd purchase is recorded.
  if (purchaseCount < 2) {
    return { avgCycleDays: null, lastBought, daysLeft: null, progress: 0, purchaseCount };
  }

  const rawIntervals: number[] = [];
  for (let i = 1; i < purchases.length; i++) {
    rawIntervals.push(daysBetween(purchases[i - 1].date, purchases[i].date));
  }
  const intervals = excludeOutliers(rawIntervals);
  const avgCycleDays = weightedAverage(intervals);

  const elapsed = daysBetween(lastBought, today);
  const daysLeft = avgCycleDays - elapsed;
  const progress = Math.min(1, Math.max(0, elapsed / avgCycleDays));

  return { avgCycleDays, lastBought, daysLeft, progress, purchaseCount };
}

export function statusClass(daysLeft: number | null, alertsOn: boolean): StatusClass {
  if (!alertsOn) return 'muted';
  if (daysLeft === null) return 'normal';
  if (daysLeft <= 3) return 'urgent';
  if (daysLeft <= 7) return 'soon';
  return 'normal';
}
