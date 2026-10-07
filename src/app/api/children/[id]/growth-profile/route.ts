import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";

import { runBusinessWrite, AccountsError, mapAccountsError } from "@/lib/auth";
import { StaleEvidenceError, updateGrowthProfileAfterConfirmation } from "@/lib/growth-profile";
import { getChild, listObservations } from "@/lib/queries";

/** 教师主动重试成长档案 Agent；只读取已确认观察，不重新确认观察。 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    return await runBusinessWrite(request, "growth_profile.write", { kind: "child", child_id: id }, async () => {
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

    const growthProfile = await updateGrowthProfileAfterConfirmation(child, observations, {
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    return NextResponse.json({ status: "updated", growthProfile });
    });
  } catch (error) {
    if (error instanceof AccountsError) return mapAccountsError(error);
    if (error instanceof StaleEvidenceError) return NextResponse.json({ error: "state_conflict", message: error.message }, { status: 409 });
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "更新成长档案失败，请稍后重试" },
      { status: 500 },
    );
  }
}
