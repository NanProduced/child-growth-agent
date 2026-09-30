import { generateActivitySupport } from "./ai";
import { buildGrowthProfileFallback } from "./growth-profile";
import { updateChildGrowthProfile } from "./queries";
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
  save?: typeof updateChildGrowthProfile;
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

function supportedGrowthProfile(
  child: Child,
  observations: Observation[],
): Child["growth_profile"] {
  const profile = child.growth_profile;
  if (!profile || profile.source_observation_ids.length === 0) return null;
  const confirmedIds = new Set(confirmedObservations(observations).map((observation) => observation.id));
  return profile.source_observation_ids.every((id) => confirmedIds.has(id)) ? profile : null;
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

  const generated = await generateActivitySupport(
    {
      childName: child.name,
      childGender: child.gender,
      observations: confirmed,
      growthProfile: supportedGrowthProfile(child, confirmed),
      forwardHeaders: options.forwardHeaders,
    },
    options.invoke,
  );
  const generatedAt = new Date().toISOString();
  const activitySupport: ActivitySupport = {
    ...generated.activitySupport,
    source_observation_ids: confirmed.map((observation) => observation.id),
    ai_model: generated.model,
    generated_at: generatedAt,
  };

  const baseProfile = child.growth_profile ?? buildGrowthProfileFallback(confirmed);
  if (!baseProfile) throw new Error("活动支持建议缺少可保存的已确认成长依据");

  const nextProfile: GrowthProfile = {
    ...baseProfile,
    source_observation_ids:
      supportedGrowthProfile(child, confirmed)?.source_observation_ids ??
      confirmed.map((observation) => observation.id),
    ai_model: child.growth_profile?.ai_model ?? generated.model,
    updated_at: generatedAt,
    activity_support: activitySupport,
  };

  const saved = await (options.save ?? updateChildGrowthProfile)(child.id, {
    ...nextProfile,
  });
  return {
    activitySupport,
    growthProfile: saved.growth_profile,
  };
}
