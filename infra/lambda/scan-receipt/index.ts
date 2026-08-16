import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Category, ScannedRow, ScanResult } from '@stock-cycle-app/core';
import { errorResponse, jsonResponse } from '../shared/http.js';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const RECEIPTS_BUCKET_NAME = process.env.RECEIPTS_BUCKET_NAME!;
// us-east-2はNova/Claude系モデルの直接提供リージョンではないため、クロスリージョン推論
// プロファイル("us."プレフィックス)のモデルIDを使う(infra/lib/stock-cycle-app-stack.ts参照)。
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-micro-v1:0';
// 2026-08-16実機検証: Nova Liteでは実物の(回転・ブレた)日本語レシート写真の読み取り精度が
// 低く、店舗名・日付・明細すべてが実在しない内容にすり替わる(ハルシネーション)事例が発生した。
// 当初はAnthropicモデル利用の申請フォーム未提出でClaudeを呼び出せなかったため一時的に
// Nova Proへ変更していたが、フォーム提出・承認後はClaude Sonnet 4.5に切り替えた。
const BEDROCK_VISION_MODEL_ID = process.env.BEDROCK_VISION_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

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

// Nova models can get stuck looping the same phrase verbatim on some receipt
// photos (a real failure observed in production, see git history), running
// past maxTokens mid-string and producing invalid JSON. A chunk of characters
// repeated 4+ times back-to-back is something normal receipt/JSON text never
// does, so treat it as a loop and discard the result. The upper bound is
// generous (400) because Japanese item names are JSON-escaped as \uXXXX —
// six ASCII characters per glyph — so one repeated item name+wrapper easily
// exceeds a tighter cap and would silently slip through.
function hasDegenerateRepetition(text: string): boolean {
  return /(.{6,400})\1{3,}/.test(text);
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
    'How to read the item list (do this carefully, step by step):',
    '- Scan the item section systematically from top to bottom, one printed line at a time. Do not skip around or guess from a partial glance.',
    '- Each real item is a distinct printed line that has BOTH a product name AND its own price on the same line (Japanese receipts often prefix each item line with "*" or "＊", with the price right-aligned). If you cannot find a matching printed price for a name, do not include it.',
    '- Many Japanese receipts print a purchase count near the bottom, such as "お買上点数15点" or "点数：15点" (meaning "15 items purchased"). If you see this, count how many item lines you actually found. If your count is short, it is fine to go back and look again for lines you may have missed near the top, bottom, or a rotated/cut-off edge of the photo — but ONLY add a line if you can actually see it printed. If you genuinely cannot find all of them, report fewer items; do NOT reach the target count by repeating or duplicating an item you already found. Copying the same item multiple times to hit the count is strictly forbidden and worse than reporting too few.',
    '- Report the printed purchase-count number (if visible) as "printedItemCount" so it can be double-checked later; use null if the receipt does not show one. This field is for cross-checking only — it must never influence how many times you list an item.',
    'Rules:',
    '- Normalize the date to ISO format YYYY-MM-DD. Japanese receipts often show dates as 令和6年3月10日 (Reiwa era; Reiwa 1 = 2019) or 2024/03/10 or 2024年3月10日 — convert these correctly to 2024-03-10 style.',
    '- Keep each item\'s description exactly as printed, in its original language (do not translate here — a later step handles that). Japanese receipts often print item names in half-width katakana (ｶﾀｶﾅ) — transcribe them as best you can even if partially garbled by the printer.',
    '- Do NOT include subtotal, tax, total, change, payment method, points, discount, coupon, or purchase-count lines as items — only actual purchased products with their own price.',
    '- NEVER invent, guess, or pad the list with a plausible-sounding item (e.g. a generic "Toothbrush" or "Snack") just because it seems like something a store like this might sell, or to round out the count. Every item you output must correspond to text you can actually see printed on the receipt. If you are unsure whether a line is a real separate item, it is better to leave it out than to invent one. The same applies to duplicating a real item you already read — each entry in the output must correspond to a physically distinct printed line, never a copy.',
    '- That said, do extract every item you can genuinely read, even if you are not 100% sure of the exact spelling of a name — a human reviews and corrects this before it is saved, so an approximate but real reading is fine. Only return an empty items array if the image is genuinely unreadable (e.g. solid black/blank, or no receipt visible at all).',
    '- Respond with ONLY a JSON object, no prose, no markdown code fences, in exactly this shape:',
    '{"store": string, "date": "YYYY-MM-DD", "printedItemCount": number | null, "items": [{"description": string, "quantity": number}]}',
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
        // 15点超の長いレシートでも明細が最後まで出力し切れるよう、2048から引き上げ。
        // Claudeモデルはtemperature/topPを同時指定できない(ValidationException)ため、
        // temperatureのみ指定する。
        inferenceConfig: { maxTokens: 3072, temperature: 0.2 },
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

    let parsed: { store?: string; date?: string; printedItemCount?: number | null; items?: RawLineItem[] };
    try {
      parsed = JSON.parse(jsonText) as { store?: string; date?: string; printedItemCount?: number | null; items?: RawLineItem[] };
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

    // A second hallucination shape observed in production (distinct from the raw-text
    // repetition loop above): the model reads a printed purchase count (e.g. "15点")
    // but can't actually make out 15 distinct lines, so it pads the array by copying
    // one item name 15 times — this parses as perfectly valid JSON, so it wouldn't be
    // caught by hasDegenerateRepetition. 4+ items that are ALL identical is not
    // something a real diverse grocery receipt produces; treat it as untrustworthy.
    const uniqueDescriptions = new Set(items.map((it) => it.description.toLowerCase()));
    if (items.length >= 4 && uniqueDescriptions.size === 1) {
      console.error('scan-receipt: all extracted items are identical — likely padded to match the printed item count, discarding', {
        key,
        modelId: BEDROCK_VISION_MODEL_ID,
        description: items[0].description,
        itemCount: items.length,
      });
      return fallback;
    }

    if (items.length === 0) {
      // 例外は起きていないが、モデルが「読めなかった」と判断したケース。原因切り分け用にログを残す。
      console.warn('scan-receipt: Bedrock vision returned zero items', { key, modelId: BEDROCK_VISION_MODEL_ID, rawTextPreview: text.slice(0, 500) });
    } else {
      // 正常系でも抽出結果をログに残す。店舗名・日付・明細が実物と食い違う(誤読/ハルシネーション)
      // 場合に、後からCloudWatch Logsだけで気づけるようにするため。printedItemCountとの
      // 不一致は明細の読み漏れ・水増しの兆候なので、警告として分けて出す。
      if (typeof parsed.printedItemCount === 'number' && parsed.printedItemCount !== items.length) {
        console.warn('scan-receipt: extracted item count does not match printed purchase count on receipt', {
          key,
          modelId: BEDROCK_VISION_MODEL_ID,
          printedItemCount: parsed.printedItemCount,
          extractedItemCount: items.length,
        });
      }
      console.log('scan-receipt: Bedrock vision extraction succeeded', {
        key,
        modelId: BEDROCK_VISION_MODEL_ID,
        store: parsed.store,
        date: parsed.date,
        printedItemCount: parsed.printedItemCount ?? null,
        itemCount: items.length,
        items: items.map((it) => `${it.description} x${it.quantity}`),
      });
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
 * 「アリエール 詰め替え用」→「洗濯洗剤」)とカテゴリを推定する。
 * 2026-08-16: 以前は常に英語へ翻訳していたが、日本語レシートはそのまま日本語で表示して
 * ほしいとの要望を受け、入力の言語(表記)を維持したまま一般名化するように変更した
 * (UIのラベル文言自体は引き続き英語。商品名の言語のみ入力に追従する)。
 * レスポンスが期待通りJSONで返らなかった場合は、生のテキストをそのまま
 * category=Otherとして採用し、処理全体は失敗させない。
 */
async function normalizeItems(items: RawLineItem[]): Promise<ScannedRow[]> {
  if (items.length === 0) return [];

  const prompt = [
    'You normalize raw grocery/household receipt line items into a generic product name and category.',
    'The input lines may be in Japanese, English, or another language.',
    'Rules:',
    '- Respond in the SAME language/script as the input line. Do not translate — if the input is Japanese, the output name must also be Japanese; if English, keep it English.',
    '- Use the general product type as the name, not the brand, but in the input\'s own language (e.g. "Charmin Ultra Soft 12pk" -> "Toilet Paper", "アリエール 詰め替え用" -> "洗濯洗剤", "コーラ 500ml" -> "コーラ" or "炭酸飲料"). Do not invent or default to a specific example brand/product from these instructions — base the name only on the actual input line given below.',
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
        // 15点前後の長いレシートで一部の商品名+カテゴリ出力が途中で切られないよう余裕を持たせる。
        inferenceConfig: { maxTokens: 2048, temperature: 0 },
      }),
    );
    const text = res.output?.message?.content?.find((c) => c.text)?.text ?? '';
    const jsonText = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(jsonText) as Array<{ name: string; category: Category }>;

    // Nova Microは入力行数と出力配列長が稀に一致しない(一部の行を1つに統合する等)。
    // 以前は不一致を検知した時点で正規化結果を全て捨てて生のOCRテキストへフォールバック
    // していたが、それだと軽微なずれでも英語名変換・カテゴリ推定が丸ごと無駄になる。
    // 位置が対応している前提でindexごとに突き合わせ、モデルが返さなかった末尾の行だけ
    // 個別に生テキストへフォールバックする方が実用上マシ。
    if (parsed.length !== items.length) {
      console.warn('scan-receipt: normalizeItems length mismatch, using partial results', {
        modelId: BEDROCK_MODEL_ID,
        expected: items.length,
        got: parsed.length,
      });
    }

    return items.map((it, i) => {
      const normalized = parsed[i];
      if (!normalized?.name) {
        return { checked: true, name: it.description, category: 'Other' as Category, qty: it.quantity };
      }
      return {
        checked: true,
        name: normalized.name,
        category: (['Household', 'Food', 'Other'] as Category[]).includes(normalized.category)
          ? normalized.category
          : 'Other',
        qty: it.quantity,
      };
    });
  } catch (err) {
    // Bedrock unavailable or returned something unparseable — fall back to the raw
    // OCR text untouched rather than failing the whole scan. Logged so a bad
    // normalization (e.g. every item collapsing to the same name) can be traced later.
    console.error('scan-receipt: normalizeItems failed, falling back to raw OCR text', {
      modelId: BEDROCK_MODEL_ID,
      inputItems: items.map((it) => it.description),
      err,
    });
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
