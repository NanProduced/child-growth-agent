import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";
import { organizeObservation } from "@/lib/ai";
import { requireTeacher } from "@/lib/auth";
import { getChild, getObservation, updateObservationAiDraft } from "@/lib/queries";

/**
 * AI 整理（真实模型调用）：需教师身份。
 * - 已确认归档的记录不再允许 AI 改写（保护确认稿与追溯链）；
 * - 原文 raw_text 永不改动，仅写入 ai_draft 草稿。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;
  try {
    const observation = await getObservation(id);
    if (!observation) {
      return NextResponse.json({ message: "观察记录不存在" }, { status: 404 });
    }
    if (observation.status === "confirmed") {
      return NextResponse.json(
        { message: "该记录已由教师确认归档，不能再重新进行 AI 整理。" },
        { status: 409 }
      );
    }

    const child = await getChild(observation.child_id);
    if (!child) {
      return NextResponse.json({ message: "关联幼儿档案不存在" }, { status: 400 });
    }

    const { draft, model } = await organizeObservation({
      childName: child.name,
      childGender: child.gender,
      childBirthDate: child.birth_date,
      observedAt: observation.observed_at,
      context: observation.context,
      rawText: observation.raw_text,
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });

    const updated = await updateObservationAiDraft(observation.id, draft, model);
    return NextResponse.json({ observation: updated });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "AI 整理失败" },
      { status: 500 }
    );
  }
}
