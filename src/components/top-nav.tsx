"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  Baby,
  BookOpenCheck,
  ClipboardList,
  FileBarChart2,
  GraduationCap,
  Home,
  Loader2,
  LogIn,
  LogOut,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTeacher } from "@/components/teacher-provider";

const NAV = [
  { href: "/", label: "工作台", icon: Home },
  { href: "/children", label: "幼儿档案", icon: Baby },
  { href: "/observations", label: "观察记录", icon: ClipboardList },
  { href: "/activities", label: "活动计划", icon: BookOpenCheck },
  { href: "/reports", label: "报告中心", icon: FileBarChart2 },
];

export function TopNav() {
  const pathname = usePathname();
  const { loading, configured, isTeacher, login, logout } = useTeacher();
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  async function handleLogin() {
    if (!passcode.trim()) {
      toast.error("请输入通行口令");
      return;
    }
    setBusy(true);
    const result = await login(passcode.trim());
    setBusy(false);
    if (result.ok) {
      toast.success("已进入教师模式");
      setOpen(false);
      setPasscode("");
    } else {
      toast.error(result.message ?? "登录失败");
    }
  }

  async function handleLogout() {
    await logout();
    toast.success("已退出教师模式");
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-1 px-4 sm:gap-2">
        <Link href="/" className="mr-2 flex shrink-0 items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
            <GraduationCap className="size-5" />
          </span>
          <span className="hidden text-sm font-semibold sm:inline">幼儿成长观察</span>
        </Link>

        <nav className="min-w-0 flex flex-1 items-center gap-0 overflow-hidden sm:gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-1 py-1.5 text-sm transition-colors sm:px-2.5 ${
                isActive(item.href)
                  ? "bg-amber-100 font-medium text-amber-800"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <item.icon className="size-4" />
              <span className="hidden xs:inline sm:inline">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="shrink-0">
          {loading ? (
            <Loader2 className="size-4 animate-spin text-slate-400" />
          ) : isTeacher ? (
            <div className="flex items-center gap-2">
              <Badge className="bg-emerald-100 text-emerald-700" variant="secondary">
                教师模式
              </Badge>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                <LogOut className="size-4" />
                <span className="hidden sm:inline">退出</span>
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant={configured ? "outline" : "ghost"}
              disabled={!configured}
              title={configured ? undefined : "未配置教师口令（TEACHER_PASSCODE）"}
              onClick={() => setOpen(true)}
            >
              <LogIn className="size-4" />
              教师登录
            </Button>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>教师登录</DialogTitle>
            <DialogDescription>
              录入观察、AI 整理与确认归档需要教师身份。口令由园所在服务端环境变量
              TEACHER_PASSCODE 中配置，不公开注册。
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            placeholder="教师通行口令"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleLogin();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button onClick={() => void handleLogin()} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              进入教师模式
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
