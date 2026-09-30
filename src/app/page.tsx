import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Baby,
  Building2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  ListTodo,
  PenLine,
  Sprout,
  Users,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AiBadge, StatusBadge } from '@/components/status-badges';
import { classLabel, excerpt, formatDateCn, schoolClassLabel } from '@/lib/format';
import { listChildren, listClasses, listObservations } from '@/lib/queries';
import type { Child, Observation, SchoolClass } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '工作台',
};

type ClassOverview = {
  klass: SchoolClass;
  childCount: number;
  pendingCount: number;
  latestObservation: Observation | null;
};

const stageOrder = { small: 0, middle: 1, large: 2 } as const;

function classTone(stage: SchoolClass['stage']): string {
  if (stage === 'small') return 'border-rose-200 bg-rose-50/70';
  if (stage === 'large') return 'border-sky-200 bg-sky-50/70';
  return 'border-amber-200 bg-amber-50/70';
}

function classIcon(stage: SchoolClass['stage']) {
  if (stage === 'small') return '🌈';
  if (stage === 'large') return '🌼';
  return '🌻';
}

function pendingRank(observation: Observation): number {
  if (observation.status === 'ai_organized') return 0;
  if (observation.status === 'needs_input') return 1;
  return 2;
}

function getPrimaryAction(
  classes: SchoolClass[],
  children: Child[],
  observations: Observation[],
): { label: string; href: string; helper: string } {
  const pendingConfirmation = observations.some((observation) => observation.status === 'ai_organized');
  const pendingInput = observations.some((observation) => observation.status === 'needs_input');

  if (pendingConfirmation) {
    return {
      label: '去处理待确认',
      href: '/observations?status=ai_organized',
      helper: '有一条观察已经整理好，等你核对后进入成长档案。',
    };
  }
  if (pendingInput) {
    return {
      label: '补充一条观察',
      href: '/observations?status=needs_input',
      helper: '有一条观察需要一点必要信息，补充后再继续整理。',
    };
  }
  if (classes.length === 0) {
    return {
      label: '建立第一个班级',
      href: '/classes',
      helper: '先建立小班、中班或大班，之后再为班级建立成长档案。',
    };
  }
  if (children.length === 0) {
    return {
      label: '建立第一个成长档案',
      href: '/children/new',
      helper: '为一个小朋友建立档案，再从一条真实观察开始。',
    };
  }
  return {
    label: '开始记录',
    href: '/observations/new',
    helper: '记录看到的具体行为和语言，AI 会在必要时帮你补充整理。',
  };
}

function ClassOverviewCard({ overview }: { overview: ClassOverview }) {
  const { klass, childCount, pendingCount, latestObservation } = overview;
  return (
    <Link
      href={`/classes/${klass.id}`}
      className={`group block min-w-0 overflow-hidden rounded-2xl border transition-transform hover:-translate-y-0.5 hover:shadow-sm ${classTone(klass.stage)}`}
    >
      <div className="flex items-start justify-between gap-3 p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xl" aria-hidden="true">
              {classIcon(klass.stage)}
            </span>
            <h3 className="truncate text-base font-semibold text-slate-900">
              {classLabel(klass.stage, klass.name)}
            </h3>
          </div>
          <p className="mt-1 pl-7 text-xs text-slate-500">{klass.school_year}</p>
        </div>
        <ChevronRight className="mt-1 size-5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5" />
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-white/70 bg-white/60 px-4 py-3 text-xs sm:px-5">
        <div>
          <div className="flex items-center gap-1 text-slate-500">
            <Users className="size-3.5" aria-hidden="true" />
            成长档案
          </div>
          <p className="mt-1 text-base font-semibold text-slate-800">{childCount}</p>
        </div>
        <div>
          <div className="flex items-center gap-1 text-slate-500">
            <ClipboardCheck className="size-3.5" aria-hidden="true" />
            待处理
          </div>
          <p className="mt-1 text-base font-semibold text-amber-700">{pendingCount}</p>
        </div>
        <div>
          <div className="flex items-center gap-1 text-slate-500">
            <Clock3 className="size-3.5" aria-hidden="true" />
            最近观察
          </div>
          <p className="mt-1 truncate text-xs font-medium text-slate-700">
            {latestObservation ? formatDateCn(latestObservation.observed_at) : '暂无'}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between bg-white/40 px-4 py-2.5 text-xs font-medium text-slate-600 sm:px-5">
        <span>查看班级</span>
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </div>
    </Link>
  );
}

