import { GUIDE_CATALOG, GUIDE_EDUCATION_SUGGESTIONS } from "@/data/guide";

import type {
  GuideDomainCode,
  GuideDomainRef,
  GuideEducationSuggestion,
  GuideGoalRef,
  GuideItemDetail,
  GuideItemFilter,
  GuidePerformanceItem,
  GuideSubDomainRef,
} from "./types";

interface CatalogIndex {
  allItems: GuidePerformanceItem[];
  detailsById: Map<string, GuideItemDetail>;
  suggestionsByGoal: Map<string, GuideEducationSuggestion[]>;
  domainCodeByDomainId: Map<string, GuideDomainCode>;
}

const catalogIndex = buildIndex();

function buildIndex(): CatalogIndex {
  const allItems: GuidePerformanceItem[] = [];
  const detailsById = new Map<string, GuideItemDetail>();
  const suggestionsByGoal = new Map<string, GuideEducationSuggestion[]>();
  const domainCodeByDomainId = new Map<string, GuideDomainCode>();

  for (const suggestion of GUIDE_EDUCATION_SUGGESTIONS) {
    const list = suggestionsByGoal.get(suggestion.goal_id);
    if (list) {
      list.push(suggestion);
    } else {
      suggestionsByGoal.set(suggestion.goal_id, [suggestion]);
    }
  }

  for (const domain of GUIDE_CATALOG.domains) {
    domainCodeByDomainId.set(domain.id, domain.code);
    const domainRef: GuideDomainRef = { id: domain.id, code: domain.code, name: domain.name };
    for (const subDomain of domain.sub_domains) {
      const subDomainRef: GuideSubDomainRef = {
        id: subDomain.id,
        domain_id: subDomain.domain_id,
        name: subDomain.name,
      };
      for (const goal of subDomain.goals) {
        const goalRef: GuideGoalRef = {
          id: goal.id,
          domain_id: goal.domain_id,
          sub_domain_id: goal.sub_domain_id,
          index: goal.index,
          title: goal.title,
        };
        const educationSuggestions = suggestionsByGoal.get(goal.id) ?? [];
        for (const item of goal.items) {
          allItems.push(item);
          detailsById.set(item.id, {
            item,
            goal: goalRef,
            sub_domain: subDomainRef,
            domain: domainRef,
            education_suggestions: educationSuggestions,
          });
        }
      }
    }
  }

  return { allItems, detailsById, suggestionsByGoal, domainCodeByDomainId };
}

/** 目录条目查询：按领域 / 子领域 / 目标 / 年龄段筛选；缺省返回全部条目 */
export async function listGuideItems(filter: GuideItemFilter = {}): Promise<GuidePerformanceItem[]> {
  return catalogIndex.allItems.filter((item) => {
    if (filter.domain_code && catalogIndex.domainCodeByDomainId.get(item.domain_id) !== filter.domain_code) {
      return false;
    }
    if (filter.sub_domain_id && item.sub_domain_id !== filter.sub_domain_id) return false;
    if (filter.goal_id && item.goal_id !== filter.goal_id) return false;
    if (filter.age_band && item.age_band !== filter.age_band) return false;
    return true;
  });
}

/** 条目详情：包含定位链与目标级教育建议；不存在返回 null */
export async function getGuideItem(itemId: string): Promise<GuideItemDetail | null> {
  return catalogIndex.detailsById.get(itemId) ?? null;
}

/** 目标的教育建议：独立于儿童证据；未知目标返回空数组 */
export async function listEducationSuggestions(goalId: string): Promise<GuideEducationSuggestion[]> {
  return [...(catalogIndex.suggestionsByGoal.get(goalId) ?? [])];
}
