import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";

import { requireTeacher } from "@/lib/auth";
import { updateGrowthProfileSafely } from "@/lib/growth-profile";
import { getChild, listObservations } from "@/lib/queries";

/** 教师主动重试成长档案 Agent；只读取已确认观察，不重新确认观察。 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;

  try {
    const child = await getChild(id);
    if (!child) {
      return NextResponse.json({ message: "成长档案不存在" }, { status: 404 });
    }

    const observations = await listObservations({ childId: id, status: "confirmed" });
    if (!observations.some((observation) => observation.confirmed_content)) {
      return NextResponse.json(
        { message: "还没有已确认的观察，暂时不能更新成长小结。" },
        { status: 400 },
      );
    }

    const result = await updateGrowthProfileSafely(child, observations, {
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    if (result.status === "failed") {
      return NextResponse.json(
        { message: result.message ?? "成长档案暂未更新，请稍后重试。" },
        { status: 502 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "更新成长档案失败，请稍后重试" },
      { status: 500 },
    );
  }
}