export default async function DashboardPage() {
  let children: Child[] = [];
  let observations: Observation[] = [];
  let classes: SchoolClass[] = [];
  let dbError: string | null = null;

  try {
    [children, observations, classes] = await Promise.all([
      listChildren(),
      listObservations({ limit: 1000 }),
      listClasses(),
    ]);
  } catch (error) {
    dbError = error instanceof Error ? error.message : '数据库连接失败';
  }

  const activeClasses = classes
    .filter((klass) => klass.is_active)
    .sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || a.name.localeCompare(b.name, 'zh-CN'));
  const childrenById = new Map(children.map((child) => [child.id, child]));
  const classOverview = activeClasses.map((klass) => {
    const classChildren = children.filter((child) => child.class_id === klass.id);
    const classObservations = observations.filter((observation) => observation.class_id === klass.id);
    return {
      klass,
      childCount: classChildren.length,
      pendingCount: classObservations.filter((observation) => observation.status !== 'confirmed').length,
      latestObservation: classObservations[0] ?? null,
    } satisfies ClassOverview;
  });

  const pending = observations
    .filter((observation) => observation.status !== 'confirmed')
    .sort((a, b) => pendingRank(a) - pendingRank(b) || b.created_at.localeCompare(a.created_at))
    .slice(0, 3);
  const recent = observations.slice(0, 3);
  const primaryAction = getPrimaryAction(classes, children, observations);

  return (
    <div className="space-y-8 pb-4 sm:space-y-10">
      <section className="relative isolate min-h-0 overflow-hidden rounded-[28px] border border-amber-200/80 bg-[#fff4d9] px-6 py-8 sm:min-h-[300px] sm:px-10 sm:py-10">
        <div className="relative z-10 max-w-xl">
          <p className="text-sm font-medium text-emerald-800">芽芽观察 · 演示园所</p>
          <h1 className="mt-3 max-w-lg text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            今天，先看见一件小事
          </h1>
          <p className="mt-3 max-w-md text-sm leading-7 text-slate-600 sm:text-base">
            从全园的观察动态开始，找到下一件值得记录或确认的事。
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="shadow-sm">
              <Link href={primaryAction.href}>
                <PenLine className="size-4" />
                {primaryAction.label}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            {classes.length === 0 ? (
              <Link
                href="/classes"
                className="text-sm font-medium text-sky-700 underline-offset-4 hover:underline"
              >
                先建立第一个班级
              </Link>
            ) : (
              <Link
                href="/children"
                className="text-sm font-medium text-sky-700 underline-offset-4 hover:underline"
              >
                查看成长档案
              </Link>
            )}
          </div>
          <p className="mt-4 max-w-md text-xs leading-5 text-slate-500">{primaryAction.helper}</p>
        </div>
        <Image
          src="/assets/illustrations/homepage-classroom.png"
          alt=""
          width={960}
          height={540}
          priority
          sizes="(max-width: 640px) 90vw, 58vw"
          className="pointer-events-none absolute -bottom-3 -right-24 z-0 hidden w-[600px] max-w-none object-contain sm:-right-20 sm:block sm:w-[700px] lg:-right-10 lg:w-[760px]"
        />
        <span className="pointer-events-none absolute -right-10 top-8 -z-0 size-28 rounded-full bg-white/35 blur-2xl" aria-hidden="true" />
      </section>

      {dbError ? (
        <Alert variant="destructive">
          <CircleAlert className="size-4" />
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section aria-labelledby="kindergarten-overview-title" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Building2 className="size-5 text-emerald-700" aria-hidden="true" />
                  <h2 id="kindergarten-overview-title" className="text-xl font-semibold text-slate-900">
                    园所概览
                  </h2>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  {activeClasses.length > 0
                    ? `当前有 ${activeClasses.length} 个班级、${children.length} 个成长档案`
                    : '先建立班级，再从一条观察开始积累。'}
                </p>
              </div>
              <Link
                href="/classes"
                className="flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
              >
                管理班级
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>

            {classOverview.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-3">
                {classOverview.map((overview) => (
                  <ClassOverviewCard key={overview.klass.id} overview={overview} />
                ))}
              </div>
            ) : (
              <Card className="border-dashed border-emerald-200 bg-emerald-50/30">
                <CardContent className="flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <Sprout className="mt-0.5 size-6 shrink-0 text-emerald-600" aria-hidden="true" />
                    <div>
                      <h3 className="font-medium text-slate-800">还没有班级</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        建立一个小班、中班或大班，首页会从全园视角呈现观察动态。
                      </p>
                    </div>
                  </div>
                  <Button asChild variant="outline">
                    <Link href="/classes">建立第一个班级</Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </section>

          <section className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <section aria-labelledby="pending-title" className="min-w-0">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <h2 id="pending-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <ListTodo className="size-5 text-rose-500" aria-hidden="true" />
                    待处理观察
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">先处理需要教师判断的内容</p>
                </div>
                <Link href="/observations" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
                  查看全部
                  <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden="true" />
                </Link>
              </div>
              {pending.length > 0 ? (
                <Card className="overflow-hidden border-rose-100 bg-rose-50/35">
                  <CardContent className="divide-y divide-rose-100/80 p-0">
                    {pending.map((observation) => {
                      const child = childrenById.get(observation.child_id);
                      return (
                        <Link
                          key={observation.id}
                          href={`/observations/${observation.id}/review`}
                          className="group flex items-center gap-3 p-4 transition-colors hover:bg-white/70 sm:gap-4"
                        >
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-xl shadow-sm" aria-hidden="true">
                            {child?.avatar_emoji ?? '🧒'}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
                              <span>{child?.name ?? '未知幼儿'}</span>
                              {observation.observed_class ? (
                                <span className="text-xs font-normal text-slate-500">
                                  {schoolClassLabel(observation.observed_class)}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-1 block truncate text-sm text-slate-600">
                              {excerpt(observation.raw_text, 82)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <StatusBadge status={observation.status} />
                            <ChevronRight className="size-4 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                          </span>
                        </Link>
                      );
                    })}
                  </CardContent>
                </Card>
              ) : (
                <Card className="border-dashed">
                  <CardContent className="flex items-start gap-3 p-6">
                    <ClipboardCheck className="mt-0.5 size-5 text-emerald-600" aria-hidden="true" />
                    <div>
                      <h3 className="font-medium text-slate-800">暂时没有待处理观察</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-500">新的记录会在这里提醒你核对和确认。</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </section>

            <section aria-labelledby="recent-title" className="min-w-0">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <h2 id="recent-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <Sprout className="size-5 text-emerald-600" aria-hidden="true" />
                    最近观察
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">从全园动态回到真实发生的片段</p>
                </div>
                <Link href="/observations" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
                  查看全部
                  <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden="true" />
                </Link>
              </div>
              {recent.length > 0 ? (
                <Card>
                  <CardContent className="relative space-y-0 p-4 sm:p-5">
                    <div className="absolute bottom-6 left-[29px] top-6 border-l border-emerald-200" aria-hidden="true" />
                    {recent.map((observation) => {
                      const child = childrenById.get(observation.child_id);
                      return (
                        <Link
                          key={observation.id}
                          href={`/observations/${observation.id}/review`}
                          className="group relative flex gap-3 rounded-xl p-2 transition-colors hover:bg-emerald-50/50 sm:gap-4"
                        >
                          <span className="relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm" aria-hidden="true">
                            {child?.avatar_emoji ?? '🧒'}
                          </span>
                          <span className="min-w-0 flex-1 pb-3">
                            <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span>{formatDateCn(observation.observed_at)}</span>
                              {observation.observed_class ? <span>{schoolClassLabel(observation.observed_class)}</span> : null}
                            </span>
                            <span className="mt-1 block text-sm font-medium text-slate-800">
                              {child?.name ?? '未知幼儿'}
                              {observation.context ? ` · ${observation.context}` : ''}
                            </span>
                            <span className="mt-1 block line-clamp-2 text-sm leading-6 text-slate-600">
                              {excerpt(observation.raw_text, 100)}
                            </span>
                            <span className="mt-2 flex flex-wrap items-center gap-2">
                              {observation.ai_draft ? <AiBadge /> : null}
                              <StatusBadge status={observation.status} />
                            </span>
                          </span>
                          <ChevronRight className="mt-1 size-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                        </Link>
                      );
                    })}
                  </CardContent>
                </Card>
              ) : (
                <Card className="border-dashed">
                  <CardContent className="flex items-start gap-3 p-6">
                    <Baby className="mt-0.5 size-5 text-emerald-600" aria-hidden="true" />
                    <div>
                      <h3 className="font-medium text-slate-800">还没有观察记录</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-500">从一次具体行为开始，全园的成长片段会在这里汇合。</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </section>
          </section>

        </>
      )}
    </div>
  );
}
