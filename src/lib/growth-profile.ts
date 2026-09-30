import { generateGrowthProfile } from "./ai";
import { invokeLlm } from "./llm";
import { updateChildGrowthProfile } from "./queries";
import type { Child, GrowthProfile, GrowthProfileDraft, Observation } from "./types";

export type ProfileUpdateStatus = "updated" | "failed";

export interface ProfileUpdateResult {
  status: ProfileUpdateStatus;
  growthProfile?: GrowthProfile;
  message?: string;
}

type ProfileUpdateOptions = {
  invoke?: typeof invokeLlm;
  save?: typeof updateChildGrowthProfile;
  forwardHeaders?: Record<string, string>;
};

function confirmedObservations(observations: Observation[]): Observation[] {
  return observations.filter(
    (observation) => observation.status === "confirmed" && observation.confirmed_content,
  );
}

/** 没有已保存 profile 时，只从已有 confirmed 记录拼出可读的保守回退内容。 */
export function buildGrowthProfileFallback(
  observations: Observation[],
): GrowthProfileDraft | null {
  const confirmed = confirmedObservations(observations);
  const latest = confirmed[0];
  if (!latest) return null;

  const content = latest.confirmed_content;
  const clues = confirmed
    .flatMap((observation) => observation.confirmed_content?.highlights ?? [])
    .filter(Boolean)
    .slice(0, 3);

  return {
    summary:
      content?.objective_description ||
      `已经确认 ${confirmed.length} 条观察，最近一次记录保留了具体行为与语言证据。`,
    recent_change:
      content?.objective_description || content?.highlight_quote || latest.raw_text,
    development_clues: clues.length > 0 ? clues : [latest.raw_text],
    next_support:
      content?.support_suggestions?.[0] ||
      "继续记录具体行为和语言，方便下一次回看。",
    next_focus: content?.sub_domain
      ? `下一次可以继续看看「${content.sub_domain}」中的具体行为是否再次出现。`
      : "下一次可以继续看看类似情境中的具体行为和语言。",
  };
}

export async function updateGrowthProfileAfterConfirmation(
  child: Child,
  observations: Observation[],
  options: ProfileUpdateOptions = {},
): Promise<GrowthProfile> {
  const confirmed = confirmedObservations(observations);
  if (confirmed.length === 0) {
    throw new Error("成长档案更新需要至少一条已确认观察");
  }

  const generated = await generateGrowthProfile(
    {
      childName: child.name,
      childGender: child.gender,
      observations: confirmed,
      forwardHeaders: options.forwardHeaders,
    },
    options.invoke,
  );
  const growthProfile: GrowthProfile = {
    ...generated.profile,
    source_observation_ids: confirmed.map((observation) => observation.id),
    ai_model: generated.model,
    updated_at: new Date().toISOString(),
  };

  await (options.save ?? updateChildGrowthProfile)(child.id, growthProfile);
  return growthProfile;
}

export async function updateGrowthProfileSafely(
  child: Child,
  observations: Observation[],
  options: ProfileUpdateOptions = {},
): Promise<ProfileUpdateResult> {
  try {
    return {
      status: "updated",
      growthProfile: await updateGrowthProfileAfterConfirmation(child, observations, options),
    };
  } catch {
    return {
      status: "failed",
      message: "观察已确认，但成长档案暂未更新，请稍后重试。",
    };
  }
}
