import { NextRequest, NextResponse } from "next/server";

import { loadChildEvidenceBook } from "@/lib/guide/read-model";

/**
 * 个人证据册读模型（G5）：只读、零模型调用、零数据库写入。
 * 查询参数：scope / semester_id / from / to / domain / age_band / goal_id。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const search = request.nextUrl.searchParams;
  try {
    const result = await loadChildEvidenceBook(id, {
      scope: search.get("scope"),
      semester_id: search.get("semester_id"),
      from: search.get("from"),
      to: search.get("to"),
      domain: search.get("domain"),
      age_band: search.get("age_band"),
      goal_id: search.get("goal_id"),
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.failure.error, message: result.failure.message },
        { status: result.failure.status },
      );
    }
    return NextResponse.json(result.value);
  } catch (error) {
    return NextResponse.json(
      {
        error: "server_error",
        message: error instanceof Error ? error.message : "读取证据册失败",
      },
      { status: 500 },
    );
  }
}
