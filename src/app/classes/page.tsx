import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, School } from 'lucide-react';

import { ClassFormDialog } from '@/components/class-dialogs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateCn } from '@/lib/format';
import { listChildren, listClasses, listObservations } from '@/lib/queries';
import { CLASS_STAGE_LABELS, type Child, type Observation, type SchoolClass } from '@/lib/types';

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

export default async function ClassesPage() {
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
    dbError = e instanceof Error ? e.message : '数据库连接失败';
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

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">班级</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            按小班 / 中班 / 大班组织幼儿与观察。班级是组织上下文，不是评分单位。
          </p>
        </div>
        <ClassFormDialog label="新建班级" variant="default" size="default" />
      </div>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
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
                先创建班级，再为幼儿分班；建档与记录观察都需要先有班级。
              </p>
            </div>
            <ClassFormDialog label="新建班级" variant="default" />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {classes.map((klass) => {
            const item = stats.get(klass.id) ?? {
              children: 0,
              confirmed: 0,
              pending: 0,
              latest: null,
            };
            return (
              <Link key={klass.id} href={`/classes/${klass.id}`} className="group min-w-0">
                <Card className="h-full transition-colors group-hover:border-amber-300 group-hover:bg-amber-50/20">
                  <CardContent className="space-y-4 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h2 className="truncate font-semibold text-slate-900">{klass.name}</h2>
                          <Badge variant="secondary">{CLASS_STAGE_LABELS[klass.stage]}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-slate-500">{klass.school_year}</p>
                      </div>
                      {!klass.is_active ? (
                        <Badge
                          variant="outline"
                          className="border-slate-300 bg-slate-50 font-normal text-slate-500"
                        >
                          已停用
                        </Badge>
                      ) : null}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 pt-4 text-sm">
                      <div>
                        <dt className="text-xs text-slate-500">儿童</dt>
                        <dd className="mt-0.5 text-slate-700">{item.children} 人</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">最近观察</dt>
                        <dd className="mt-0.5 text-slate-700">
                          {item.latest ? formatDateCn(item.latest) : '暂无'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">已确认</dt>
                        <dd className="mt-0.5 text-emerald-700">{item.confirmed} 条</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">待处理</dt>
                        <dd className="mt-0.5 text-amber-700">{item.pending} 条</dd>
                      </div>
                    </dl>

                    <span className="flex items-center gap-1 text-sm font-medium text-amber-700">
                      查看班级
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </span>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
