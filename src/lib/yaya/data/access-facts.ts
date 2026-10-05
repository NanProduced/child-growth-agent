/**
 * 服务端资源事实读取与来源投影（DATA1）。
 *
 * - 资源事实只从数据库当前值读取，不采信请求体/模型自报；
 * - 逐来源用 AUTH `authorizeAction` 核验，未知/损坏来源保守为 broken，
 *   权限服务不可用保守为 unavailable，绝不默认 full；
 * - 附件读取与聊天附件投影同一口径（冻结 `decideImageReadAccess`）：
 *   未关联素材仅上传者；已关联按 record_kind + record_id 匹配，多引用取最佳投影。
 */
import type { TransactionClient } from "@/storage/database/pg-client";
import { authorizeAction, isLegalAccessCombination } from "../../accounts/authorize";
import type {
  AccessAction,
  AccessDecision,
  AccessResource,
  AccessResourceKind,
  Principal,
} from "../../accounts/types";
import {
  decideImageReadAccess,
  type YayaEvaluatedAttachment,
  type YayaEvaluatedSource,
  type YayaImageViewerRecordAccess,
  type YayaMessageSourceRef,
  type YayaSourceAccess,
} from "../types";
import type { YayaItemResourceRef, YayaProposalItemAccess } from "../storage-types";
import { parseResourceRef } from "./rows";

/** 与 AUTH `resourceFacts` 相同的读取语义；缺失资源返回 null，不伪造事实 */
export async function readAccessResourceFacts(
  client: TransactionClient,
  ref: YayaItemResourceRef,
  schoolId: string,
  write = false,
): Promise<AccessResource | null> {
  if (ref.kind === "school") return { kind: "school", school_id: schoolId };
  if (ref.kind === "class") {
    if (ref.class_id === null) return { kind: "class", class_id: "new-class" };
    const result = await client.query("SELECT id FROM classes WHERE id = $1", [ref.class_id]);
    return result.rowCount ? { kind: "class", class_id: ref.class_id } : null;
  }
  let childId: string;
  let observation:
    | { child_id: string; class_id: string | null; created_by_account_id: string | null }
    | undefined;
  if (ref.kind === "observation") {
    const found = await client.query<NonNullable<typeof observation>>(
      `SELECT child_id, class_id, to_jsonb(o.*)->>'created_by_account_id' AS created_by_account_id
         FROM observations o WHERE id = $1`,
      [ref.observation_id],
    );
    observation = found.rows[0];
    if (!observation) return null;
    childId = observation.child_id;
  } else {
    childId = ref.child_id;
  }
  const child = await client.query(
    `SELECT id FROM children WHERE id = $1 FOR ${write ? "UPDATE" : "SHARE"}`,
    [childId],
  );
  if (!child.rowCount) return null;
  const enrollment = await client.query<{ class_id: string }>(
    `SELECT class_id FROM child_class_enrollments
      WHERE child_id = $1 AND end_date IS NULL ORDER BY start_date DESC LIMIT 1`,
    [childId],
  );
  const currentClassId = enrollment.rows[0]?.class_id ?? null;
  if (ref.kind === "observation" && observation) {
    return {
      kind: "observation",
      observation_id: ref.observation_id,
      child_id: childId,
      current_class_id: currentClassId,
      observed_class_id: observation.class_id,
      author_account_id: observation.created_by_account_id,
    };
  }
  if (ref.kind === "transfer") {
    return { kind: "transfer", child_id: childId, current_class_id: currentClassId, target_class_id: ref.target_class_id };
  }
  return { kind: "child", child_id: childId, current_class_id: currentClassId };
}

function decisionToSourceAccess(decision: AccessDecision): YayaSourceAccess {
  if (decision.allowed) {
    return decision.projection === "full" ? "full" : "historical_read_only";
  }
  if ("invalid_request" in decision) return "broken";
  switch (decision.deny) {
    case "identity_unavailable":
    case "account_disabled":
      return "unavailable";
    case "unauthenticated":
    case "forbidden_role":
    case "out_of_scope":
    case "empty_scope":
      return "denied";
  }
}

