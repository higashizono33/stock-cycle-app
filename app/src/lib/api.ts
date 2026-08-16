import type { Category, FamilyMember, ScanResult, Settings, StockItem } from '@stock-cycle-app/core';
import { getValidIdToken, redirectToLogin } from './auth';

const API_URL = import.meta.env.VITE_API_URL;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const idToken = await getValidIdToken();
  if (!idToken) {
    await redirectToLogin();
    // redirectToLogin navigates away; this never resolves in practice.
    return new Promise<T>(() => {});
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listItems(): Promise<StockItem[]> {
  const { items } = await request<{ items: StockItem[] }>('/items');
  return items;
}

export async function patchItem(itemId: string, patch: { tracked?: boolean; alertsOn?: boolean }): Promise<void> {
  await request(`/items/${itemId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function markBought(itemId: string): Promise<void> {
  await request(`/items/${itemId}/bought`, { method: 'POST' });
}

export interface PurchaseUpsertRow {
  name: string;
  category: Category;
  qty: number;
  date?: string;
}

export async function createPurchases(rows: PurchaseUpsertRow[]): Promise<void> {
  await request('/purchases', { method: 'POST', body: JSON.stringify({ rows }) });
}

export async function listFamily(): Promise<FamilyMember[]> {
  const { family } = await request<{ family: FamilyMember[] }>('/family');
  return family;
}

export async function getSettings(): Promise<Settings> {
  return request<Settings>('/settings');
}

export async function putSettings(settings: Settings): Promise<void> {
  await request('/settings', { method: 'PUT', body: JSON.stringify(settings) });
}

export async function requestReceiptUploadUrl(contentType: string): Promise<{ uploadUrl: string; key: string }> {
  return request('/receipts/upload-url', { method: 'POST', body: JSON.stringify({ contentType }) });
}

export async function uploadReceiptPhoto(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!res.ok) throw new Error(`receipt upload failed: ${res.status}`);
}

export async function scanReceipt(key: string): Promise<ScanResult> {
  return request<ScanResult>('/receipts/scan', { method: 'POST', body: JSON.stringify({ key }) });
}

export async function requestLineLinkCode(memberId: string): Promise<{ code: string; expiresInSeconds: number }> {
  return request('/line/link', { method: 'POST', body: JSON.stringify({ memberId }) });
}
