import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const ITEMS_TABLE_NAME = process.env.ITEMS_TABLE_NAME!;
export const PURCHASES_TABLE_NAME = process.env.PURCHASES_TABLE_NAME!;
export const FAMILY_MEMBERS_TABLE_NAME = process.env.FAMILY_MEMBERS_TABLE_NAME!;
export const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME!;
export const LINK_CODES_TABLE_NAME = process.env.LINK_CODES_TABLE_NAME!;

export function itemKey(familyId: string, itemId: string): string {
  return `${familyId}#${itemId}`;
}
