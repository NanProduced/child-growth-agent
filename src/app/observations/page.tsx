import type { Metadata } from 'next';
import Link from 'next/link';
import { PenLine } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AiBadge, DemoBadge, StatusBadge } from '@/components/status-badges';
import { excerpt, formatDateCn } from '@/lib/format';
import { listChildren, listObservations } from '@/lib/queries';
import type { Child, Observation, ObservationStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '观察记录',
};

const TABS: { key: ObservationStatus | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '待判断' },
  { key: 'needs_input', label: '待补充信息' },
  { key: 'ai_organized', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
];

export default async function ObservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const valid: ObservationStatus[] = ['draft', 'needs_input', 'ai_organized', 'confirmed'];
  const active = valid.includes(status as ObservationStatus)
    ? (status as ObservationStatus)
    : 'all';

  let observations: Observation[] = [];
  let children: Child[] = [];
  let dbError: string | null = null;
  try {
    [observations, children] = await Promise.all([listObservations(), listChildren()]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  const childrenById = new Map(children.map((c) => [c.id, c]));
  const shown =
    active === 'all' ? observations : observations.filter((o) => o.status === active);
  const countOf = (key: ObservationStatus | 'all') =>
    key === 'all' ? observations.length : observations.filter((o) => o.status === key).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">观察记录</h1>
          <p className="mt-1 text-sm text-slate-600">
            所有记录按时间倒序；AI 整理结果需教师确认后才进入正册。
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/observations/new">
            <PenLine className="size-4" />
            录入观察
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.key === 'all' ? '/observations' : `/observations?status=${tab.key}`}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              active === tab.key
                ? 'border-amber-300 bg-amber-100 font-medium text-amber-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {tab.label}（{countOf(tab.key)}）
          </Link>
        ))}
      </div>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-slate-500">
            暂无符合条件的记录。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((obs) => {
            const child = childrenById.get(obs.child_id);
            return (
              <Link key={obs.id} href={`/observations/${obs.id}/review`} className="block">
                <Card className="transition-shadow hover:shadow-md">
                  <CardContent className="space-y-1.5 py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg">{child?.avatar_emoji ?? '🧒'}</span>
                      <span className="text-sm font-semibold">{child?.name ?? '未知幼儿'}</span>
                      <span className="text-xs text-slate-500">
                        {formatDateCn(obs.observed_at)}
                        {obs.context ? ` · ${obs.context}` : ''}
                      </span>
                      {obs.is_demo ? <DemoBadge /> : null}
                      <span className="ml-auto flex items-center gap-2">
                        {obs.ai_draft ? <AiBadge /> : null}
                        <StatusBadge status={obs.status} />
                      </span>
                    </div>
                    <p className="text-sm text-slate-600">{excerpt(obs.raw_text, 120)}</p>
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
