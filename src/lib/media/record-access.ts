import { authorizeAction } from "../accounts/authorize";
import type { AccessResource, Principal } from "../accounts/types";
import type { Observation } from "../types";
import type { YayaImageBusinessRef, YayaImageViewerRecordAccess } from "../yaya/types";
import type { RecordAccessLoader } from "./content-service";
import { getChild, getObservation } from "../queries";

/**
 * 业务记录读取投影（服务端事实）：
 * - 观察事实来自 getObservation（发生时班级）+ getChild（当前班级）；
 * - 授权复用冻结 `authorizeAction(observation.read)`，不另写权限算法；
 * - proposal 记录由 DATA1 存储；在提案 repository 接入前一律视为无权限（保守拒绝，
 *   不是永久 mock 放行）。
 */

export function observationAccessFacts(
  observation: Pick<Observation, "id" | "child_id" | "class_id">,
  currentClassId: string | null,
): AccessResource {
  return {
    kind: "observation",
    observation_id: observation.id,
    child_id: observation.child_id,
    current_class_id: currentClassId,
    observed_class_id: observation.class_id,
    author_account_id: null,
  };
}

export function observationRecordAccess(
  principal: Principal,
  observation: Pick<Observation, "id" | "child_id" | "class_id">,
  currentClassId: string | null,
): YayaImageViewerRecordAccess | null {
  const decision = authorizeAction(
    principal,
    "observation.read",
    observationAccessFacts(observation, currentClassId),
  );
  if (!decision.allowed) return null;
  return {
    record_kind: "observation",
    record_id: observation.id,
    projection: decision.projection === "historical_read_only" ? "historical_read_only" : "full",
  };
}

export function createDatabaseRecordAccessLoader(principal: Principal): RecordAccessLoader {
  return async (record: YayaImageBusinessRef) => {
    if (record.record_kind !== "observation") return null;
    const observation = await getObservation(record.record_id);
    if (observation === null) return null;
    const child = await getChild(observation.child_id);
    return observationRecordAccess(principal, observation, child?.class_id ?? null);
  };
}
