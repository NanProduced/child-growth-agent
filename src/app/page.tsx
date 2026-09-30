import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Baby,
  Building2,
  CircleAlert,
  ClipboardCheck,
  ListTodo,
  PenLine,
  Sprout,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badges';
import { classLabel, excerpt, formatDateCn } from '@/lib/format';
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

function classAccent(stage: SchoolClass['stage']): string {
  if (stage === 'small') return 'bg-rose-100 text-rose-600';
  if (stage === 'large') return 'bg-sky-100 text-sky-600';
  return 'bg-amber-100 text-amber-600';
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
      helper: '有一条整理好的观察，等你核对。',
    };
  }
  if (pendingInput) {
    return {
      label: '补充一条观察',
      href: '/observations?status=needs_input',
      helper: '有一条观察需要补充一点信息。',
    };
  }
  if (classes.length === 0) {
    return {
      label: '建立第一个班级',
      href: '/classes',
      helper: '先建立一个班级。',
    };
  }
  if (children.length === 0) {
    return {
      label: '建立第一个成长档案',
      href: '/children/new',
      helper: '先建立一份成长档案。',
    };
  }
  return {
    label: '开始记录',
    href: '/observations/new',
    helper: '记下看到的具体行为和语言。',
  };
}

function ClassOverviewCard({ overview }: { overview: ClassOverview }) {
  const { klass, childCount, pendingCount, latestObservation } = overview;
  return (
    <Link
      href={`/classes/${klass.id}`}
      className="group flex min-w-0 items-center gap-3 border-b border-slate-200/80 py-4 transition-colors hover:bg-white/60 sm:gap-4 sm:px-2"
    >
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${classAccent(klass.stage)}`} aria-hidden="true">
        <Sprout className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-semibold text-slate-900">{classLabel(klass.stage, klass.name)}</span>
        <span className="mt-1 block text-xs text-slate-500">{klass.school_year}</span>
      </span>
      <span className="hidden shrink-0 items-center gap-5 text-sm text-slate-500 sm:flex">
        <span><strong className="font-semibold text-slate-800">{childCount}</strong> 份成长档案</span>
        {pendingCount > 0 ? (
          <span className="text-amber-700"><strong className="font-semibold">{pendingCount}</strong> 条待处理</span>
        ) : null}
        {latestObservation ? <span>最近 {formatDateCn(latestObservation.observed_at)}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-emerald-700">
        <span className="sr-only">查看班级</span>
        <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
      </span>
      <span className="mt-1 flex shrink-0 flex-col items-end gap-1 text-right text-xs text-slate-500 sm:hidden">
        <span>{childCount} 份档案</span>
        {pendingCount > 0 ? <span className="text-amber-700">{pendingCount} 条待处理</span> : null}
      </span>
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
          <h1 className="max-w-lg text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            今天，先看见一件小事
          </h1>
          <p className="mt-3 max-w-md text-sm leading-7 text-slate-600 sm:text-base">从一条真实观察开始，慢慢看见成长。</p>
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
                    班级
                  </h2>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  {activeClasses.length > 0
                    ? `${activeClasses.length} 个班级 · ${children.length} 份成长档案`
                    : '先建立一个班级。'}
                </p>
              </div>
              <Link
                href="/classes"
                className="flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
              >
                查看班级
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>

            {classOverview.length > 0 ? (
              <div className="border-y border-slate-200/80">
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

          <section
            aria-labelledby="observation-path-title"
            className="relative space-y-7 border-t border-slate-200/80 pt-7 sm:space-y-8 sm:pt-9"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="observation-path-title" className="flex items-center gap-2 text-xl font-semibold text-slate-900">
                  <Sprout className="size-5 text-emerald-600" aria-hidden="true" />
                  观察记录
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">从一件小事，回到真实发生的现场。</p>
              </div>
              <Image
                src="/assets/illustrations/observation-notebook.png"
                alt=""
                width={160}
                height={160}
                sizes="160px"
                className="pointer-events-none -mr-1 -mt-5 hidden w-24 object-contain sm:block"
              />
            </div>

            <div className="space-y-8">
              <section aria-labelledby="pending-title">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                    <ListTodo className="size-4 text-rose-500" aria-hidden="true" />
                    需要你看一眼
                  </h3>
                </div>
                <Link href="/observations" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
                  去处理
                  <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden="true" />
                </Link>
              </div>
              {pending.length > 0 ? (
                <div className="max-w-4xl divide-y divide-rose-100/80 border-y border-rose-100/80 bg-rose-50/25">
                  {pending.map((observation) => {
                    const child = childrenById.get(observation.child_id);
                    return (
                      <Link
                        key={observation.id}
                        href={`/observations/${observation.id}/review`}
                        className="group flex min-w-0 items-center gap-3 px-3 py-3.5 transition-colors hover:bg-white/70 sm:px-4"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-lg" aria-hidden="true">
                          {child?.avatar_emoji ?? '🧒'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                            <span className="truncate">{child?.name ?? '未知幼儿'}</span>
                          </span>
                          <span className="mt-1 block truncate text-sm text-slate-600">{excerpt(observation.raw_text, 56)}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                            <StatusBadge status={observation.status} />
                          <ArrowUpRight className="size-4 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="flex max-w-4xl items-center gap-3 border-y border-dashed border-emerald-200 px-3 py-3.5 sm:px-4">
                  <ClipboardCheck className="size-5 shrink-0 text-emerald-600" aria-hidden="true" />
                  <p className="text-sm text-slate-600">暂时没有需要处理的观察。</p>
                </div>
              )}
              </section>

              <section aria-labelledby="recent-title" className="border-t border-slate-200/80 pt-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                    <Baby className="size-4 text-sky-600" aria-hidden="true" />
                    最近记录
                  </h3>
                </div>
                <Link href="/observations" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
                  全部记录
                  <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden="true" />
                </Link>
              </div>
              {recent.length > 0 ? (
                <div className="relative max-w-4xl border-l border-emerald-200 pl-5 sm:pl-6">
                  {recent.map((observation) => {
                    const child = childrenById.get(observation.child_id);
                    return (
                      <Link
                        key={observation.id}
                        href={`/observations/${observation.id}/review`}
                        className="group relative block min-w-0 rounded-xl px-3 py-3 transition-colors hover:bg-emerald-50/60 sm:px-4"
                      >
                        <span className="absolute -left-[30px] top-4 flex size-4 items-center justify-center rounded-full border-2 border-white bg-emerald-300" aria-hidden="true" />
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-base" aria-hidden="true">
                            {child?.avatar_emoji ?? '🧒'}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                              <strong className="font-medium text-slate-800">{child?.name ?? '未知幼儿'}</strong>
                              <span className="text-xs text-slate-500">
                                {formatDateCn(observation.observed_at)}
                                {observation.context ? ` · ${observation.context}` : ''}
                              </span>
                            </span>
                            <span className="mt-1 block truncate text-sm text-slate-600">{excerpt(observation.raw_text, 78)}</span>
                          </span>
                          <StatusBadge status={observation.status} />
                          <ArrowUpRight className="size-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="flex max-w-4xl items-center gap-3 border-y border-dashed border-sky-200 px-3 py-3.5 sm:px-4">
                  <Baby className="size-5 shrink-0 text-sky-600" aria-hidden="true" />
                  <p className="text-sm text-slate-600">还没有观察记录，从一次具体行为开始吧。</p>
                </div>
              )}
              </section>
            </div>
          </section>

        </>
      )}
    </div>
  );
}
