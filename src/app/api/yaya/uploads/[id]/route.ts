import { NextRequest, NextResponse } from "next/server";

import {
  attachmentMetadataView,
  evaluateAttachmentRead,
} from "@/lib/media/content-service";
import { requireMediaReadPrincipal } from "@/lib/media/request-guard";
import { createDatabaseRecordAccessLoader } from "@/lib/media/record-access";
import { mediaRouteError } from "@/lib/media/route-error";
import { mediaRuntimeOrThrow } from "@/lib/media/runtime";

/**
 * GET /api/yaya/uploads/[id]
 *
 * 附件元数据（认证读取）：
 * - 已关联图片按 record_kind + record_id 当前授权；历史只读只返回元数据；
 * - 未关联图片仅上传者本人；无权限一律拒绝；
 * - 不含对象 key、公开/签名 URL。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await requireMediaReadPrincipal(request);
    const { id } = await params;
    const runtime = mediaRuntimeOrThrow();
    const evaluation = await evaluateAttachmentRead(runtime, {
      attachment_id: id,
      viewer: { account_id: principal.account_id, role: principal.role },
      loadRecordAccess: createDatabaseRecordAccessLoader(principal),
    });
    return NextResponse.json(attachmentMetadataView(evaluation));
  } catch (error) {
    return mediaRouteError(error);
  }
}
