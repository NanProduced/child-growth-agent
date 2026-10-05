import type { Metadata } from 'next';
import { AccountsError } from '@/lib/accounts/errors';
import Link from 'next/link';
import { ArrowUpRight, Leaf, Sprout, UserPlus } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { hasCurrentActivitySupport } from '@/lib/activity-support';
import { classLabel } from '@/lib/format';
import { scopedListChildren as listChildren, scopedListObservations as listObservations } from '@/lib/accounts/scoped-queries';
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

function ProfileRow({ child, confirmedCount, support }: ChildRow) {
  const suggestion = support?.suggestions[0] ?? null;
  return (
    <Link
      href={`/children/${child.id}`}
      className="group flex min-w-0 flex-col gap-2 px-2 py-4 transition-colors hover:bg-emerald-50/30 sm:px-3"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xl"
          aria-hidden="true"
        >
          {child.avatar_emoji ?? '🧒'}
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-base text-slate-900">{child.name}</strong>
          <span className="mt-0.5 block break-words text-xs text-slate-500">
            {classLabel(child.class_stage, child.class_name) ?? '未分班'}
          </span>
        </span>
        <ArrowUpRight
          className="size-4 shrink-0 text-slate-400 transition-colors group-hover:text-emerald-700"
          aria-hidden="true"
        />
      </span>

      <span className="flex flex-wrap items-center gap-2">
        <Badge
          variant="secondary"
          className={confirmedCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}
        >
          已确认观察 {confirmedCount} 条
        </Badge>
        {support ? (
          <Badge variant="outline" className="border-emerald-200 font-normal text-emerald-700">
            <Leaf className="size-3" aria-hidden="true" />
            已有活动支持
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-slate-500">
            还没有活动支持
          </Badge>
        )}
      </span>

      {suggestion ? (
        <span className="block break-words text-sm leading-6 text-slate-600">
          <span className="font-medium text-slate-800">{suggestion.title}</span>
          <span className="mt-0.5 line-clamp-2 break-words"> {suggestion.purpose}</span>
        </span>
      ) : confirmedCount > 0 ? (
        <span className="block break-words text-sm leading-6 text-slate-600">
          还没有活动支持建议。进入成长档案后，可以从已确认观察生成 2～3 个可试试的活动。
        </span>
      ) : (
        <span className="block break-words text-sm leading-6 text-slate-600">
          还没有已确认观察。先确认一条观察，活动支持才会有真实依据。
        </span>
      )}
    </Link>
  );
}

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
    if (e instanceof AccountsError) throw e;
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
  const ready = rows.filter((row) => row.confirmedCount > 0);
  const waiting = rows.filter((row) => row.confirmedCount === 0);

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">活动支持</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          从教师确认后的观察出发，为下一次活动提供可尝试的方向。建议保存在对应的成长档案里。
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
        <div className="space-y-8">
          {ready.length > 0 ? (
            <section aria-labelledby="ready-title">
              <div className="mb-3">
                <h2 id="ready-title" className="text-base font-semibold text-slate-900">
                  已有确认观察的成长档案
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  进入成长档案，可以生成新的活动支持或查看已有建议。
                </p>
              </div>
              <div className="divide-y divide-slate-200/80 border-y border-slate-200/80">
                {ready.map((row) => (
                  <ProfileRow key={row.child.id} {...row} />
                ))}
              </div>
            </section>
          ) : null}

          {waiting.length > 0 ? (
            <section aria-labelledby="waiting-title">
              <div className="mb-3">
                <h2 id="waiting-title" className="text-base font-semibold text-slate-900">
                  等待第一条已确认观察
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  观察确认后，这里才会出现可以试试的方向。
                </p>
              </div>
              <div className="divide-y divide-slate-200/80 border-y border-slate-200/80">
                {waiting.map((row) => (
                  <ProfileRow key={row.child.id} {...row} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      {!dbError && children.length > 0 ? (
        <p className="text-xs leading-5 text-slate-400">
          建议来自教师确认后的观察，可按现场情况灵活调整。
        </p>
      ) : null}
    </div>
  );
}
