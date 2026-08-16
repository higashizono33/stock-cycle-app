import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorResponse, FAMILY_ID, jsonResponse } from '../shared/http.js';

const s3 = new S3Client({});
const RECEIPTS_BUCKET_NAME = process.env.RECEIPTS_BUCKET_NAME!;
const UPLOAD_URL_EXPIRES_IN = 5 * 60;

interface RequestBody {
  contentType?: string;
}

/**
 * POST /receipts/upload-url
 * requirements.md §3.2手順1: レシート写真をS3へ直接PUTアップロードするための
 * Presigned URLを発行する。大きな画像をAPI Gatewayのペイロードに乗せない
 * ための構成(bilingual-appのpresign-uploadと同じ方針)。
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errorResponse(400, 'invalid JSON body');
  }

  const contentType = body.contentType ?? 'image/jpeg';
  const key = `receipts/${FAMILY_ID}/${randomUUID()}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: RECEIPTS_BUCKET_NAME, Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_EXPIRES_IN },
  );

  return jsonResponse(200, { uploadUrl, key });
}
