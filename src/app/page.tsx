import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowUpRight,
  Baby,
  ClipboardList,
  Info,
  PenLine,
  Sprout,
  UserCheck,
  UserPlus,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  const childrenById = new Map(children.map((child) => [child.id, child]));
  const observationsByChild = new Map<string, Observation[]>();
  for (const observation of observations) {
    const childObservations = observationsByChild.get(observation.child_id) ?? [];
    childObservations.push(observation);
    observationsByChild.set(observation.child_id, childObservations);
  }

  const pendingDraft = observations.filter((observation) => observation.status === 'draft').length;
  const pendingInput = observations.filter((observation) => observation.status === 'needs_input').length;
  const pendingConfirm = observations.filter((observation) => observation.status === 'ai_organized').length;
  const recent = observations.slice(0, 4);

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-3xl border border-amber-200/80 bg-gradient-to-br from-amber-100/80 via-orange-50 to-white p-6 sm:p-8">
        <div className="relative z-10 max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            从一条观察开始
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600 sm:text-base">
            记录看到的具体行为和语言，之后再沿着证据回看每个小朋友的变化。
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button asChild size="lg">
              <Link href="/observations/new">
                <PenLine className="size-4" />
                开始记录
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/children/new">
                <UserPlus className="size-4" />
                建立成长档案
              </Link>
            </Button>
          </div>
        </div>
        <Sprout
          className="absolute -right-4 -bottom-5 size-36 rotate-12 text-emerald-200/70 sm:right-8 sm:bottom-2"
          strokeWidth={1}
          aria-hidden="true"
        />
      </section>

      {dbError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.75fr)]">
            <section aria-labelledby="recent-observations-title" className="min-w-0">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <h2 id="recent-observations-title" className="text-lg font-semibold text-slate-900">
                    最近观察
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">沿着时间线回到真实发生的片段</p>
                </div>
                <Link
                  href="/observations"
                  className="flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-800"
                >
                  全部记录
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
              {recent.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-start gap-3 p-6">
                    <ClipboardList className="size-6 text-amber-600" aria-hidden="true" />
                    <div>
                      <h3 className="font-medium text-slate-800">还没有观察记录</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-500">
                        从一次具体行为开始，记录会在这里形成可回看的时间线。
                      </p>
                    </div>
                    <Button asChild size="sm">
                      <Link href="/observations/new">开始记录</Link>
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="relative space-y-3 border-l border-amber-200 pl-5 sm:pl-6">
                  {recent.map((observation) => {
                    const child = childrenById.get(observation.child_id);
                    return (
                      <Link
                        key={observation.id}
                        href={`/observations/${observation.id}/review`}
                        className="group relative block rounded-xl border border-transparent bg-white p-4 transition-colors hover:border-amber-200 hover:bg-amber-50/40"
                      >
                        <span
                          className="absolute -left-[25px] top-5 size-2.5 rounded-full bg-amber-400 ring-4 ring-amber-50 transition-colors group-hover:bg-emerald-500 sm:-left-[29px]"
                          aria-hidden="true"
                        />
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-lg" aria-hidden="true">
                            {child?.avatar_emoji ?? '🧒'}
                          </span>
                          <span className="font-medium text-slate-800">{child?.name ?? '未知幼儿'}</span>
                          <span className="text-xs text-slate-500">
                            {formatDateCn(observation.observed_at)}
                            {observation.context ? ` · ${observation.context}` : ''}
                          </span>
                          {child?.is_demo ? <DemoBadge /> : null}
                          <span className="ml-auto flex items-center gap-2">
                            {observation.ai_draft ? <AiBadge /> : null}
                            <StatusBadge status={observation.status} />
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                          {excerpt(observation.raw_text, 120)}
                        </p>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <Card className="h-fit border-emerald-200/80 bg-emerald-50/45">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <UserCheck className="size-4 text-emerald-700" aria-hidden="true" />
                  接下来
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Link
                  href="/observations?status=ai_organized"
                  className="flex items-center justify-between gap-3 rounded-lg bg-white/80 p-3 text-sm transition-colors hover:bg-white"
                >
                  <span className="flex items-center gap-2 text-slate-700">
                    <span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
                    待教师确认
                  </span>
                  <Badge variant="outline" className="font-normal">{pendingConfirm}</Badge>
                </Link>
                <Link
                  href="/observations?status=needs_input"
                  className="flex items-center justify-between gap-3 rounded-lg bg-white/80 p-3 text-sm transition-colors hover:bg-white"
                >
                  <span className="flex items-center gap-2 text-slate-700">
                    <span className="size-2 rounded-full bg-sky-400" aria-hidden="true" />
                    待补充信息
                  </span>
                  <Badge variant="outline" className="font-normal">{pendingInput}</Badge>
                </Link>
                {pendingDraft > 0 ? (
                  <Link
                    href="/observations?status=draft"
                    className="flex items-center justify-between gap-3 rounded-lg bg-white/80 p-3 text-sm transition-colors hover:bg-white"
                  >
                    <span className="flex items-center gap-2 text-slate-700">
                      <span className="size-2 rounded-full bg-slate-400" aria-hidden="true" />
                      待判断
                    </span>
                    <Badge variant="outline" className="font-normal">{pendingDraft}</Badge>
                  </Link>
                ) : null}
                <div className="border-t border-emerald-200/70 pt-3">
                  <Link
                    href="/children"
                    className="flex items-center justify-between text-sm font-medium text-emerald-800 hover:text-emerald-900"
                  >
                    查看成长档案
                    <ArrowUpRight className="size-4" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="children-title">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <h2 id="children-title" className="text-lg font-semibold text-slate-900">成长档案</h2>
                <p className="mt-1 text-sm text-slate-500">从一个小朋友的最近变化继续阅读</p>
              </div>
              <Link
                href="/children"
                className="flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-800"
              >
                查看全部
                <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
            {children.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-start gap-3 p-6">
                  <Sprout className="size-6 text-emerald-600" aria-hidden="true" />
                  <div>
                    <h3 className="font-medium text-slate-800">还没有成长档案</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-500">
                      先建立一个成长档案，再从一条观察开始积累。
                    </p>
                  </div>
                  <Button asChild size="sm">
                    <Link href="/children/new">建立成长档案</Link>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {children.map((child) => {
                  const childObservations = observationsByChild.get(child.id) ?? [];
                  const latest = childObservations[0];
                  const latestConfirmed = childObservations.find(
                    (observation) => observation.status === 'confirmed' && observation.confirmed_content,
                  );
                  const pendingCount = childObservations.filter(
                    (observation) => observation.status !== 'confirmed',
                  ).length;
                  const recentChange = child.growth_profile?.recent_change ??
                    latestConfirmed?.confirmed_content?.objective_description;

                  return (
                    <Link
                      key={child.id}
                      href={`/children/${child.id}`}
                      className="group min-w-0 rounded-xl border bg-white p-4 transition-colors hover:border-amber-300 hover:bg-amber-50/30"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-100 text-2xl" aria-hidden="true">
                          {child.avatar_emoji ?? '🧒'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-800">
                            <span>{child.name}</span>
                            {child.is_demo ? <DemoBadge /> : null}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {child.class_name} · {ageText(child.birth_date)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                        <div className="flex items-center justify-between gap-2">
                          <span>最近观察</span>
                          <span>{latest ? formatDateCn(latest.observed_at) : '暂无记录'}</span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                          {recentChange ?? '确认一条观察后，这里会出现最近变化。'}
                        </p>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <span className="text-emerald-700">
                            {child.growth_profile ? '成长小结已更新' : latestConfirmed ? '已有确认观察' : '等待第一条观察'}
                          </span>
                          {pendingCount > 0 ? (
                            <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                              待处理 {pendingCount}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <Alert className="bg-white/70">
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
