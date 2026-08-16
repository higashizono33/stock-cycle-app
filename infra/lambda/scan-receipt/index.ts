import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AnalyzeExpenseCommand, TextractClient } from '@aws-sdk/client-textract';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Category, ScannedRow, ScanResult } from '@stock-cycle-app/core';
import { errorResponse, jsonResponse } from '../shared/http.js';

const textract = new TextractClient({});
const bedrock = new BedrockRuntimeClient({});

const RECEIPTS_BUCKET_NAME = process.env.RECEIPTS_BUCKET_NAME!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-micro-v1:0';

interface RequestBody {
  key?: string;
}

interface RawLineItem {
  description: string;
  quantity: number;
}

function fieldText(field: { Type?: { Text?: string }; ValueDetection?: { Text?: string } } | undefined): string | undefined {
  return field?.ValueDetection?.Text;
}

/**
 * requirements.md §3.2手順2: AWS Textract (AnalyzeExpense) でレシートから
 * 店舗名・購入日・明細(商品名・数量)を抽出する。かすれ・破損等で明細が
 * 1件も取れなかった場合は rows: [] を返し、呼び出し元(フロントエンド)が
 * 手動入力画面へフォールバックする(app/src/lib/mockOcr.tsのモックと同じ契約)。
 */
async function analyzeReceipt(key: string): Promise<{ store: string; date: string; items: RawLineItem[] }> {
  const result = await textract.send(
    new AnalyzeExpenseCommand({ Document: { S3Object: { Bucket: RECEIPTS_BUCKET_NAME, Name: key } } }),
  );

  const doc = result.ExpenseDocuments?.[0];
  const summary = doc?.SummaryFields ?? [];
  const vendor = summary.find((f) => f.Type?.Text === 'VENDOR_NAME');
  const receiptDate = summary.find((f) => f.Type?.Text === 'INVOICE_RECEIPT_DATE');

  const items: RawLineItem[] = [];
  for (const group of doc?.LineItemGroups ?? []) {
    for (const lineItem of group.LineItems ?? []) {
      const fields = lineItem.LineItemExpenseFields ?? [];
      const description = fieldText(fields.find((f) => f.Type?.Text === 'ITEM'));
      if (!description) continue;
      const quantityText = fieldText(fields.find((f) => f.Type?.Text === 'QUANTITY'));
      const quantity = Number.parseInt(quantityText ?? '1', 10);
      items.push({ description, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1 });
    }
  }

  return {
    store: fieldText(vendor) ?? 'Unknown store',
    date: fieldText(receiptDate) ?? new Date().toISOString().slice(0, 10),
    items,
  };
}

/**
 * requirements.md §4「商品名の名寄せ」: Bedrock(LLM)で表記ゆれを吸収した
 * 一般名(例:「Charmin Ultra Soft 12ロール」→「Toilet Paper」)とカテゴリを
 * 推定する。レスポンスが期待通りJSONで返らなかった場合は、生のテキストを
 * そのままcategory=Otherとして採用し、処理全体は失敗させない。
 */
async function normalizeItems(items: RawLineItem[]): Promise<ScannedRow[]> {
  if (items.length === 0) return [];

  const prompt = [
    'You normalize raw grocery/household receipt line items into a generic product name and category.',
    'Rules:',
    '- Use the general product type as the name, not the brand (e.g. "Charmin Ultra Soft 12pk" -> "Toilet Paper").',
    '- category must be exactly one of: "Household", "Food", "Other".',
    '- Respond with ONLY a JSON array, no prose, no markdown fences.',
    '- The array must have exactly one object per input line, in the same order: {"name": string, "category": string}',
    '',
    'Input lines:',
    ...items.map((it, i) => `${i + 1}. ${it.description}`),
  ].join('\n');

  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 1024, temperature: 0 },
      }),
    );
    const text = res.output?.message?.content?.find((c) => c.text)?.text ?? '';
    const jsonText = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(jsonText) as Array<{ name: string; category: Category }>;
    if (parsed.length !== items.length) throw new Error('length mismatch');

    return parsed.map((normalized, i) => ({
      checked: true,
      name: normalized.name,
      category: (['Household', 'Food', 'Other'] as Category[]).includes(normalized.category)
        ? normalized.category
        : 'Other',
      qty: items[i].quantity,
    }));
  } catch {
    // Bedrock unavailable or returned something unparseable — fall back to the raw
    // OCR text untouched rather than failing the whole scan.
    return items.map((it) => ({ checked: true, name: it.description, category: 'Other', qty: it.quantity }));
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errorResponse(400, 'invalid JSON body');
  }
  if (!body.key) return errorResponse(400, 'key is required (from POST /receipts/upload-url)');

  const { store, date, items } = await analyzeReceipt(body.key);
  const rows = await normalizeItems(items);

  const scanResult: ScanResult = { store, date, rows };
  return jsonResponse(200, scanResult);
}
