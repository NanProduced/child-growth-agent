import { NextResponse } from "next/server";
import { TEACHER_COOKIE } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json({ ok: true, isTeacher: false });
  response.cookies.set(TEACHER_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
