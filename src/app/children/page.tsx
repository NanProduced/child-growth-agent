import type { Metadata } from 'next';
import { AccountsError } from '@/lib/accounts/errors';
import Link from 'next/link';
import { ArrowUpRight, Baby, ClipboardList, Sprout, UserPlus } from 'lucide-react';

import { ReadFailureNotice, readFailureKind } from '@/components/read-failure-notice';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badges';
import { ageText, classLabel, excerpt, formatDateCn } from '@/lib/format';
import { resolveServerAuth } from '@/lib/accounts/access';
import { scopedListChildren as listChildren, scopedListClasses as listClasses, scopedListObservations as listObservations } from '@/lib/accounts/scoped-queries';
import type { Child, Observation, SchoolClass } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '成长档案',
};

const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
    active
      ? 'border-emerald-300 bg-emerald-50 font-medium text-emerald-800'
      : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200 hover:bg-amber-50/50'
  }`;

export default async function ChildrenPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string }>;
}) {
  const { class: classParam } = await searchParams;
  const auth = await resolveServerAuth();
  if (auth.state.kind !== 'authenticated') {
    return <ReadFailureNotice kind={auth.state.kind === 'unavailable' ? 'unavailable' : 'login'} what="成长档案" retryHref="/children" />;
  }
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
  } catch (e) {
    if (e instanceof AccountsError) return <ReadFailureNotice kind={readFailureKind(e)} what="成长档案" retryHref="/children" />;
    dbError = '读取暂未完成，请稍后重新读取；这不代表没有数据。';
  }

  const activeClass =
    classParam && classes.some((klass) => klass.id === classParam) ? classParam : 'all';
  const shownChildren =
    activeClass === 'all' ? children : children.filter((child) => child.class_id === activeClass);
  const countOf = (classId: string) =>
    classId === 'all'
      ? children.length
      : children.filter((child) => child.class_id === classId).length;

  const observationsByChild = new Map<string, Observation[]>();
  for (const observation of observations) {
    const childObservations = observationsByChild.get(observation.child_id) ?? [];
    childObservations.push(observation);
    observationsByChild.set(observation.child_id, childObservations);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">成长档案</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            从最近一次观察回到每个小朋友的成长片段。
          </p>
        </div>
        <Button asChild className="w-full sm:w-auto">
          <Link href="/children/new">
            <UserPlus className="size-4" />
            建立成长档案
          </Link>
        </Button>
      </div>

      {classes.length > 0 ? (
        <nav aria-label="按班级筛选成长档案" className="flex flex-wrap gap-2">
          <Link
            href="/children"
            aria-current={activeClass === 'all' ? 'page' : undefined}
            className={chipClass(activeClass === 'all')}
          >
            全部班级 <span className="text-xs opacity-70">{countOf('all')}</span>
          </Link>
          {classes.map((klass) => (
            <Link
              key={klass.id}
              href={`/children?class=${klass.id}`}
              aria-current={activeClass === klass.id ? 'page' : undefined}
              className={chipClass(activeClass === klass.id)}
            >
              {classLabel(klass.stage, klass.name)}{' '}
              <span className="text-xs opacity-70">{countOf(klass.id)}</span>
            </Link>
          ))}
        </nav>
      ) : null}

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : children.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:p-8">
            <span className="flex size-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <Sprout className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-medium text-slate-800">还没有成长档案</h2>
              <p className="mt-1 max-w-lg text-sm leading-6 text-slate-500">
                先建立一个成长档案，再从一条具体观察开始积累。
              </p>
            </div>
            <Button asChild>
              <Link href="/children/new">
                <UserPlus className="size-4" />
                建立成长档案
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : shownChildren.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:p-8">
            <span className="flex size-11 items-center justify-center rounded-full bg-amber-50 text-amber-700">
              <Sprout className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-medium text-slate-800">这个班级还没有成长档案</h2>
              <p className="mt-1 max-w-lg text-sm leading-6 text-slate-500">
                切换到「全部班级」查看其他幼儿，或为这个班级建立成长档案。
              </p>
            </div>
            <Button asChild>
              <Link href="/children/new">
                <UserPlus className="size-4" />
                建立成长档案
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {shownChildren.map((child) => {
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
                className="group min-w-0"
              >
                <Card className="h-full transition-colors group-hover:border-amber-300 group-hover:bg-amber-50/20">
                  <CardContent className="space-y-4 p-5">
                    <div className="flex items-start gap-3">
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-2xl" aria-hidden="true">
                        {child.avatar_emoji ?? '🧒'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="font-semibold text-slate-900">{child.name}</h2>
                        </div>
                        <p className="mt-1 text-sm text-slate-500">
                          {classLabel(child.class_stage, child.class_name) ?? '未分班'} ·{' '}
                          {ageText(child.birth_date)}
                        </p>
                      </div>
                      <ArrowUpRight className="size-4 shrink-0 text-slate-400 transition-colors group-hover:text-amber-700" aria-hidden="true" />
                    </div>

                    <div className="grid gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
                      <div className="min-w-0">
                        <p className="text-xs text-slate-500">最近观察</p>
                        {latest ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-slate-700">
                            <span>{formatDateCn(latest.observed_at)}</span>
                            {latest.context ? <span className="text-xs text-slate-500">· {latest.context}</span> : null}
                            <StatusBadge status={latest.status} compact />
                          </div>
                        ) : (
                          <p className="mt-1 text-slate-500">还没有记录</p>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-slate-500">最近变化</p>
                        <p className="mt-1 line-clamp-2 leading-6 text-slate-600">
                          {recentChange ?? '确认一条观察后，这里会出现最近变化。'}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5 text-emerald-700">
                        <Sprout className="size-3.5" aria-hidden="true" />
                        {child.growth_profile ? '成长小结已更新' : latestConfirmed ? '已有确认观察' : '等待第一条观察'}
                      </span>
                      {pendingCount > 0 ? (
                        <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                          待处理 {pendingCount}
                        </Badge>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs leading-5 text-slate-400">
        <ClipboardList className="size-3.5" aria-hidden="true" />
        原始观察会被保留；确认后的内容才会进入成长小结与支持建议。
      </div>
    </div>
  );
}
