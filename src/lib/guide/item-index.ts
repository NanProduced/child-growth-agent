import { GUIDE_CATALOG } from "@/data/guide";

import type { GuidePerformanceItem } from "./types";

/** G5 运行时条目索引：从冻结目录构建一次，供校验与读模型使用（不修改目录数据） */
const ITEM_BY_ID = new Map<string, GuidePerformanceItem>();

for (const domain of GUIDE_CATALOG.domains) {
  for (const subDomain of domain.sub_domains) {
    for (const goal of subDomain.goals) {
      for (const item of goal.items) {
        ITEM_BY_ID.set(item.id, item);
      }
    }
  }
}

export function guideItemById(itemId: string): GuidePerformanceItem | null {
  return ITEM_BY_ID.get(itemId) ?? null;
}

export function guideItemCount(): number {
  return ITEM_BY_ID.size;
}
