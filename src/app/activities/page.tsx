import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, ClipboardCheck, Leaf, Sparkles, Sprout, UserPlus } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AiBadge, DemoBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { hasCurrentActivitySupport } from '@/lib/activity-support';
import { ageText, classLabel, formatDateTimeCn } from '@/lib/format';
import { listChildren, listObservations } from '@/lib/queries';
import { activitySupportSchema } from '@/lib/validation';
import type { ActivitySupport, Child, Observation } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '活动支持',
};

type ChildRow = {
  child: Child;
  confirmedCount: number;
  support: ActivitySupport | null;
};

export default async function ActivitiesPage() {
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

  const observationsByChild = new Map<string, Observation[]>();
  for (const observation of observations) {
    const childObservations = observationsByChild.get(observation.child_id) ?? [];
    childObservations.push(observation);
    observationsByChild.set(observation.child_id, childObservations);
  }

  const rows: ChildRow[] = children.map((child) => {
    const childObservations = observationsByChild.get(child.id) ?? [];
    const confirmedCount = childObservations.filter(
      (observation) => observation.status === 'confirmed' && observation.confirmed_content,
    ).length;
    const stored = activitySupportSchema.safeParse(child.growth_profile?.activity_support);
    const support =
      stored.success && hasCurrentActivitySupport(stored.data, childObservations)
        ? stored.data
        : null;
    return { child, confirmedCount, support };
  });
  // ponytail: 有已确认观察的排前面，其余保持档案原有顺序（Array.sort 是稳定排序）
  rows.sort((a, b) => Number(b.confirmedCount > 0) - Number(a.confirmedCount > 0));

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">活动支持</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          从已确认观察出发，给下一次活动一个可以试试的方向。已生成的建议保存在对应的成长档案里。
        </p>
      </div>

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
                先建立一个成长档案并确认一条观察，活动支持才会从真实证据里长出来。
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
          {rows.map(({ child, confirmedCount, support }) => (
            <Link key={child.id} href={`/children/${child.id}`} className="group min-w-0">
              <Card className="h-full transition-colors group-hover:border-emerald-300 group-hover:bg-emerald-50/20">
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start gap-3">
                    <span
                      className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-2xl"
                      aria-hidden="true"
                    >
                      {child.avatar_emoji ?? '🧒'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold text-slate-900">{child.name}</h2>
                        {child.is_demo ? <DemoBadge /> : null}
                      </div>
                      <p className="mt-1 text-sm text-slate-500">
                        {classLabel(child.class_stage, child.class_name) ?? '未分班'} ·{' '}
                        {ageText(child.birth_date)}
                      </p>
                    </div>
                    <ArrowUpRight
                      className="size-4 shrink-0 text-slate-400 transition-colors group-hover:text-emerald-700"
                      aria-hidden="true"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={
                        confirmedCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
                      }
                    >
                      已确认观察 {confirmedCount} 条
                    </Badge>
                    {confirmedCount === 0 ? null : support ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-200 font-normal text-emerald-700"
                      >
                        <Leaf className="size-3" aria-hidden="true" />
                        已有活动支持
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="font-normal text-slate-500">
                        还没有活动支持建议
                      </Badge>
                    )}
                  </div>

                  {support ? (
                    <div className="space-y-2 border-t border-slate-100 pt-3">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>活动卡片摘要</span>
                        <AiBadge />
                      </div>
                      <ul className="space-y-1.5">
                        {support.suggestions.map((suggestion) => (
                          <li
                            key={suggestion.title}
                            className="rounded-lg bg-emerald-50/70 px-3 py-2"
                          >
                            <p className="text-sm font-medium leading-6 text-slate-800">
                              {suggestion.title}
                            </p>
                            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-slate-500">
                              {suggestion.purpose}
                            </p>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-slate-500">
                        最近生成：{formatDateTimeCn(support.generated_at)}
                      </p>
                    </div>
                  ) : confirmedCount > 0 ? (
                    <p className="border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">
                      还没有活动支持建议。进入成长档案后，可以从已确认观察生成 2～3 个可试试的活动。
                    </p>
                  ) : (
                    <p className="flex items-start gap-2 border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">
                      <ClipboardCheck className="mt-1 size-4 shrink-0 text-amber-500" aria-hidden="true" />
                      <span>
                        还没有已确认观察。先确认一条观察，活动支持才会有真实依据。
                      </span>
                    </p>
                  )}

                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs font-medium text-emerald-700">
                    <span>
                      {support
                        ? '查看完整建议'
                        : confirmedCount > 0
                          ? '去成长档案生成活动支持'
                          : '去成长档案记录第一条观察'}
                    </span>
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {!dbError && children.length > 0 ? (
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-400">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          活动支持只读取教师确认后的观察与成长小结，建议可按现场情况灵活调整。
        </div>
      ) : null}
    </div>
  );
}
