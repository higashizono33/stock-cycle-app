export type Category = 'Household' | 'Food' | 'Other';

export interface PurchaseRecord {
  date: string; // ISO date (yyyy-mm-dd)
  qty: number;
}

export interface StockItem {
  id: string;
  name: string;
  emoji: string;
  category: Category;
  tracked: boolean;
  alertsOn: boolean;
  purchases: PurchaseRecord[];
}

export interface ItemStats {
  avgCycleDays: number | null;
  lastBought: string | null;
  daysLeft: number | null;
  progress: number;
  purchaseCount: number;
}

// Family members are fixed at initial setup for the MVP — no invite/add
// flow, no permission differences (requirements.md §2, §9).
export interface FamilyMember {
  id: string;
  name: string;
}

export type NotificationTiming = 1 | 2 | 5;

export interface Settings {
  notificationTiming: NotificationTiming;
}

export interface AppState {
  items: StockItem[];
  family: FamilyMember[];
  settings: Settings;
}

// --- Receipt scan API contract (POST /receipts/scan) ---
// Shared so the frontend's mock (app/src/lib/mockOcr.ts) and the real
// Lambda (infra/lambda/scan-receipt) return an identical shape — swapping
// one for the other requires no changes on the consuming side.

export interface ScannedRow {
  checked: boolean;
  name: string;
  category: Category;
  qty: number;
}

export interface ScanResult {
  store: string;
  date: string;
  rows: ScannedRow[];
}

// --- Purchase upsert API contract (POST /purchases) ---
// A confirmed/edited receipt row, or a manually-entered item. `date`
// defaults to today when omitted. Mirrors the frontend's ADD_PURCHASES
// reducer action payload.

export interface PurchaseUpsertRow {
  name: string;
  category: Category;
  qty: number;
  date?: string;
}
