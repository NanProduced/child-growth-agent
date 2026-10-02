import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";

import {
  confirmedObservations,
  updateActivitySupport,
} from "@/lib/activity-support";
import { requireTeacher } from "@/lib/auth";
import { StaleEvidenceError } from "@/lib/growth-profile";
import { getChild, listObservations } from "@/lib/queries";

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
    if (confirmedObservations(observations).length === 0) {
      return NextResponse.json({
        activitySupport: null,
        message: "还没有已确认的观察，请先确认一条观察后再生成活动支持。",
      });
    }

    const result = await updateActivitySupport(child, observations, {
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof StaleEvidenceError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "生成活动支持失败，请稍后重试" },
      { status: 500 },
    );
  }
}
