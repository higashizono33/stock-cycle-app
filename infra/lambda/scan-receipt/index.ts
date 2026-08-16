import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Category, ScannedRow, ScanResult } from '@stock-cycle-app/core';
import { errorResponse, jsonResponse } from '../shared/http.js';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const RECEIPTS_BUCKET_NAME = process.env.RECEIPTS_BUCKET_NAME!;
// us-east-2はNova系モデルの直接提供リージョンではないため、クロスリージョン推論
// プロファイル("us."プレフィックス)のモデルIDを使う(infra/lib/stock-cycle-app-stack.ts参照)。
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-micro-v1:0';
const BEDROCK_VISION_MODEL_ID = process.env.BEDROCK_VISION_MODEL_ID ?? 'us.amazon.nova-lite-v1:0';

interface RequestBody {
  key?: string;
}

interface RawLineItem {
  description: string;
  quantity: number;
}

type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

const IMAGE_FORMAT_BY_EXT: Record<string, ImageFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
};

function imageFormatFromKey(key: string): ImageFormat {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_FORMAT_BY_EXT[ext] ?? 'jpeg';
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Catches the Bedrock vision model getting stuck looping the same phrase — a
// known failure mode on some receipt photos — before we even try to parse
// it as JSON. A chunk of 6+ characters repeated 4+ times back-to-back is
// something normal receipt/JSON text never does.
function hasDegenerateRepetition(text: string): boolean {
  return /(.{6,80})\1{3,}/.test(text);
}

/**
 * requirements.md §3.2手順2: レシート画像から店舗名・購入日・明細(商品名・数量)を
 * 抽出する。
 *
 * 【2026-08-16 設計変更】当初はAWS Textract(AnalyzeExpense)を使う想定だったが、
 * 同APIは英語のみ対応(日本語のレシートは非対応)であることが判明した。このアプリの
 * 実利用は日本語レシート(渡米前の家庭での利用)が前提のため、Textractをやめ、
 * Bedrockのマルチモーダル(vision対応)モデルにレシート画像を直接渡してOCRと
 * 構造化抽出を1回のLLM呼び出しで行う方式に変更した。
 *
 * かすれ・破損等で明細が1件も取れなかった場合は items: [] を返し、呼び出し元
 * (フロントエンド)が手動入力画面へフォールバックする(requirements.md §3.2)。
 */
async function extractReceiptFromImage(key: string): Promise<{ store: string; date: string; items: RawLineItem[] }> {
  const fallback = { store: 'Unknown store', date: new Date().toISOString().slice(0, 10), items: [] as RawLineItem[] };

  const obj = await s3.send(new GetObjectCommand({ Bucket: RECEIPTS_BUCKET_NAME, Key: key }));
  const bytes = await obj.Body?.transformToByteArray();
  if (!bytes) return fallback;

  const prompt = [
    'You are reading a photo of a household shopping receipt (a long thermal-paper strip, photographed with a phone). The receipt may be written in Japanese, English, or another language — read it in whatever language it is written in.',
    'The photo may be rotated (sideways or upside-down), taken at an angle, slightly blurry, or have uneven lighting. Do your best to read it anyway — mentally rotate/straighten the text as needed. Long Japanese receipts are very often photographed sideways because the receipt itself is a tall narrow strip; this is normal and not a reason to give up.',
    'Extract the store name, the purchase date, and every real product line item (name and quantity).',
    'Rules:',
    '- Normalize the date to ISO format YYYY-MM-DD. Japanese receipts often show dates as 令和6年3月10日 (Reiwa era; Reiwa 1 = 2019) or 2024/03/10 or 2024年3月10日 — convert these correctly to 2024-03-10 style.',
    '- Keep each item\'s description exactly as printed, in its original language (do not translate here — a later step handles that). Japanese receipts often print item names in half-width katakana (ｶﾀｶﾅ) — transcribe them as best you can even if partially garbled by the printer.',
    '- Do NOT include subtotal, tax, total, change, payment method, points, or discount lines as items — only actual purchased products.',
    '- Extract every item you can read, even if you are not 100% sure of a name or quantity — a human reviews and corrects this before it is saved, so a partial or approximate read is much more useful than giving up. Only return an empty items array if the image is genuinely unreadable (e.g. solid black/blank, or no receipt visible at all).',
    '- Respond with ONLY a JSON object, no prose, no markdown code fences, in exactly this shape:',
    '{"store": string, "date": "YYYY-MM-DD", "items": [{"description": string, "quantity": number}]}',
  ].join('\n');

  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: BEDROCK_VISION_MODEL_ID,
        messages: [
          {
            role: 'user',
            content: [{ image: { format: imageFormatFromKey(key), source: { bytes } } }, { text: prompt }],
          },
        ],
        // temperature: 0 (greedy decoding) turned out to make this model prone to getting
        // stuck repeating the same word/phrase forever on some receipt photos, running past
        // maxTokens mid-string and producing invalid JSON. A little randomness breaks the loop.
        inferenceConfig: { maxTokens: 2048, temperature: 0.2, topP: 0.9 },
      }),
    );
    const text = res.output?.message?.content?.find((c) => c.text)?.text ?? '';
    const jsonText = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    if (hasDegenerateRepetition(jsonText)) {
      console.error('scan-receipt: model output looks like a repetition loop, discarding', {
        key,
        modelId: BEDROCK_VISION_MODEL_ID,
        rawTextPreview: text.slice(0, 500),
      });
      return fallback;
    }

    let parsed: { store?: string; date?: string; items?: RawLineItem[] };
    try {
      parsed = JSON.parse(jsonText) as { store?: string; date?: string; items?: RawLineItem[] };
    } catch (parseErr) {
      // モデルの生レスポンスをログに残す。JSONで返らない原因(プロンプト崩れ・途中で
      // 切れた等)を後から追えるようにするため、失敗を握りつぶさない。
      console.error('scan-receipt: failed to parse Bedrock vision response as JSON', {
        key,
        modelId: BEDROCK_VISION_MODEL_ID,
        rawTextPreview: text.slice(0, 500),
        parseErr,
      });
      return fallback;
    }

    const items: RawLineItem[] = (parsed.items ?? [])
      .filter((it) => typeof it?.description === 'string' && it.description.trim())
      .map((it) => ({
        description: it.description.trim(),
        quantity: Number.isFinite(it.quantity) && it.quantity > 0 ? Math.round(it.quantity) : 1,
      }));

    if (items.length === 0) {
      // 例外は起きていないが、モデルが「読めなかった」と判断したケース。原因切り分け用にログを残す。
      console.warn('scan-receipt: Bedrock vision returned zero items', { key, modelId: BEDROCK_VISION_MODEL_ID, rawTextPreview: text.slice(0, 500) });
    }

    return {
      store: parsed.store?.trim() || fallback.store,
      date: parsed.date && ISO_DATE_RE.test(parsed.date) ? parsed.date : fallback.date,
      items,
    };
  } catch (err) {
    // Bedrock呼び出し自体が失敗した場合(モデルアクセス未許可・IAM権限不足・画像形式不正等)。
    // CloudWatch Logsで原因を追えるよう、握りつぶさずログに残してからフォールバックする。
    console.error('scan-receipt: Bedrock vision invocation failed', {
      key,
      modelId: BEDROCK_VISION_MODEL_ID,
      err,
    });
    return fallback;
  }
}