function isMessageSourceRef(value: unknown): value is YayaMessageSourceRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "child") {
    return typeof record.child_id === "string" && record.child_id.trim() !== "";
  }
  if (record.kind === "class") {
    return typeof record.class_id === "string" && record.class_id.trim() !== "";
  }
  if (record.kind === "observation") {
    return typeof record.observation_id === "string" && record.observation_id.trim() !== "";
  }
  return false;
}

async function evaluateOneSource(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  source: YayaMessageSourceRef,
): Promise<YayaSourceAccess> {
  try {
    const ref: YayaItemResourceRef =
      source.kind === "child"
        ? { kind: "child", child_id: source.child_id }
        : source.kind === "class"
          ? { kind: "class", class_id: source.class_id }
          : { kind: "observation", observation_id: source.observation_id };
    const facts = await readAccessResourceFacts(client, ref, schoolId);
    if (facts === null) return "broken";
    const action =
      source.kind === "class" ? "class.read" : source.kind === "child" ? "child.read" : "observation.read";
    return decisionToSourceAccess(authorizeAction(principal, action, facts));
  } catch {
    return "unavailable";
  }
}

/**
 * 逐片段逐来源核验。`unavailable` 来源不算 full；缺失/损坏来源是 broken。
 */
export async function evaluateFragmentSources(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  fragments: readonly { fragment_id: string; sources: readonly unknown[] }[],
): Promise<YayaEvaluatedSource[]> {
  const evaluations: YayaEvaluatedSource[] = [];
  for (const fragment of fragments) {
    for (let index = 0; index < fragment.sources.length; index += 1) {
      const source = fragment.sources[index];
      const access: YayaSourceAccess = isMessageSourceRef(source)
        ? await evaluateOneSource(client, principal, schoolId, source)
        : "broken";
      evaluations.push({ fragment_id: fragment.fragment_id, source_index: index, access });
    }
  }
  return evaluations;
}

interface AttachmentRow {
  id: string;
  uploader_account_id: string;
  status: string;
}

interface AttachmentRefRow {
  attachment_id: string;
  record_kind: string;
  record_id: string;
}

interface ProposalItemAccessRow {
  action: string;
  resource: string;
  resource_ref: unknown;
  attachment_associations: unknown;
}

function associationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.attachment_id === "string") ids.push(record.attachment_id);
  }
  return ids;
}

/**
 * 提案条目的当前业务来源访问：
 * - 资源引用/动作/资源组合缺失或损坏 → broken；
 * - 当前事实读取失败/身份服务异常 → unavailable；
 * - 撤销任教、转班等导致越权 → denied；
 * - 历史只读投影 → historical_read_only（不得返回完整 payload）。
 */
export async function evaluateProposalItemAccess(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  item: { action: string; resource: string; resource_ref: unknown },
): Promise<YayaProposalItemAccess> {
  const ref = parseResourceRef(item.resource_ref);
  if (ref === null) return "broken";
  const action = item.action as AccessAction;
  const resource = item.resource as AccessResourceKind;
  if (!isLegalAccessCombination(action, resource)) return "broken";
  try {
    const facts = await readAccessResourceFacts(client, ref, schoolId);
    if (facts === null || facts.kind !== resource) return "broken";
    const decision = authorizeAction(principal, action, facts);
    if (decision.allowed) {
      return decision.projection === "full" ? "full" : "historical_read_only";
    }
    if ("invalid_request" in decision) return "broken";
    switch (decision.deny) {
      case "identity_unavailable":
      case "account_disabled":
        return "unavailable";
      default:
        return "denied";
    }
  } catch {
    return "unavailable";
  }
}

/**
 * 聊天附件投影：未知/缺失授权一律拒绝；历史只读只返回元数据。
 * 查询失败（权限/存储服务不可用）返回 unavailable，不默认 full。
 */
