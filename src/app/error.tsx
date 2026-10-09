"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="mx-auto my-12 max-w-xl space-y-5" role="alert">
    <h1 className="text-2xl font-semibold text-[#15264d]">资料暂时无法查看</h1>
    <p className="leading-7 text-slate-600">请重试。若仍无法查看，可联系园所管理员确认账号权限。</p>
    <div className="flex flex-wrap gap-3"><Button className="min-h-11" onClick={reset}>重新读取</Button>
      <Button asChild variant="outline" className="min-h-11"><Link href="/">返回首页</Link></Button>
      <Button asChild variant="outline" className="min-h-11"><Link href="/login">园所账号登录</Link></Button></div>
  </section>;
}
