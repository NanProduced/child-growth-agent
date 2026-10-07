import { NextRequest, NextResponse } from "next/server";
import { yayaDataRepository, withPrivateRead, yayaRouteError } from "@/lib/yaya/data";
import { YayaDataError } from "@/lib/yaya/storage-types";
import { createYayaToolkit } from "@/lib/yaya/tools/write";

/**
 * GET 原操作查询（只读）：当前 owner 先验证，再按原身份返回进行中/确定结果/未知；
 * GET 不续期、不写库、不调用模型。
 *
 * POST 授权执行（TOOLS1）：只接受 `{ approval_id, operation_ids }`；提交者身份/会话/
 * CSRF 由服务端解析，业务变化/批准消费/回执在同一事务内完成。
 */
export async function GET(request: NextRequest) {
  try {
    const operationId = request.nextUrl.searchParams.get("operation_id");
    const batchId = request.nextUrl.searchParams.get("batch_id");
    if (operationId !== null && operationId.trim() !== "") {
      const operation = await withPrivateRead(request, ({ client, principal }) =>
        yayaDataRepository.queryOperation(client, principal.account_id, operationId),
      );
      if (!operation) throw new YayaDataError("operation_not_found", "操作不存在。");
      return NextResponse.json({ operation });
    }
    if (batchId !== null && batchId.trim() !== "") {
      const batch = await withPrivateRead(request, ({ client, principal }) =>
        yayaDataRepository.queryBatch(client, principal.account_id, batchId),
      );
      return NextResponse.json({ batch });
    }
    throw new YayaDataError("invalid_request", "缺少 operation_id 或 batch_id。");
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const runtime = createYayaToolkit();
    const result = await runtime.executeOperations(request, body);
    if (result.kind === "needs_prepare") {
      return NextResponse.json(
        {
          error: "approval_invalid",
          message: result.message,
          details: {
            reason: "needs_prepare",
            operation_id: result.operation_id,
            ...(result.notice ? { notice: result.notice } : {}),
          },
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ receipts: result.receipts });
  } catch (error) {
    return yayaRouteError(error);
  }
}
