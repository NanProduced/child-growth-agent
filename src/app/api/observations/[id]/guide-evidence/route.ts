import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";

import { requireTeacher } from "@/lib/auth";
import {
  GuideEvidenceCatalogError,
  GuideEvidenceConflictError,
  GuideEvidenceInvalidError,
  GuideEvidenceNotFoundError,
} from "@/lib/guide/decisions";
import { parseGuideEvidence } from "@/lib/guide/runtime";
import { generateGuideEvidenceSuggestions } from "@/lib/guide/suggest";
import {
  applyGuideEvidenceMutation,
  getObservation,
  saveGuideEvidenceSuggestionResult,
} from "@/lib/queries";
import { guideEvidenceMutationSchema } from "@/lib/validation";

/**
 * 指南证据操作（G5）：suggest / confirm / reject / withdraw。
 * - 需教师身份；模型调用在事务外；全部决定先校验后写入（全有或全无）。
 * - suggest 失败按契约返回 200 + ai_link_failed，记录 last_attempt{ok:false}。
 */

function errorResponse(
  status: number,
  error: string,
  message: string,
  refs: { link_id?: string; item_id?: string } = {},
) {
  return NextResponse.json({ error, message, ...refs }, { status });
}

function containerRevision(value: unknown): number {
  const parsed = parseGuideEvidence(value);
  return parsed.kind === "ok" ? parsed.revision : 0;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = guideEvidenceMutationSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      parsed.error.issues[0]?.message ?? "请求体不合法",
    );
  }

  try {
    const observation = await getObservation(id);
    if (!observation) {
      return errorResponse(404, "not_found", "观察记录不存在");
    }

    if (parsed.data.action === "suggest") {
      const generated = await generateGuideEvidenceSuggestions(observation, {
        forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
      });
      const saved = await saveGuideEvidenceSuggestionResult(id, {
        expectedRevision: containerRevision(observation.guide_evidence),
        expectedStatus: observation.status,
        expectedRawText: observation.raw_text,
        expectedAiDraft: observation.ai_draft,
        expectedConfirmedContent: observation.confirmed_content,
        ok: generated.ok,
        model: generated.model,
        error: generated.ok ? undefined : generated.error,
        suggestions: generated.ok ? generated.suggestions : [],
      });
      return NextResponse.json({
        observation_id: id,
        revision: saved.revision,
        links: saved.links,
        ...(generated.ok
          ? {}
          : {
              notice: {
                code: "ai_link_failed",
                severity: "warning",
                message: `AI 关联建议没有成功：${generated.error}`,
              },
            }),
      });
    }

    const result = await applyGuideEvidenceMutation(id, parsed.data);
    return NextResponse.json({
      observation_id: id,
      revision: result.revision,
      links: result.links,
    });
  } catch (error) {
    if (error instanceof GuideEvidenceInvalidError) {
      return errorResponse(400, "invalid_request", error.message, {
        link_id: error.link_id,
        item_id: error.item_id,
      });
    }
    if (error instanceof GuideEvidenceCatalogError) {
      return errorResponse(409, "catalog_version_mismatch", error.message, {
        item_id: error.item_id,
      });
    }
    if (error instanceof GuideEvidenceNotFoundError) {
      return errorResponse(404, "not_found", error.message, { link_id: error.link_id });
    }
    if (error instanceof GuideEvidenceConflictError) {
      return errorResponse(409, "state_conflict", error.message, {
        link_id: error.link_id,
        item_id: error.item_id,
      });
    }
    return errorResponse(
      500,
      "server_error",
      error instanceof Error ? error.message : "指南证据操作失败",
    );
  }
}
