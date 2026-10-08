import { authorizeAction } from "../accounts/authorize";
import type { AccessResource, Principal } from "../accounts/types";
import type { Observation } from "../types";
import type { YayaImageBusinessRef, YayaImageViewerRecordAccess } from "../yaya/types";
import type { RecordAccessLoader } from "./content-service";
import { getChild, getObservation } from "../queries";
import { evaluateProposalAttachmentAccess, readAccessResourceFacts } from "../yaya/data/access-facts";
import { withTransaction, type TransactionClient } from "@/storage/database/pg-client";
import { loadAccountsConfig } from "../accounts/config";

/**
 * 业务记录读取投影（服务端事实）：
 * - 观察事实来自 getObservation（发生时班级）+ getChild（当前班级）；
 * - 授权复用冻结 `authorizeAction(observation.read)`，不另写权限算法；
 * - proposal 记录复用 DATA1 的逐图片来源投影；owner 本身不是业务读取授权。
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

export function createDatabaseRecordAccessLoader(
  principal: Principal, context?: { client: TransactionClient; schoolId: string },
): RecordAccessLoader {
  return async (record: YayaImageBusinessRef, attachmentId?: string) => {
    if (record.record_kind === "proposal") {
      const schoolId = context?.schoolId ?? loadAccountsConfig()?.schoolId;
      if (!attachmentId || !schoolId) return null;
      const project = async (client: TransactionClient) => {
        const projection = await evaluateProposalAttachmentAccess(client, principal, schoolId, record.record_id, attachmentId);
        return projection ? { ...record, projection } : null;
      };
      return context ? project(context.client) : withTransaction(project);
    }
    if (record.record_kind !== "observation") return null;
    if (context) {
      const facts = await readAccessResourceFacts(context.client, {
        kind: "observation", observation_id: record.record_id,
      }, context.schoolId);
      if (!facts) return null;
      const decision = authorizeAction(principal, "observation.read", facts);
      return decision.allowed ? { ...record, projection: decision.projection } : null;
    }
    const observation = await getObservation(record.record_id);
    if (observation === null) return null;
    const child = await getChild(observation.child_id);
    return observationRecordAccess(principal, observation, child?.class_id ?? null);
  };
}
