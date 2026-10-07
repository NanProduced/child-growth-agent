import { NextRequest, NextResponse } from "next/server";
import { yayaDataRepository, withPrivateRead, withPrivateWrite, yayaRouteError } from "@/lib/yaya/data";
import { YayaDataError } from "@/lib/yaya/storage-types";

/** 会话详情：GET 投影只读；PATCH 改名（版本前提）；DELETE 软删除并解除本会话消息附件引用。 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const conversation = await withPrivateRead(request, ({ client, principal, schoolId }) =>
      yayaDataRepository.getConversationSummary(client, principal, schoolId, id),
    );
    if (!conversation) throw new YayaDataError("not_found", "会话不存在。");
    return NextResponse.json({ conversation });
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body: unknown = await request.json().catch(() => null);
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const expectedRevision = record.expected_revision;
    if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 1) {
      throw new YayaDataError("invalid_request", "缺少版本前提。");
    }
    const rawTitle = record.title;
    if (rawTitle !== null && typeof rawTitle !== "string") {
      throw new YayaDataError("invalid_request", "会话标题不合法。");
    }
    const title = typeof rawTitle === "string" ? rawTitle.trim() : null;
    if (title !== null && (title.length === 0 || title.length > 200)) {
      throw new YayaDataError("invalid_request", "会话标题长度不合法。");
    }
    const rawSources = record.title_source_fragments;
    let titleSourceFragments: string[] | undefined;
    if (rawSources !== undefined) {
      if (!Array.isArray(rawSources) || rawSources.some((entry) => typeof entry !== "string")) {
        throw new YayaDataError("invalid_request", "标题来源片段不合法。");
      }
      titleSourceFragments = rawSources as string[];
    }
    const conversation = await withPrivateWrite(request, ({ client, principal, schoolId }) =>
      yayaDataRepository.renameConversation(client, {
        principal,
        school_id: schoolId,
        conversation_id: id,
        title,
        ...(titleSourceFragments === undefined ? {} : { title_source_fragments: titleSourceFragments }),
        expected_revision: expectedRevision as number,
      }),
    );
    return NextResponse.json({ conversation });
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const expected = request.nextUrl.searchParams.get("expected_revision");
    const expectedRevision = expected === null ? Number.NaN : Number.parseInt(expected, 10);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new YayaDataError("invalid_request", "缺少版本前提。");
    }
    const result = await withPrivateWrite(request, ({ client, principal, schoolId }) =>
      yayaDataRepository.deleteConversation(client, {
        principal,
        school_id: schoolId,
        conversation_id: id,
        expected_revision: expectedRevision,
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return yayaRouteError(error);
  }
}