export async function evaluateAttachmentAccess(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  attachmentIds: readonly string[],
): Promise<YayaEvaluatedAttachment[]> {
  if (attachmentIds.length === 0) return [];
  try {
    const attachments = await client.query<AttachmentRow>(
      "SELECT id, uploader_account_id, status FROM yaya_attachments WHERE id = ANY($1::varchar[])",
      [[...attachmentIds]],
    );
    const refs = await client.query<AttachmentRefRow>(
      `SELECT attachment_id, record_kind, record_id FROM yaya_attachment_refs
        WHERE attachment_id = ANY($1::varchar[])`,
      [[...attachmentIds]],
    );
    const byId = new Map(attachments.rows.map((row) => [row.id, row]));
    const results: YayaEvaluatedAttachment[] = [];
    for (const attachmentId of attachmentIds) {
      const row = byId.get(attachmentId);
      if (row === undefined) {
        results.push({ attachment_id: attachmentId, access: "broken" });
        continue;
      }
      if (row.status === "deleted") {
        results.push({ attachment_id: attachmentId, access: "broken" });
        continue;
      }
      if (row.status === "deleting") {
        results.push({ attachment_id: attachmentId, access: "unavailable" });
        continue;
      }
      const attachedRecords = refs.rows.filter(
        (entry) => entry.attachment_id === attachmentId && entry.record_kind !== "message",
      );
      const recordAccess: YayaImageViewerRecordAccess[] = [];
      for (const record of attachedRecords) {
        if (record.record_kind === "observation") {
          const facts = await readAccessResourceFacts(
            client,
            { kind: "observation", observation_id: record.record_id },
            schoolId,
          );
          if (facts === null) continue;
          const decision = authorizeAction(principal, "observation.read", facts);
          if (decision.allowed) recordAccess.push({ record_kind: "observation", record_id: record.record_id, projection: decision.projection });
        } else if (record.record_kind === "proposal") {
          // 提案引用必须按**当前业务来源**投影：仅凭“提案属于本人”不足以 full。
          const proposalItems = await client.query<ProposalItemAccessRow>(
            `SELECT action, resource, resource_ref, attachment_associations
               FROM yaya_proposal_items WHERE proposal_id = $1`,
            [record.record_id],
          );
          for (const item of proposalItems.rows) {
            if (!associationIds(item.attachment_associations).includes(attachmentId)) continue;
            const access = await evaluateProposalItemAccess(client, principal, schoolId, item);
            if (access === "full") {
              recordAccess.push({ record_kind: "proposal", record_id: record.record_id, projection: "full" });
            } else if (access === "historical_read_only") {
              recordAccess.push({
                record_kind: "proposal",
                record_id: record.record_id,
                projection: "historical_read_only",
              });
            }
            break;
          }
        }
      }
      const decision = decideImageReadAccess(
        {
          image_id: attachmentId,
          uploader_account_id: row.uploader_account_id,
          attached_records: attachedRecords.map((entry) => ({
            record_kind: entry.record_kind === "observation" ? ("observation" as const) : ("proposal" as const),
            record_id: entry.record_id,
          })),
        },
        { account_id: principal.account_id, record_access: recordAccess },
      );
      if (decision.readable && decision.via === "business_record") {
        results.push({ attachment_id: attachmentId, access: "full" });
      } else if (decision.readable && decision.via === "uploader_private") {
        results.push({ attachment_id: attachmentId, access: "full" });
      } else if (decision.readable === false && decision.metadata_only) {
        results.push({ attachment_id: attachmentId, access: "historical_read_only" });
      } else {
        results.push({ attachment_id: attachmentId, access: "denied" });
      }
    }
    return results;
  } catch {
    return attachmentIds.map((attachmentId) => ({
      attachment_id: attachmentId,
      access: "unavailable" as const,
    }));
  }
}
