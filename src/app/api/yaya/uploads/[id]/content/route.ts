import { NextRequest, NextResponse } from "next/server";

import { evaluateAttachmentRead, loadAttachmentContent } from "@/lib/media/content-service";
import { bindDataAttachmentMetadataPort } from "@/lib/media/data-adapter";
import { withPrivateRead } from "@/lib/yaya/data/private-auth";
import { MediaError } from "@/lib/media/errors";
import { MEDIA_VARIANTS, type MediaVariant } from "@/lib/media/limits";
import { requireMediaReadPrincipal } from "@/lib/media/request-guard";
import { createDatabaseRecordAccessLoader } from "@/lib/media/record-access";
import { mediaRouteError } from "@/lib/media/route-error";
import { mediaRuntimeOrThrow } from "@/lib/media/runtime";

/**
 * GET /api/yaya/uploads/[id]/content?variant=original|thumbnail|model
 *
 * 认证内容代理：字节只在服务端授权后返回；
 * - 历史只读 → 403 metadata_only（不返回字节）；
 * - 无权限/未关联非本人 → 403；对象缺失/回收 → 410；
 * - 不产生公开 URL；响应不可公共缓存；校验 checksum，不返回损坏内容。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const carrier = { headers: new Headers(request.headers) };
    const principal = await requireMediaReadPrincipal(carrier);
    const { id } = await params;
    const variantRaw = request.nextUrl.searchParams.get("variant") ?? "original";
    if (!(MEDIA_VARIANTS as readonly string[]).includes(variantRaw)) {
      throw new MediaError("invalid_variant", "variant 只能是 original、thumbnail 或 model。");
    }
    const runtime = mediaRuntimeOrThrow();
    const content = await loadAttachmentContent(runtime, {
      attachment_id: id,
      viewer: { account_id: principal.account_id, role: principal.role },
      loadRecordAccess: createDatabaseRecordAccessLoader(principal),
      variant: variantRaw as MediaVariant,
    });
    // Recheck after object I/O, in a short transaction coordinating current
    // account/session/assignment and child attribution. No I/O under its locks.
    await withPrivateRead(carrier, async ({ client, principal: current, schoolId }) => {
      const evaluation = await evaluateAttachmentRead({ ...runtime, metadata: bindDataAttachmentMetadataPort(client) }, {
        attachment_id: id,
        viewer: { account_id: current.account_id, role: current.role },
        loadRecordAccess: createDatabaseRecordAccessLoader(current, { client, schoolId }),
      });
      if (!evaluation.decision.readable) {
        throw new MediaError(evaluation.decision.metadata_only ? "metadata_only" : "forbidden", "当前账号不能读取图片内容。");
      }
    });
    return new NextResponse(new Uint8Array(content.body), {
      status: 200,
      headers: {
        "Content-Type": content.content_type,
        "Content-Length": String(content.byte_size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return mediaRouteError(error);
  }
}
