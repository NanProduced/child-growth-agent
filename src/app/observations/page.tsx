import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList, PenLine } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badges';
import { classLabel, excerpt, formatDateCn, schoolClassLabel } from '@/lib/format';
import { listChildren, listClasses, listObservations } from '@/lib/queries';
import type { Child, Observation, ObservationStatus, SchoolClass } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '观察记录',
};

const TABS: { key: ObservationStatus | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '待判断' },
  { key: 'needs_input', label: '待补充' },
  { key: 'ai_organized', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
];

const STATUS_PRIORITY: Record<ObservationStatus, number> = {
  ai_organized: 0,
  needs_input: 1,
  draft: 2,
  confirmed: 3,
};

const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
    active
      ? 'border-emerald-300 bg-emerald-50 font-medium text-emerald-800'
      : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200 hover:bg-amber-50/50'
  }`;

export default async function ObservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; class?: string }>;
}) {
  const { status, class: classParam } = await searchParams;
  const valid: ObservationStatus[] = ['draft', 'needs_input', 'ai_organized', 'confirmed'];
  const active = valid.includes(status as ObservationStatus)
    ? (status as ObservationStatus)
    : 'all';

  let observations: Observation[] = [];
  let children: Child[] = [];
  let classes: SchoolClass[] = [];
  let dbError: string | null = null;
  try {
    [observations, children, classes] = await Promise.all([
      listObservations(),
      listChildren(),
      listClasses(),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  const activeClass =
    classParam && classes.some((klass) => klass.id === classParam) ? classParam : 'all';
  const scoped =
    activeClass === 'all'
      ? observations
      : observations.filter((observation) => observation.class_id === activeClass);
  const childrenById = new Map(children.map((child) => [child.id, child]));
  const filtered =
    active === 'all' ? scoped : scoped.filter((observation) => observation.status === active);
  const shown =
    active === 'all'
      ? [...filtered].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])
      : filtered;
  const countOf = (key: ObservationStatus | 'all') =>
    key === 'all'
      ? scoped.length
      : scoped.filter((observation) => observation.status === key).length;
  const hrefWith = (next: { status?: string; class?: string }) => {
    const params = new URLSearchParams();
    const nextStatus = next.status ?? (active === 'all' ? '' : active);
    const nextClass = next.class ?? (activeClass === 'all' ? '' : activeClass);
    if (nextStatus) params.set('status', nextStatus);
    if (nextClass) params.set('class', nextClass);
    const query = params.toString();
    return query ? `/observations?${query}` : '/observations';
  };
  const nothingAtAll = active === 'all' && activeClass === 'all';

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">观察记录</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            先处理需要教师判断的记录，再回到已确认观察的证据时间线。
          </p>
        </div>
        <Button asChild className="w-full sm:w-auto">
          <Link href="/observations/new">
            <PenLine className="size-4" />
            开始记录
          </Link>
        </Button>
      </div>

      <nav aria-label="观察记录状态筛选" className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={hrefWith({ status: tab.key === 'all' ? '' : tab.key })}
            aria-current={active === tab.key ? 'page' : undefined}
            className={chipClass(active === tab.key)}
          >
            {tab.label} <span className="text-xs opacity-70">{countOf(tab.key)}</span>
          </Link>
        ))}
      </nav>

      {classes.length > 0 ? (
        <nav aria-label="按班级筛选观察记录" className="flex flex-wrap gap-2">
          <Link
            href={hrefWith({ class: '' })}
            aria-current={activeClass === 'all' ? 'page' : undefined}
            className={chipClass(activeClass === 'all')}
          >
            全部班级 <span className="text-xs opacity-70">{observations.length}</span>
          </Link>
          {classes.map((klass) => (
            <Link
              key={klass.id}
              href={hrefWith({ class: klass.id })}
              aria-current={activeClass === klass.id ? 'page' : undefined}
              className={chipClass(activeClass === klass.id)}
            >
              {classLabel(klass.stage, klass.name)}{' '}
              <span className="text-xs opacity-70">
                {observations.filter((observation) => observation.class_id === klass.id).length}
              </span>
            </Link>
          ))}
        </nav>
      ) : null}

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : shown.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-3 p-6 sm:p-8">
            <ClipboardList className="size-6 text-emerald-600" aria-hidden="true" />
            <div>
              <h2 className="font-medium text-slate-800">
                {nothingAtAll ? '还没有观察记录' : '当前筛选下没有记录'}
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                {nothingAtAll
                  ? '从一次具体行为开始，保存后再进入 AI 整理。'
                  : '可以切换其他状态或班级，或开始记录一条新的观察。'}
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/observations/new">开始记录</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="relative space-y-3 border-l border-amber-200 pl-5 sm:pl-6">
          {shown.map((observation) => {
            const child = childrenById.get(observation.child_id);
            return (
              <Link
                key={observation.id}
                href={`/observations/${observation.id}/review`}
                className="group relative block rounded-xl border border-transparent bg-white p-4 transition-colors hover:border-amber-300 hover:bg-amber-50/20"
              >
                <span
                  className="absolute -left-[25px] top-5 size-2.5 rounded-full bg-amber-400 ring-4 ring-amber-50 transition-colors group-hover:bg-emerald-500 sm:-left-[29px]"
                  aria-hidden="true"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg" aria-hidden="true">{child?.avatar_emoji ?? '🧒'}</span>
                  <span className="text-sm font-semibold text-slate-800">{child?.name ?? '未知幼儿'}</span>
                  <span className="text-xs text-slate-500">
                    {formatDateCn(observation.observed_at)}
                    {observation.context ? ` · ${observation.context}` : ''}
                  </span>
                  {schoolClassLabel(observation.observed_class) ? (
                    <span className="text-xs text-slate-500">
                      {schoolClassLabel(observation.observed_class)}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2">
                    <StatusBadge status={observation.status} compact />
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                  {excerpt(observation.raw_text, 140)}
                </p>
                {observation.status === 'confirmed' ? (
                  <Badge variant="outline" className="mt-3 border-emerald-200 font-normal text-emerald-700">
                    已进入成长档案依据
                  </Badge>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
