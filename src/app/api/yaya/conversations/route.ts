import { NextRequest, NextResponse } from "next/server";
import { yayaDataRepository, withPrivateRead, withPrivateWrite, yayaRouteError } from "@/lib/yaya/data";
import { YayaDataError } from "@/lib/yaya/storage-types";

/**
 * 私有会话：GET 仅当前账号的投影列表（GET 不续期、不写库、不调用模型）；
 * POST 创建会话；账号私有边界先于角色。
 */
export async function GET(request: NextRequest) {
  try {
    const conversations = await withPrivateRead(request, ({ client, principal, schoolId }) =>
      yayaDataRepository.listConversations(client, principal, schoolId),
    );
    return NextResponse.json({ conversations });
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const rawTitle = record.title;
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
      throw new YayaDataError("invalid_request", "会话标题不合法。");
    }
    const title = typeof rawTitle === "string" ? rawTitle.trim() : null;
    if (title !== null && (title.length === 0 || title.length > 200)) {
      throw new YayaDataError("invalid_request", "会话标题长度不合法。");
    }
    const conversation = await withPrivateWrite(request, async ({ client, principal, schoolId }) => {
      const created = await yayaDataRepository.createConversation(client, {
        owner_account_id: principal.account_id,
        title,
      });
      return yayaDataRepository.getConversationSummary(client, principal, schoolId, created.conversation_id);
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return yayaRouteError(error);
  }
}
