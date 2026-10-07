"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="mx-auto my-12 max-w-xl space-y-5" role="alert">
    <h1 className="text-2xl font-semibold text-[#15264d]">资料暂时不可读</h1>
    <p className="leading-7 text-slate-600">请确认已登录园所账号并具有该班级的访问权限；身份或资料读取失败不代表没有记录。</p>
    <div className="flex flex-wrap gap-3"><Button className="min-h-11" onClick={reset}>重新读取</Button>
      <Button asChild variant="outline" className="min-h-11"><Link href="/">返回首页</Link></Button>
      <Button asChild variant="outline" className="min-h-11"><Link href="/login">园所账号登录</Link></Button></div>
  </section>;
}
