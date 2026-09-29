import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { createChild, listChildren } from "@/lib/queries";
import { createChildSchema } from "@/lib/validation";

/** 幼儿档案：读取对访客开放（只读），新增需教师身份（服务端校验） */
export async function GET() {
  try {
    return NextResponse.json({ children: await listChildren() });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询幼儿档案失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const body = await request.json().catch(() => null);
  const parsed = createChildSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const child = await createChild(parsed.data);
    return NextResponse.json({ child }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "新增幼儿失败" },
      { status: 500 }
    );
  }
}
