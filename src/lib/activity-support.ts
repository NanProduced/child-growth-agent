import { generateActivitySupport } from "./ai";
import {
  assertEvidenceUnchanged,
  buildGrowthProfileFallback,
  confirmedObservationIds,
} from "./growth-profile";
import { updateChildActivitySupport } from "./queries";
import { activitySupportSchema } from "./validation";
import type {
  ActivitySupport,
  Child,
  GrowthProfile,
  Observation,
} from "./types";
import { invokeLlm } from "./llm";

export type ActivitySupportUpdateOptions = {
  invoke?: typeof invokeLlm;
  save?: typeof updateChildActivitySupport;
  reloadObservations?: (childId: string) => Promise<Observation[]>;
  forwardHeaders?: Record<string, string>;
};

export type ActivitySupportUpdateResult = {
  activitySupport: ActivitySupport;
  growthProfile: Child["growth_profile"];
};

export function confirmedObservations(observations: Observation[]): Observation[] {
  return observations.filter(
    (observation) => observation.status === "confirmed" && observation.confirmed_content,
  );
}

export function hasCurrentActivitySupport(
  activitySupport: ActivitySupport | null | undefined,
  observations: Observation[],
): boolean {
  const confirmedIds = confirmedObservations(observations).map((observation) => observation.id);
  if (!activitySupport || confirmedIds.length === 0) return false;
  return (
    activitySupport.source_observation_ids.length === confirmedIds.length &&
    confirmedIds.every((id) => activitySupport.source_observation_ids.includes(id)) &&
    activitySupportSchema.safeParse(activitySupport).success
  );
}

/** 只把仍有确认来源的小结喂给活动模型；保存时不改写小结本身 */
function supportedGrowthProfile(
  child: Child,
  observations: Observation[],
): Child["growth_profile"] {
  const profile = child.growth_profile;
  if (!profile || profile.source_observation_ids.length === 0) return null;
  const confirmedIds = new Set(confirmedObservations(observations).map((observation) => observation.id));
  return profile.source_observation_ids.every((id) => confirmedIds.has(id)) ? profile : null;
}

/** 已存小结必须完整可读；残缺 JSONB 视为没有小结，走保守 fallback */
function storedGrowthProfile(child: Child): GrowthProfile | null {
  const profile = child.growth_profile;
  if (!profile || typeof profile.summary !== "string" || !profile.summary.trim()) return null;
  return profile;
}

/**
 * 没有已存小结时的保守回退：内容来自已确认观察，不标记为模型生成，
 * 也不把活动支持的模型名伪造成成长小结生成模型。
 */
function buildFallbackProfile(
  observations: Observation[],
  updatedAt: string,
): GrowthProfile | null {
  const draft = buildGrowthProfileFallback(observations);
  if (!draft) return null;
  return {
    ...draft,
    source_observation_ids: observations.map((observation) => observation.id),
    ai_model: "",
    updated_at: updatedAt,
    is_fallback: true,
  };
}

export async function updateActivitySupport(
  child: Child,
  observations: Observation[],
  options: ActivitySupportUpdateOptions = {},
): Promise<ActivitySupportUpdateResult> {
  const confirmed = confirmedObservations(observations);
  if (confirmed.length === 0) {
    throw new Error("活动支持建议需要至少一条已确认观察");
  }
  const expectedIds = confirmedObservationIds(confirmed);

  const generated = await generateActivitySupport(
    {
      childName: child.name,
      childGender: child.gender,
      childBirthDate: child.birth_date,
      classStage: child.class_stage,
      className: child.class_name,
      observations: confirmed,
      growthProfile: supportedGrowthProfile(child, confirmed),
      forwardHeaders: options.forwardHeaders,
    },
    options.invoke,
  );
  await assertEvidenceUnchanged(child.id, expectedIds, options.reloadObservations);

  const generatedAt = new Date().toISOString();
  const activitySupport: ActivitySupport = {
    ...generated.activitySupport,
    source_observation_ids: confirmed.map((observation) => observation.id),
    ai_model: generated.model,
    generated_at: generatedAt,
  };

  const fallbackProfile = storedGrowthProfile(child)
    ? null
    : buildFallbackProfile(confirmed, generatedAt);

  // 保存层原子条件：写入时数据库中的已确认观察集合必须仍等于本次生成使用的快照
  const saved = await (options.save ?? updateChildActivitySupport)(
    child.id,
    activitySupport,
    fallbackProfile,
    expectedIds,
  );
  return {
    activitySupport,
    growthProfile: saved.growth_profile,
  };
}
