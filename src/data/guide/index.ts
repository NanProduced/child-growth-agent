import type { GuideCatalog, GuideEducationSuggestion } from "@/lib/guide/types";
import { GUIDE_CATALOG_VERSION } from "@/lib/guide/types";

import { ARTS_DOMAIN, ARTS_EDUCATION_SUGGESTIONS } from "./arts";
import { HEALTH_DOMAIN, HEALTH_EDUCATION_SUGGESTIONS } from "./health";
import { LANGUAGE_DOMAIN, LANGUAGE_EDUCATION_SUGGESTIONS } from "./language";
import { SCIENCE_DOMAIN, SCIENCE_EDUCATION_SUGGESTIONS } from "./science";
import { SOCIAL_DOMAIN, SOCIAL_EDUCATION_SUGGESTIONS } from "./social";
import { guideSource } from "./source";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export const GUIDE_CATALOG: GuideCatalog = deepFreeze<GuideCatalog>({
  version: GUIDE_CATALOG_VERSION,
  source: guideSource("目录"),
  domains: [HEALTH_DOMAIN, LANGUAGE_DOMAIN, SOCIAL_DOMAIN, SCIENCE_DOMAIN, ARTS_DOMAIN],
});

export const GUIDE_EDUCATION_SUGGESTIONS: GuideEducationSuggestion[] = deepFreeze<GuideEducationSuggestion[]>([
  ...HEALTH_EDUCATION_SUGGESTIONS,
  ...LANGUAGE_EDUCATION_SUGGESTIONS,
  ...SOCIAL_EDUCATION_SUGGESTIONS,
  ...SCIENCE_EDUCATION_SUGGESTIONS,
  ...ARTS_EDUCATION_SUGGESTIONS,
]);
