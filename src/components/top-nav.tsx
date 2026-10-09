"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { BookOpenCheck, ClipboardList, FileBarChart2, GraduationCap, Home, LogOut, MessageSquare, MoreHorizontal, Sprout, UserRound, Users } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTeacher } from "./teacher-provider";
import styles from "./home-v2/homepage.module.css";

const NAV = [
  { href: "/", label: "首页", icon: Home }, { href: "/classes", label: "班级", icon: Users },
  { href: "/children", label: "成长档案", icon: GraduationCap }, { href: "/observations", label: "观察记录", icon: ClipboardList },
];
export function TopNav({ assistantEntry }: { assistantEntry?: ReactNode }) {
  const pathname = usePathname();
  const { principal, auth, logout, loading } = useTeacher();
  const hasClassScope = principal?.role === "admin" ||
    (principal?.scope.kind === "classes" && principal.scope.class_ids.length > 0);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <header className={styles["nav-header"]}><div className={styles["nav-inner"]}>
      <Link href="/" aria-label="芽芽观察首页" className={`${styles.brand} shrink-0`}>
        <Sprout size={37} strokeWidth={2.6} aria-hidden="true" /><span>芽芽观察</span>
      </Link>
      {principal ? <>
        <nav className={styles.navigation} aria-label="产品导航">
          {NAV.filter(({ href }) => hasClassScope || href === "/").map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={active(href) ? "page" : undefined}
            className={`${styles["nav-link"]} ${active(href) ? styles["nav-active"] : ""}`}><Icon size={20} aria-hidden="true" /><span>{label}</span></Link>)}
          {hasClassScope ? <DropdownMenu><DropdownMenuTrigger className={styles["nav-link"]} aria-label="更多功能"><MoreHorizontal size={22} aria-hidden="true" /><span>更多</span></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild><Link href="/activities"><BookOpenCheck size={16} />活动支持</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link href="/reports"><FileBarChart2 size={16} />成长回顾</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link href="/family-communication"><MessageSquare size={16} />家园沟通</Link></DropdownMenuItem>
              {principal.role === "admin" ? <DropdownMenuItem asChild><Link href="/admin/teachers"><Users size={16} />管理教师</Link></DropdownMenuItem> : null}
            </DropdownMenuContent></DropdownMenu> : null}
        </nav>
      </> : null}
      <div data-yaya-nav-actions className="ml-auto flex min-w-0 items-center gap-3 max-[1090px]:flex-1 max-[1090px]:justify-end max-[767px]:gap-1">
        {principal ? <div className={`${styles["account-menu"]} min-w-0`}><UserRound size={20} aria-hidden="true" />
          <span className={`${styles["account-name"]} min-w-0`} title={principal.display_name}>{principal.display_name}</span>
          <span className={`${styles["role-badge"]} shrink-0`}>{principal.role === "admin" ? "管理员" : "教师"}</span>
          <button aria-label="退出账号" className={`${styles.logout} shrink-0`} disabled={loading} onClick={() => { void logout().catch(() => toast.error("退出未完成，请重试。")); }}><LogOut size={16} aria-hidden="true" /><span>退出</span></button>
        </div> : auth.state.kind !== "unavailable" ? <Link href={pathname === "/" ? "#school-login" : "/login"} className={styles["guest-login"]}><UserRound size={20} aria-hidden="true" />园所账号登录</Link> : null}
        {assistantEntry}
      </div>
    </div></header>
  );
}
