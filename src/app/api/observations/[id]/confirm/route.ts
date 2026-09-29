import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { confirmObservation, getObservation } from "@/lib/queries";
import { confirmObservationSchema } from "@/lib/validation";

/**
 * 教师确认：AI 草稿经教师核对/修改后写入 confirmed_content，状态置为 confirmed。
 * 只有进入过 AI 整理（ai_organized）的记录可以确认；原文与 AI 草稿保留可追溯。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = confirmObservationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "确认内容不完整" },
      { status: 400 }
    );
  }

  try {
    const observation = await getObservation(id);
    if (!observation) {
      return NextResponse.json({ message: "观察记录不存在" }, { status: 404 });
    }
    if (observation.status === "confirmed") {
      return NextResponse.json(
        { message: "该记录已确认归档，无需重复确认。" },
        { status: 409 }
      );
    }
    if (observation.status !== "ai_organized") {
      return NextResponse.json(
        { message: "请先生成并核对 AI 整理草稿，再进行确认归档。" },
        { status: 409 }
      );
    }

    const confirmed = await confirmObservation(observation.id, {
      ...parsed.data.content,
      teacher_note: parsed.data.teacher_note?.trim() ? parsed.data.teacher_note.trim() : undefined,
    });
    return NextResponse.json({ observation: confirmed });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "确认归档失败" },
      { status: 500 }
    );
  }
}
