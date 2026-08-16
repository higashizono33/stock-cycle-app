import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { NotificationTiming, Settings } from '@stock-cycle-app/core';
import { ddb, SETTINGS_TABLE_NAME } from '../shared/db.js';
import { errorResponse, FAMILY_ID, jsonResponse } from '../shared/http.js';

const DEFAULT_SETTINGS: Settings = { notificationTiming: 2 };
const VALID_TIMINGS: NotificationTiming[] = [1, 2, 5];

/** GET/PUT /settings — requirements.md §5「通知タイミング」の家族単位グローバル設定 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;

  if (method === 'GET') {
    const result = await ddb.send(new GetCommand({ TableName: SETTINGS_TABLE_NAME, Key: { familyId: FAMILY_ID } }));
    const settings: Settings = result.Item
      ? { notificationTiming: result.Item.notificationTiming as NotificationTiming }
      : DEFAULT_SETTINGS;
    return jsonResponse(200, settings);
  }

  if (method === 'PUT') {
    let body: Partial<Settings>;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return errorResponse(400, 'invalid JSON body');
    }
    if (!body.notificationTiming || !VALID_TIMINGS.includes(body.notificationTiming)) {
      return errorResponse(400, 'notificationTiming must be one of 1, 2, 5');
    }
    await ddb.send(
      new PutCommand({
        TableName: SETTINGS_TABLE_NAME,
        Item: { familyId: FAMILY_ID, notificationTiming: body.notificationTiming },
      }),
    );
    return jsonResponse(200, { notificationTiming: body.notificationTiming });
  }

  return errorResponse(405, `unsupported method: ${method}`);
}
