import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
  ClipboardCheck,
  PenLine,
  Sprout,
  UserPlus,
} from 'lucide-react';

import { ClassFormDialog } from '@/components/class-dialogs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badges';
import {
  ageText,
  excerpt,
  formatDateCn,
  schoolClassLabel,
} from '@/lib/format';
import {
  getClass,
  getClassChildren,
  listChildren,
  listObservations,
} from '@/lib/queries';
import {
  CLASS_STAGE_LABELS,
  type Child,
  type Observation,
  type SchoolClass,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '班级详情',
};

function SectionTitle({ title, hint, extra }: { title: string; hint?: string; extra?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </div>
      {extra}
    </div>
  );
}

function EmptyHint({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-start gap-3 p-5 sm:p-6">
        <Sprout className="size-5 text-emerald-600" aria-hidden="true" />
        <p className="max-w-xl text-sm leading-6 text-slate-600">{text}</p>
        {action}
      </CardContent>
    </Card>
  );
}

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let klass: SchoolClass | null = null;
  let dbError: string | null = null;
  try {
    klass = await getClass(id);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  if (dbError) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-11">
          <Link href="/classes">
            <ArrowLeft className="size-4" />
            返回班级列表
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!klass) notFound();

  let children: Child[] = [];
  // 全园档案只用于历史观察的作者显示；当前班级名单以 getClassChildren 为准
  let allChildren: Child[] = [];
  let allObservations: Observation[] = [];
  try {
    [children, allChildren, allObservations] = await Promise.all([
      getClassChildren(id),
      listChildren(),
      listObservations({ limit: 1000 }),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  const observations = allObservations
    .filter((observation) => observation.class_id === id)
    .sort(
      (a, b) =>
        b.observed_at.localeCompare(a.observed_at) ||
        b.created_at.localeCompare(a.created_at),
    );
  const pending = observations.filter((observation) => observation.status !== 'confirmed');
  const confirmedCount = observations.length - pending.length;
  const recent = observations.slice(0, 6);
  const latest = observations[0];

  return (
    <div className="space-y-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-11">
        <Link href="/classes">
          <ArrowLeft className="size-4" />
          返回班级列表
        </Link>
      </Button>

      <section className="rounded-2xl border bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-slate-900">
                {CLASS_STAGE_LABELS[klass.stage]} · {klass.name} · {klass.school_year}
              </h1>
              {klass.is_active ? (
                <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                  启用中
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-slate-300 bg-slate-50 font-normal text-slate-500"
                >
                  已停用
                </Badge>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              这个班级的成长档案与观察证据都集中在这里。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" className="min-h-11">
              <Link href="/observations/new">
                <PenLine className="size-4" />
                记录一次观察
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="min-h-11">
              <Link href="/children/new">
                <UserPlus className="size-4" />
                建立成长档案
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="min-h-11">
              <Link href={`/observations?class=${encodeURIComponent(klass.id)}`}>
                <ClipboardCheck className="size-4" />
                查看观察记录
              </Link>
            </Button>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">成长档案</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">{children.length} 份</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">待处理观察</dt>
            <dd className={`mt-1 text-sm font-medium ${pending.length > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
              {pending.length} 条
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">已确认观察</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">{confirmedCount} 条</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">最近观察</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">
              {latest ? formatDateCn(latest.observed_at) : '还没有记录'}
            </dd>
          </div>
        </dl>
      </section>

      {!klass.is_active ? (
        <Alert>
          <AlertTitle>班级已停用</AlertTitle>
          <AlertDescription>
            停用只影响新分班：已有成长档案与观察记录都会保留。需要重新启用时，可在页面底部的“班级管理”里编辑。
          </AlertDescription>
        </Alert>
      ) : null}

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>班级数据暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : (
        <>
          {pending.length > 0 ? (
            <Link
              href={`/observations?class=${encodeURIComponent(klass.id)}`}
              className="group flex min-h-11 items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 transition-colors hover:border-amber-300 hover:bg-amber-50"
            >
              <ClipboardCheck className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                还有 <strong className="font-semibold">{pending.length}</strong> 条观察待处理，确认后才会进入成长档案。
              </span>
              <ArrowUpRight
                className="size-4 shrink-0 text-slate-400 transition-colors group-hover:text-amber-700"
                aria-hidden="true"
              />
            </Link>
          ) : null}

          <section>
            <SectionTitle
              title="成长档案"
              hint="点击进入每个小朋友的成长档案"
              extra={<span className="text-xs text-slate-500">共 {children.length} 份</span>}
            />
            {children.length === 0 ? (
              <EmptyHint
                text="这个班级还没有成长档案。建立第一份档案后，就可以从这里记录观察。"
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/children/new">
                      <UserPlus className="size-4" />
                      建立成长档案
                    </Link>
                  </Button>
                }
              />
            ) : (
              <div className="divide-y divide-slate-200/80 border-y border-slate-200/80">
                {children.map((child) => {
                  const childObservations = observations.filter(
                    (observation) => observation.child_id === child.id,
                  );
                  const childLatest = childObservations[0];
                  const childPending = childObservations.filter(
                    (observation) => observation.status !== 'confirmed',
                  ).length;
                  return (
                    <Link
                      key={child.id}
                      href={`/children/${child.id}`}
                      className="group flex min-h-11 min-w-0 items-center gap-3 px-2 py-3.5 transition-colors hover:bg-amber-50/45 sm:gap-4 sm:px-3"
                    >
                      <span
                        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xl"
                        aria-hidden="true"
                      >
                        {child.avatar_emoji ?? '🧒'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <strong className="truncate text-base text-slate-900">{child.name}</strong>
                          {childPending > 0 ? (
                            <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                              待处理 {childPending}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {ageText(child.birth_date)}
                          {' · '}
                          {childLatest
                            ? `最近观察 ${formatDateCn(childLatest.observed_at)}`
                            : '还没有观察'}
                        </span>
                      </span>
                      <ArrowUpRight
                        className="size-4 shrink-0 text-slate-400 transition-colors group-hover:text-emerald-700"
                        aria-hidden="true"
                      />
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <SectionTitle
              title="最近观察"
              hint="按观察日期倒序，点击进入整理与确认"
              extra={
                observations.length > recent.length ? (
                  <Link
                    href={`/observations?class=${encodeURIComponent(klass.id)}`}
                    className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800"
                  >
                    查看全部 {observations.length} 条
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </Link>
                ) : null
              }
            />
            {recent.length === 0 ? (
              <EmptyHint
                text="班级还没有观察记录，从一次具体行为开始记录。"
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/observations/new">
                      <PenLine className="size-4" />
                      记录一次观察
                    </Link>
                  </Button>
                }
              />
            ) : (
              <div className="relative space-y-2 border-l border-amber-200 pl-5 sm:pl-6">
                {recent.map((observation) => {
                  const child = allChildren.find((c) => c.id === observation.child_id);
                  const historyNote =
                    observation.observed_class && observation.class_id !== child?.class_id
                      ? `当时在 ${schoolClassLabel(observation.observed_class)}`
                      : null;
                  return (
                    <Link
                      key={observation.id}
                      href={`/observations/${observation.id}/review`}
                      className="group relative block rounded-xl border border-transparent px-3 py-3 transition-colors hover:border-amber-300 hover:bg-amber-50/20"
                    >
                      <span
                        className="absolute -left-[25px] top-5 size-2.5 rounded-full bg-amber-400 ring-4 ring-amber-50 transition-colors group-hover:bg-emerald-500 sm:-left-[29px]"
                        aria-hidden="true"
                      />
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-lg" aria-hidden="true">
                          {child?.avatar_emoji ?? '🧒'}
                        </span>
                        <span className="font-medium text-slate-800">
                          {child?.name ?? '未知幼儿'}
                        </span>
                        <span className="text-xs text-slate-500">
                          {formatDateCn(observation.observed_at)}
                          {observation.context ? ` · ${observation.context}` : ''}
                        </span>
                        {historyNote ? (
                          <span className="text-xs text-slate-500">{historyNote}</span>
                        ) : null}
                        <span className="ml-auto">
                          <StatusBadge status={observation.status} compact />
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 break-words text-sm leading-6 text-slate-600">
                        {excerpt(observation.raw_text, 120)}
                      </p>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <section aria-labelledby="class-manage-title" className="border-t border-slate-200/80 pt-5">
        <h2 id="class-manage-title" className="text-sm font-medium text-slate-700">
          班级管理
        </h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
          编辑名称、学段、学年，或停用班级。停用只影响新分班，历史记录不受影响。
        </p>
        <div className="mt-3">
          <ClassFormDialog klass={klass} label="编辑班级" />
        </div>
      </section>
    </div>
  );
}
