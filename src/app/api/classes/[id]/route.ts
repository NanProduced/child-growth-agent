import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { classHasHistory, getClassHistoryCounts } from "@/lib/class-context";
import { findClassByName, getClass, getClassChildren, updateClass } from "@/lib/queries";
import { updateClassSchema } from "@/lib/validation";

/** 班级详情：GET 只读（返回班级、当前在班儿童与使用历史）；PATCH 需教师身份（含停用 is_active） */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const found = await getClass(id);
    if (!found) {
      return NextResponse.json({ message: "班级不存在" }, { status: 404 });
    }
    return NextResponse.json({
      class: found,
      children: await getClassChildren(id),
      history: await getClassHistoryCounts(id),
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询班级失败" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateClassSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const found = await getClass(id);
    if (!found) {
      return NextResponse.json({ message: "班级不存在" }, { status: 404 });
    }

    // 已有使用历史的班级不能直接改学段/学年“升班”：避免旧观察与分班历史的阶段口径被改写。
    // 名称修改与停用不受影响。
    const changingStage = parsed.data.stage !== undefined && parsed.data.stage !== found.stage;
    const changingYear =
      parsed.data.school_year !== undefined && parsed.data.school_year !== found.school_year;
    if (changingStage || changingYear) {
      const history = await getClassHistoryCounts(id);
      if (classHasHistory(history)) {
        return NextResponse.json(
          {
            error: "class_history_protected",
            message:
              "该班级已有分班或观察记录，不能直接修改学段或学年。升班请建立新学年的班级并把幼儿转过去；班级名称与停用仍可修改。",
            history,
          },
          { status: 409 }
        );
      }
    }

    const nextName = parsed.data.name ?? found.name;
    const nextYear = parsed.data.school_year ?? found.school_year;
    if (nextName !== found.name || nextYear !== found.school_year) {
      const existing = await findClassByName(nextName, nextYear);
      if (existing && existing.id !== id) {
        return NextResponse.json(
          { message: `同学年下已存在同名班级「${nextName}」` },
          { status: 409 }
        );
      }
    }
    const updated = await updateClass(id, parsed.data);
    if (!updated) {
      return NextResponse.json({ message: "班级不存在" }, { status: 404 });
    }
    return NextResponse.json({ class: updated });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "更新班级失败" },
      { status: 500 }
    );
  }
}
