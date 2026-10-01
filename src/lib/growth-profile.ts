import { generateGrowthProfile } from "./ai";
import { StaleEvidenceError } from "./evidence-snapshot";
import { invokeLlm } from "./llm";
import { listObservations, updateChildGrowthProfileSummary } from "./queries";
import type { Child, GrowthProfile, GrowthProfileDraft, Observation } from "./types";

export { StaleEvidenceError } from "./evidence-snapshot";

export type ProfileUpdateStatus = "updated" | "failed";

export interface ProfileUpdateResult {
  status: ProfileUpdateStatus;
  growthProfile?: GrowthProfile;
  message?: string;
}

type ProfileUpdateOptions = {
  invoke?: typeof invokeLlm;
  save?: typeof updateChildGrowthProfileSummary;
  reloadObservations?: (childId: string) => Promise<Observation[]>;
  /** 服务端当前日期；测试与评测可注入固定日期 */
  currentDate?: string;
  forwardHeaders?: Record<string, string>;
};

function confirmedObservations(observations: Observation[]): Observation[] {
  return observations.filter(
    (observation) => observation.status === "confirmed" && observation.confirmed_content,
  );
}

export function confirmedObservationIds(observations: Observation[]): string[] {
  return confirmedObservations(observations)
    .map((observation) => observation.id)
    .sort();
}

/** 慢请求完成时核对证据快照；集合变化则拒绝写入旧结果 */
export async function assertEvidenceUnchanged(
  childId: string,
  expectedIds: string[],
  reloadObservations?: (childId: string) => Promise<Observation[]>,
): Promise<void> {
  const reload =
    reloadObservations ?? ((id: string) => listObservations({ childId: id, status: "confirmed" }));
  const currentIds = confirmedObservationIds(await reload(childId));
  if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
    throw new StaleEvidenceError();
  }
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
  const latestNote =
    content?.objective_description || content?.highlight_quote || latest.raw_text;
  // 保守回退不把最新表现直接复制成“变化”，也不暗示已有趋势
  const recentChange =
    confirmed.length === 1
      ? `目前只有一条确认观察，还不能判断变化；这条记录是：${latestNote}`
      : `已有多条确认观察，但还没有生成可比较的成长小结；最近一次记录是：${latestNote}`;

  return {
    summary:
      content?.objective_description ||
      `已经确认 ${confirmed.length} 条观察，最近一次记录保留了具体行为与语言证据。`,
    recent_change: recentChange,
    development_clues: clues.length > 0 ? clues : [latestNote],
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
  const expectedIds = confirmedObservationIds(confirmed);

  const generated = await generateGrowthProfile(
    {
      childName: child.name,
      childGender: child.gender,
      childBirthDate: child.birth_date,
      observations: confirmed,
      currentDate: options.currentDate,
      childNote: child.note,
      forwardHeaders: options.forwardHeaders,
    },
    options.invoke,
  );
  await assertEvidenceUnchanged(child.id, expectedIds, options.reloadObservations);

  const growthProfile: GrowthProfile = {
    ...generated.profile,
    source_observation_ids: confirmed.map((observation) => observation.id),
    ai_model: generated.model,
    updated_at: new Date().toISOString(),
  };

  // 保存层原子条件：写入时数据库中的已确认观察集合必须仍等于本次生成使用的快照
  const saved = await (options.save ?? updateChildGrowthProfileSummary)(
    child.id,
    growthProfile,
    expectedIds,
  );
  return saved.growth_profile ?? growthProfile;
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
  } catch (error) {
    if (error instanceof StaleEvidenceError) {
      return {
        status: "failed",
        message: "生成期间已有新的已确认观察，成长小结暂未更新，请重新生成。",
      };
    }
    return {
      status: "failed",
      message: "观察已确认，但成长档案暂未更新，请稍后重试。",
    };
  }
}
