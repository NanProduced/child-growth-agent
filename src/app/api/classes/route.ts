import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { createClass, findClassByName, listClasses } from "@/lib/queries";
import { createClassSchema } from "@/lib/validation";

/**
 * 班级：
 * - GET 对访客开放（只读），返回全部班级（含已停用，用 is_active 区分）；
 * - POST 需教师身份：新建小班 / 中班 / 大班班级，同学年内不允许重名。
 */
export async function GET() {
  try {
    return NextResponse.json({ classes: await listClasses() });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询班级失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const body = await request.json().catch(() => null);
  const parsed = createClassSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const existing = await findClassByName(parsed.data.name, parsed.data.school_year);
    if (existing) {
      return NextResponse.json(
        { message: `同学年下已存在同名班级「${parsed.data.name}」` },
        { status: 409 }
      );
    }
    const created = await createClass(parsed.data);
    return NextResponse.json({ class: created }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "创建班级失败" },
      { status: 500 }
    );
  }
}
