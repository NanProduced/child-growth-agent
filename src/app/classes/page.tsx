import type { Metadata } from 'next';
import { AccountsError } from '@/lib/accounts/errors';
import Link from 'next/link';
import { ArrowUpRight, Flower2, Leaf, School, Sprout } from 'lucide-react';

import { ClassFormDialog } from '@/components/class-dialogs';
import { ReadFailureNotice, readFailureKind } from '@/components/read-failure-notice';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateCn } from '@/lib/format';
import { resolveServerAuth } from '@/lib/accounts/access';
import { scopedListChildren as listChildren, scopedListClasses as listClasses, scopedListObservations as listObservations } from '@/lib/accounts/scoped-queries';
import { CLASS_STAGES, CLASS_STAGE_LABELS, type Child, type ClassStage, type Observation, type SchoolClass } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '班级',
};

interface ClassStats {
  children: number;
  confirmed: number;
  pending: number;
  latest: string | null;
}

const stageMeta: Record<ClassStage, { icon: typeof Sprout; tone: string }> = {
  small: { icon: Sprout, tone: 'bg-rose-50 text-rose-600' },
  middle: { icon: Flower2, tone: 'bg-amber-50 text-amber-700' },
  large: { icon: Leaf, tone: 'bg-sky-50 text-sky-700' },
};

export default async function ClassesPage() {
  const auth = await resolveServerAuth();
  if (auth.state.kind !== 'authenticated') {
    return <ReadFailureNotice kind={auth.state.kind === 'unavailable' ? 'unavailable' : 'login'} what="班级资料" retryHref="/classes" />;
  }
  // UI projection only: server reads and writes still re-authorize on every request.
  const isAdmin = auth.state.principal.role === 'admin';
  let classes: SchoolClass[] = [];
  let childList: Child[] = [];
  let observations: Observation[] = [];
  let dbError: string | null = null;
  try {
    [classes, childList, observations] = await Promise.all([
      listClasses(),
      listChildren(),
      listObservations({ limit: 1000 }),
    ]);
  } catch (e) {
    if (e instanceof AccountsError) return <ReadFailureNotice kind={readFailureKind(e)} what="班级资料" retryHref="/classes" />;
    dbError = '班级资料暂时无法加载，请稍后重试。';
  }

  const stats = new Map<string, ClassStats>(
    classes.map((klass) => [klass.id, { children: 0, confirmed: 0, pending: 0, latest: null }]),
  );
  for (const child of childList) {
    if (!child.class_id) continue;
    const item = stats.get(child.class_id);
    if (item) item.children += 1;
  }
  for (const observation of observations) {
    if (!observation.class_id) continue;
    const item = stats.get(observation.class_id);
    if (!item) continue;
    if (observation.status === 'confirmed') item.confirmed += 1;
    else item.pending += 1;
    if (!item.latest || observation.observed_at > item.latest) item.latest = observation.observed_at;
  }

  const classGroups = CLASS_STAGES.map((stage) => ({
    stage,
    classes: classes
      .filter((klass) => klass.stage === stage)
      .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name, 'zh-CN')),
  })).filter((group) => group.classes.length > 0);

  return (
    <div data-platform-surface="classes" className="space-y-8 pb-4 sm:space-y-10">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">班级</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            查看班上的幼儿、观察记录和指南证据。
          </p>
        </div>
        {isAdmin ? <ClassFormDialog label="新建班级" variant="default" size="default" /> : null}
      </div>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>班级资料暂时无法查看</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : classes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:p-8">
            <span className="flex size-11 items-center justify-center rounded-full bg-amber-50 text-amber-700">
              <School className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-medium text-slate-800">还没有班级</h2>
              <p className="mt-1 max-w-lg text-sm leading-6 text-slate-500">
                {isAdmin
                  ? '先创建班级，再为幼儿分班；建档与记录观察都需要先有班级。'
                  : '当前范围内还没有班级，请联系管理员建立班级并分配任教。'}
              </p>
            </div>
            {isAdmin ? <ClassFormDialog label="新建班级" variant="default" /> : null}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {classGroups.map(({ stage, classes: stageClasses }) => {
            const meta = stageMeta[stage];
            const Icon = meta.icon;
            return (
              <section key={stage} aria-labelledby={`classes-${stage}`}>
                <div className="flex items-center gap-3">
                  <span className={`flex size-10 items-center justify-center rounded-xl ${meta.tone}`} aria-hidden="true">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <h2 id={`classes-${stage}`} className="text-xl font-semibold text-slate-900">
                      {CLASS_STAGE_LABELS[stage]}
                    </h2>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {stageClasses.length} 个班级
                    </p>
                  </div>
                </div>
                <div className="mt-4 divide-y divide-slate-200/80 border-y border-slate-200/80">
                  {stageClasses.map((klass) => {
                    const item = stats.get(klass.id) ?? { children: 0, confirmed: 0, pending: 0, latest: null };
                    return (
                      <Link
                        key={klass.id}
                        href={`/classes/${klass.id}`}
                        className="group flex min-w-0 items-center gap-3 px-2 py-4 transition-colors hover:bg-amber-50/45 sm:gap-5 sm:px-3"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <strong className="min-w-0 break-words text-base text-slate-900">{klass.name}</strong>
                            <Badge variant="secondary" className="font-normal">{klass.school_year}</Badge>
                            {!klass.is_active ? <Badge variant="outline" className="font-normal text-slate-500">已停用</Badge> : null}
                          </span>
                        </span>
                        <span className="hidden min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-500 lg:flex">
                          <span><strong className="font-semibold text-slate-800">{item.children}</strong> 份成长档案</span>
                          {item.pending > 0 ? <span className="text-amber-700"><strong className="font-semibold">{item.pending}</strong> 条待处理</span> : null}
                          <span>{item.latest ? `最近 ${formatDateCn(item.latest)}` : '还没有观察'}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-emerald-700">
                          <span className="sr-only">查看班级</span>
                          <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
                        </span>
                        <span className="flex shrink-0 flex-col items-end text-right text-sm tabular-nums text-slate-500 lg:hidden">
                          <span>{item.children} 份档案</span>
                          {item.pending > 0 ? <span className="text-amber-700">{item.pending} 条待处理</span> : null}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
