import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { findClassByName, getClass, getClassChildren, updateClass } from "@/lib/queries";
import { updateClassSchema } from "@/lib/validation";

/** 班级详情：GET 只读（返回班级与当前在班儿童）；PATCH 需教师身份（含停用 is_active） */
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
    return NextResponse.json({ class: found, children: await getClassChildren(id) });
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