/**
 * requirements.md §4「商品名の名寄せ」: Bedrock(LLM)で表記ゆれを吸収した
 * 一般名(例:「Charmin Ultra Soft 12ロール」→「Toilet Paper」、
 * 「アリエール 詰め替え用」→「Laundry Detergent」)とカテゴリを推定する。
 * requirements.md §5よりUI/通知は英語に統一する方針のため、入力が日本語でも
 * 出力の商品名は常に英語にする。レスポンスが期待通りJSONで返らなかった場合は、
 * 生のテキストをそのままcategory=Otherとして採用し、処理全体は失敗させない。
 */
async function normalizeItems(items: RawLineItem[]): Promise<ScannedRow[]> {
  if (items.length === 0) return [];

  const prompt = [
    'You normalize raw grocery/household receipt line items into a generic product name and category.',
    'The input lines may be in Japanese, English, or another language.',
    'Rules:',
    '- Always respond with the product name in English, regardless of the input language.',
    '- Use the general product type as the name, not the brand (e.g. "Charmin Ultra Soft 12pk" -> "Toilet Paper", "アリエール 詰め替え用" -> "Laundry Detergent", "コカコーラ 500ml" -> "Coca-Cola").',
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

  const { store, date, items } = await extractReceiptFromImage(body.key);
  const rows = await normalizeItems(items);

  const scanResult: ScanResult = { store, date, rows };
  return jsonResponse(200, scanResult);
}
