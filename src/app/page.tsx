import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertCircle,
  Baby,
  ClipboardList,
  Info,
  PenLine,
  Sparkles,
  UserCheck,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AiBadge, DemoBadge, StatusBadge } from '@/components/status-badges';
import { ageText, excerpt, formatDateCn } from '@/lib/format';
import { listChildren, listObservations } from '@/lib/queries';
import type { Child, Observation } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '工作台',
};

export default async function DashboardPage() {
  let children: Child[] = [];
  let observations: Observation[] = [];
  let dbError: string | null = null;
  try {
    [children, observations] = await Promise.all([
      listChildren(),
      listObservations({ limit: 1000 }),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  const childrenById = new Map(children.map((c) => [c.id, c]));
  const totalObs = observations.length;
  const pendingConfirm = observations.filter((o) => o.status === 'ai_organized').length;
  const confirmed = observations.filter((o) => o.status === 'confirmed').length;
  const recent = observations.slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-gradient-to-br from-amber-100/80 via-orange-50 to-white p-6 sm:p-8">
        <h1 className="text-xl font-bold sm:text-2xl">幼儿成长观察与活动支持智能体</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          面向幼儿园教师的观察记录助手：录入观察原文，AI 依据《3-6
          岁儿童学习与发展指南》整理为结构化分析卡片，教师核对确认后归档。AI
          产出仅作草稿，一切以教师确认为准。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/observations/new">
              <PenLine className="size-4" />
              录入观察
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/observations?status=ai_organized">
              <UserCheck className="size-4" />
              待我确认（{pendingConfirm}）
            </Link>
          </Button>
        </div>
      </section>

      <Alert>
        <Info className="size-4" />
        <AlertTitle>演示数据说明</AlertTitle>
        <AlertDescription>
          内置 6 名幼儿与 3 条观察记录均为<b>合成数据</b>（已标注“合成数据”），不涉及任何真实幼儿信息。
          第一阶段已打通：观察录入 → 保存原文 → 真实 AI 整理 → 教师确认 → 刷新后仍可查看。
          阶段回顾与活动建议将在下一阶段上线。
        </AlertDescription>
      </Alert>

      {dbError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section className="grid grid-cols-3 gap-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <Baby className="size-4" /> 在册幼儿
                </CardDescription>
                <CardTitle className="text-2xl">{children.length}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-slate-500">
                <Link href="/children" className="hover:underline">
                  查看幼儿档案 →
                </Link>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <ClipboardList className="size-4" /> 观察记录
                </CardDescription>
                <CardTitle className="text-2xl">{totalObs}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-slate-500">
                已确认 {confirmed} 条 · 待确认 {pendingConfirm} 条
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <Sparkles className="size-4" /> AI 整理
                </CardDescription>
                <CardTitle className="text-2xl">
                  {observations.filter((o) => o.ai_draft).length}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-slate-500">
                AI 产出均为草稿，教师确认后进入正册
              </CardContent>
            </Card>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">最近观察</h2>
              <Link
                href="/observations"
                className="text-sm text-amber-700 hover:underline"
              >
                全部记录 →
              </Link>
            </div>
            {recent.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-slate-500">
                  还没有观察记录，点击「录入观察」开始第一份记录。
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {recent.map((obs) => {
                  const child = childrenById.get(obs.child_id);
                  return (
                    <Link key={obs.id} href={`/observations/${obs.id}/review`} className="block">
                      <Card className="transition-shadow hover:shadow-md">
                        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
                          <span className="text-lg">{child?.avatar_emoji ?? '🧒'}</span>
                          <span className="font-medium">{child?.name ?? '未知幼儿'}</span>
                          <span className="text-xs text-slate-500">
                            {formatDateCn(obs.observed_at)}
                            {obs.context ? ` · ${obs.context}` : ''}
                          </span>
                          {child?.is_demo ? <DemoBadge /> : null}
                          <span className="ml-auto flex items-center gap-2">
                            {obs.ai_draft ? <AiBadge /> : null}
                            <StatusBadge status={obs.status} />
                          </span>
                          <p className="w-full truncate text-sm text-slate-600">
                            {excerpt(obs.raw_text, 80)}
                          </p>
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">幼儿速览</h2>
              <Link href="/children" className="text-sm text-amber-700 hover:underline">
                全部档案 →
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {children.slice(0, 6).map((child) => (
                <Link key={child.id} href={`/children/${child.id}`}>
                  <Card className="transition-shadow hover:shadow-md">
                    <CardContent className="flex items-center gap-3 py-3">
                      <span className="text-2xl">{child.avatar_emoji ?? '🧒'}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          {child.name}
                          {child.is_demo ? <DemoBadge /> : null}
                        </div>
                        <div className="text-xs text-slate-500">
                          {child.class_name} · {ageText(child.birth_date)}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
