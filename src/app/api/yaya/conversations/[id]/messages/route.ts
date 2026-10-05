import { NextRequest, NextResponse } from "next/server";
import { yayaDataRepository, withPrivateRead, withPrivateWrite, yayaRouteError } from "@/lib/yaya/data";
import { parseStoredFragments } from "@/lib/yaya/data/rows";
import {
  YayaDataError,
  type YayaMessageExecutionState,
  type YayaMessageKind,
  type YayaMessageRole,
  type YayaStoredFragment,
} from "@/lib/yaya/storage-types";

const ROLES: readonly YayaMessageRole[] = ["user", "assistant", "tool"];
const KINDS: readonly YayaMessageKind[] = ["text", "image", "tool_result", "receipt", "mixed"];
const EXECUTION_STATES: readonly YayaMessageExecutionState[] = [
  "none",
  "pending_approval",
  "executed",
  "unknown",
];

/**
 * 私有消息：GET 按当前授权投影读取（恢复不执行工具）；
 * POST 保存，client_message_id 幂等、expected_conversation_revision 版本前提。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const rawLimit = request.nextUrl.searchParams.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        throw new YayaDataError("invalid_request", "limit 不合法。");
      }
      limit = parsed;
    }
    const result = await withPrivateRead(request, ({ client, principal, schoolId }) =>
      yayaDataRepository.listMessages(client, principal, schoolId, id, limit === undefined ? {} : { limit }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body: unknown = await request.json().catch(() => null);
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const rawClientId = record.client_message_id;
    if (rawClientId !== null && rawClientId !== undefined && typeof rawClientId !== "string") {
      throw new YayaDataError("invalid_request", "client_message_id 不合法。");
    }
    const clientMessageId =
      typeof rawClientId === "string" && rawClientId.trim() !== "" ? rawClientId : null;
    const role = record.role;
    const messageKind = record.message_kind;
    if (typeof role !== "string" || !ROLES.includes(role as YayaMessageRole)) {
      throw new YayaDataError("invalid_request", "消息角色不合法。");
    }
    if (typeof messageKind !== "string" || !KINDS.includes(messageKind as YayaMessageKind)) {
      throw new YayaDataError("invalid_request", "消息类型不合法。");
    }
    const rawExecution = record.execution_state;
    if (
      rawExecution !== undefined &&
      (typeof rawExecution !== "string" ||
        !EXECUTION_STATES.includes(rawExecution as YayaMessageExecutionState))
    ) {
      throw new YayaDataError("invalid_request", "消息执行状态不合法。");
    }
    const parsedFragments = parseStoredFragments(record.fragments ?? []);
    if (parsedFragments.corrupt) {
      throw new YayaDataError("invalid_request", "消息片段形状不合法。");
    }
    const rawAttachments = record.attachment_ids ?? [];
    if (
      !Array.isArray(rawAttachments) ||
      rawAttachments.some((entry) => typeof entry !== "string" || entry.trim() === "")
    ) {
      throw new YayaDataError("invalid_request", "附件列表不合法。");
    }
    const expectedRevision = record.expected_conversation_revision;
    if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 1) {
      throw new YayaDataError("invalid_request", "缺少会话版本前提。");
    }
    const result = await withPrivateWrite(request, ({ client, principal, schoolId }) =>
      yayaDataRepository.saveMessage(client, principal, schoolId, {
        conversation_id: id,
        client_message_id: clientMessageId,
        role: role as YayaMessageRole,
        message_kind: messageKind as YayaMessageKind,
        execution_state: (rawExecution as YayaMessageExecutionState | undefined) ?? "none",
        fragments: parsedFragments.fragments as readonly YayaStoredFragment[],
        attachment_ids: rawAttachments as string[],
        expected_conversation_revision: expectedRevision as number,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return yayaRouteError(error);
  }
}
