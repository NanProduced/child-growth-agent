import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertCircle,
  Baby,
  ClipboardList,
  Info,
  PenLine,
  UserCheck,
  UserPlus,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
  const observationsByChild = new Map<string, Observation[]>();
  for (const observation of observations) {
    const childObservations = observationsByChild.get(observation.child_id) ?? [];
    childObservations.push(observation);
    observationsByChild.set(observation.child_id, childObservations);
  }
  const totalObs = observations.length;
  const pendingDraft = observations.filter((o) => o.status === 'draft').length;
  const pendingInput = observations.filter((o) => o.status === 'needs_input').length;
  const pendingConfirm = observations.filter((o) => o.status === 'ai_organized').length;
  const pendingReview = pendingDraft + pendingInput + pendingConfirm;
  const confirmedObservations = observations.filter(
    (o) => o.status === 'confirmed' && o.confirmed_content,
  );
  const confirmedChildren = new Set(confirmedObservations.map((o) => o.child_id));
  const recent = observations.slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-gradient-to-br from-amber-100/80 via-orange-50 to-white p-6 sm:p-8">
        <h1 className="text-xl font-bold sm:text-2xl">班级观察工作台</h1>
        <p className="mt-2 text-sm text-slate-600">
          从班级整体概览进入每个幼儿的观察档案。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/observations/new">
              <PenLine className="size-4" />
              录入观察
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/children/new">
              <UserPlus className="size-4" />
              建立幼儿档案
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/observations?status=ai_organized">
              <UserCheck className="size-4" />
              待我确认（{pendingConfirm}）
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/observations?status=needs_input">
              <ClipboardList className="size-4" />
              待补充信息（{pendingInput}）
            </Link>
          </Button>
        </div>
      </section>

      {dbError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                已确认 {confirmedObservations.length} 条
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <UserCheck className="size-4" /> 待教师处理
                </CardDescription>
                <CardTitle className="text-2xl">{pendingReview}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-slate-500">
                <span>待判断 {pendingDraft} · 待补充 {pendingInput} · 待确认 {pendingConfirm}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <Baby className="size-4" /> 已确认覆盖
                </CardDescription>
                <CardTitle className="text-2xl">
                  {confirmedChildren.size}
                  <span className="ml-1 text-sm font-normal text-slate-500">
                    / {children.length} 名
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-slate-500">
                有教师确认观察的幼儿
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
              <h2 className="text-base font-semibold">班级幼儿</h2>
              <Link href="/children" className="text-sm text-amber-700 hover:underline">
                全部档案 →
              </Link>
            </div>
            {children.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-slate-500">
                  暂无幼儿档案，
                  <Link href="/children/new" className="text-amber-700 hover:underline">
                    建立幼儿档案
                  </Link>
                  后开始班级观察。
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {children.map((child) => {
                  const childObservations = observationsByChild.get(child.id) ?? [];
                  const latest = childObservations[0];
                  const pendingCount = childObservations.filter(
                    (observation) => observation.status !== 'confirmed',
                  ).length;
                  let warmLabel = '正在了解';
                  if (childObservations.length > 0) {
                    warmLabel = childObservations.some(
                      (observation) => observation.status === 'confirmed',
                    )
                      ? '已有观察'
                      : '值得继续观察';
                  }

                  return (
                    <Link key={child.id} href={`/children/${child.id}`}>
                      <Card className="h-full transition-shadow hover:shadow-md">
                        <CardContent className="space-y-3 p-4">
                          <div className="flex items-start gap-3">
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-100 text-2xl">
                              {child.avatar_emoji ?? '🧒'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                                <span>{child.name}</span>
                                {child.is_demo ? <DemoBadge /> : null}
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {child.class_name} · {ageText(child.birth_date)}
                              </div>
                            </div>
                            <Badge variant="outline" className="shrink-0 text-xs font-normal">
                              {warmLabel}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span>最近观察：</span>
                            {latest ? (
                              <>
                                <span>{formatDateCn(latest.observed_at)}</span>
                                <StatusBadge status={latest.status} />
                              </>
                            ) : (
                              <span>暂无记录</span>
                            )}
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-500">观察 {childObservations.length} 条</span>
                            {pendingCount > 0 ? (
                              <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                                待处理 {pendingCount} 条
                              </Badge>
                            ) : (
                              <span className="text-slate-400">暂无待确认</span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <Alert>
            <Info className="size-4" />
            <AlertTitle>演示数据说明</AlertTitle>
            <AlertDescription>
              页面中的合成数据已标注“合成数据”，不涉及真实幼儿信息。
            </AlertDescription>
          </Alert>
        </>
      )}
    </div>
  );
}
