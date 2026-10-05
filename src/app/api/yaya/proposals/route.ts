import { NextRequest, NextResponse } from "next/server";
import type { AccessAction, AccessResourceKind } from "@/lib/accounts/types";
import { yayaDataRepository, withPrivateRead, withPrivateWrite, yayaRouteError } from "@/lib/yaya/data";
import { YayaDataError, type YayaPrepareItemInput } from "@/lib/yaya/storage-types";
import type { YayaToolAuth } from "@/lib/yaya/types";

function parseToolAuth(value: unknown): YayaToolAuth {
  if (typeof value !== "object" || value === null) {
    throw new YayaDataError("invalid_request", "auth 不合法。");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "scope_query") return { kind: "scope_query" };
  if (record.kind === "action" && typeof record.action === "string" && typeof record.resource === "string") {
    return {
      kind: "action",
      action: record.action as AccessAction,
      resource: record.resource as AccessResourceKind,
    };
  }
  throw new YayaDataError("invalid_request", "auth 不合法。");
}

function parsePrepareItems(value: unknown): YayaPrepareItemInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new YayaDataError("invalid_request", "items 不合法。");
  }
  const items: YayaPrepareItemInput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new YayaDataError("invalid_request", "提案条目不合法。");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.item_key !== "string" ||
      typeof record.target_id !== "string" ||
      typeof record.action !== "string" ||
      typeof record.resource !== "string" ||
      typeof record.resource_ref !== "object" ||
      record.resource_ref === null ||
      typeof record.payload !== "object" ||
      record.payload === null ||
      !Array.isArray(record.attachment_associations) ||
      (record.business_revision !== null &&
        record.business_revision !== undefined &&
        typeof record.business_revision !== "string")
    ) {
      throw new YayaDataError("invalid_request", "提案条目不合法。");
    }
    for (const association of record.attachment_associations) {
      if (
        typeof association !== "object" ||
        association === null ||
        typeof (association as Record<string, unknown>).attachment_id !== "string" ||
        typeof (association as Record<string, unknown>).target_id !== "string"
      ) {
        throw new YayaDataError("invalid_request", "附件关联不合法。");
      }
    }
    items.push(entry as unknown as YayaPrepareItemInput);
  }
  return items;
}

/**
 * 提案准备：服务端预分配 proposal/batch/逐项 operation 身份并落库（planned），
 * 不写业务记录、不调用模型。GET 仅本人提案（恢复核对用）。
 */
export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const conversationId = record.conversation_id;
    if (typeof conversationId !== "string" || conversationId.trim() === "") {
      throw new YayaDataError("invalid_request", "缺少 conversation_id。");
    }
    const origin = record.proposal_origin;
    if (origin !== "teacher_card" && origin !== "model_suggestion") {
      throw new YayaDataError("invalid_request", "proposal_origin 不合法。");
    }
    const auth = parseToolAuth(record.auth);
    const items = parsePrepareItems(record.items);
    const proposal = await withPrivateWrite(request, ({ client, principal }) =>
      yayaDataRepository.prepareProposal(client, {
        conversation_id: conversationId,
        proposal_origin: origin,
        auth,
        items,
        owner_account_id: principal.account_id,
      }),
    );
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const proposalId = request.nextUrl.searchParams.get("proposal_id");
    if (proposalId === null || proposalId.trim() === "") {
      throw new YayaDataError("invalid_request", "缺少 proposal_id。");
    }
    const proposal = await withPrivateRead(request, ({ client, principal }) =>
      yayaDataRepository.getProposal(client, principal.account_id, proposalId),
    );
    if (!proposal) throw new YayaDataError("not_found", "提案不存在。");
    return NextResponse.json({ proposal });
  } catch (error) {
    return yayaRouteError(error);
  }
}
