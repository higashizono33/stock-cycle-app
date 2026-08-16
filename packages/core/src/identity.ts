import type { Category } from './types.js';

// requirements.md §4「ブランド変更の扱い」: 商品名単位ではなくカテゴリ単位(例:
// 「トイレットペーパー」)でサイクルを管理する。正規化された商品名からこのslugを
// itemIdとして使うことで、同じ商品名の購入は常に同一アイテムに積み上がる。
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || `item-${Date.now()}`;
}

const EMOJI_BY_CATEGORY: Record<Category, string> = {
  Household: '🧴',
  Food: '🍽️',
  Other: '📦',
};

export function emojiForCategory(category: Category): string {
  return EMOJI_BY_CATEGORY[category];
}
