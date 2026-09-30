import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { createObservation, listObservations } from "@/lib/queries";
import { OBSERVATION_STATUSES, type ObservationStatus } from "@/lib/types";
import { createObservationSchema } from "@/lib/validation";

/**
 * 观察记录：
 * - GET 对访客开放（只读），支持 ?child_id= 与 ?status= 过滤；
 * - POST 需教师身份：保存观察原文（raw_text 保存后不可改写）。
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const childId = params.get("child_id") ?? undefined;
  const requestedStatus = params.get("status") ?? undefined;
  if (
    requestedStatus &&
    !(OBSERVATION_STATUSES as readonly string[]).includes(requestedStatus)
  ) {
    return NextResponse.json({ message: "观察状态筛选条件不合法" }, { status: 400 });
  }
  const status = requestedStatus as ObservationStatus | undefined;
  try {
    const observations = await listObservations({ childId, status: status || undefined });
    return NextResponse.json({ observations });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询观察记录失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const body = await request.json().catch(() => null);
  const parsed = createObservationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const observation = await createObservation({
      child_id: parsed.data.child_id,
      observed_at: parsed.data.observed_at,
      context: parsed.data.context?.trim() ? parsed.data.context.trim() : null,
      raw_text: parsed.data.raw_text.trim(),
      is_demo: false,
    });
    return NextResponse.json({ observation }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "保存观察记录失败" },
      { status: 500 }
    );
  }
}
