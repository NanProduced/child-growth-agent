import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBusinessPrincipal, resolveServerAuth } from "@/lib/accounts/access";
import { runBusinessWrite } from "@/lib/auth";
import { appendObservationImages, type HostObservationFacts } from "@/lib/media/attachment-service";
import { MEDIA_MAX_IMAGES_PER_UPLOAD } from "@/lib/media/limits";
import { mediaRouteError } from "@/lib/media/route-error";
import { mediaRuntimeOrThrow } from "@/lib/media/runtime";
import { getChild, getObservation } from "@/lib/queries";

/**
 * POST /api/observations/[id]/attachments
 *
 * 归档后追加资料附件（attach_observation_images，平台新增能力）：
 * - 授权：宿主幼儿 observation.write/child（runBusinessWrite 复验 + 服务内再核）；
 *   管理员只读，一律 forbidden_role；
 * - 核验：观察已确认、source_confirmed_at 一致、附件 revision 一致、图片归本人所有；
 * - 独立追加审计；不改 raw_text/confirmed_content，不自动成为指南证据。
 */

const appendSchema = z.object({
  image_ids: z.array(z.string().min(1)).min(1).max(MEDIA_MAX_IMAGES_PER_UPLOAD),
  expected_attachment_revision: z.number().int().min(0),
  source_confirmed_at: z.string().min(1).nullable(),
});

async function loadHostFacts(observationId: string): Promise<HostObservationFacts | null> {
  const observation = await getObservation(observationId);
  if (observation === null) return null;
  const child = await getChild(observation.child_id);
  return {
    observation_id: observation.id,
    child_id: observation.child_id,
    status: observation.status,
    confirmed_at: observation.confirmed_at,
    current_class_id: child?.class_id ?? null,
    observed_class_id: observation.class_id,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 先过当前身份，再做存在性读取：未认证/停用/空范围不因 404 探测暴露记录是否存在。
  try {
    requireBusinessPrincipal(await resolveServerAuth());
  } catch (error) {
    return mediaRouteError(error);
  }
  const body = await request.json().catch(() => null);
  const parsed = appendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "追加资料参数不完整。" },
      { status: 400 },
    );
  }
  const existing = await getObservation(id);
  if (existing === null) {
    return NextResponse.json({ error: "not_found", message: "观察记录不存在。" }, { status: 404 });
  }
  try {
    return await runBusinessWrite(
      request,
      "observation.write",
      { kind: "child", child_id: existing.child_id },
      async () => {
        const runtime = mediaRuntimeOrThrow();
        const auth = await resolveServerAuth();
        const principal = requireBusinessPrincipal(auth);
        const host = await loadHostFacts(id);
        if (host === null) {
          return NextResponse.json({ error: "not_found", message: "观察记录不存在。" }, { status: 404 });
        }
        const result = await appendObservationImages(runtime, {
          host,
          principal,
          image_ids: parsed.data.image_ids,
          expected_attachment_revision: parsed.data.expected_attachment_revision,
          source_confirmed_at: parsed.data.source_confirmed_at,
          request_id: request.headers.get("x-request-id"),
        });
        return NextResponse.json({
          observation_id: host.observation_id,
          attachment_revision: result.attachment_revision,
          attached: result.attached,
        });
      },
    );
  } catch (error) {
    return mediaRouteError(error);
  }
}
