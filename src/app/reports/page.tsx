import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  FileText,
  Leaf,
  PenLine,
  Sparkles,
  Sprout,
} from 'lucide-react';

import { DraftView } from '@/components/draft-view';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AiBadge, DemoBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { hasCurrentActivitySupport } from '@/lib/activity-support';
import { buildGrowthProfileFallback } from '@/lib/growth-profile';
import { formatDateCn, formatDateTimeCn } from '@/lib/format';
import { listChildren, listObservations } from '@/lib/queries';
import { activitySupportSchema } from '@/lib/validation';
import type { ActivitySupport, Child, Observation, ObservationDraft } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '成长回顾',
};

type ConfirmedObservation = Observation & { confirmed_content: ObservationDraft };

function isConfirmed(observation: Observation): observation is ConfirmedObservation {
  return observation.status === 'confirmed' && observation.confirmed_content !== null;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const { child: childParam } = await searchParams;

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
  const confirmedCountOf = (childId: string) =>
    (observationsByChild.get(childId) ?? []).filter(isConfirmed).length;

  // ponytail: 没指定或指定了不存在的档案时，优先落在有已确认观察的小朋友上
  const selected =
    children.find((child) => child.id === childParam) ??
    children.find((child) => confirmedCountOf(child.id) > 0) ??
    children[0] ??
    null;

  const selectedObservations = selected ? observationsByChild.get(selected.id) ?? [] : [];
  const confirmed = selectedObservations.filter(isConfirmed).sort(
    (a, b) => b.observed_at.localeCompare(a.observed_at),
  );
  const storedProfile = selected?.growth_profile ?? null;
  const profile = storedProfile ?? buildGrowthProfileFallback(confirmed);
  const isFallback = !storedProfile;
  const profileUpdatedAt = storedProfile?.updated_at ?? null;
  const storedSupport = activitySupportSchema.safeParse(
    selected?.growth_profile?.activity_support,
  );
  const support: ActivitySupport | null =
    storedSupport.success && hasCurrentActivitySupport(storedSupport.data, selectedObservations)
      ? storedSupport.data
      : null;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">成长回顾</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          挑一个小朋友，沿已确认的观察回看这一段成长：小结、最近变化、活动支持与证据时间线。
        </p>
      </div>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : children.length === 0 || !selected ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:p-8">
            <span className="flex size-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <Sprout className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-medium text-slate-800">还没有成长档案</h2>
              <p className="mt-1 max-w-lg text-sm leading-6 text-slate-500">
                建立成长档案并确认一条观察后，这里会出现这个小朋友的成长回顾。
              </p>
            </div>
            <Button asChild>
              <Link href="/children/new">
                <PenLine className="size-4" />
                建立成长档案
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <nav aria-label="选择小朋友" className="flex flex-wrap gap-2">
            {children.map((child) => {
              const active = child.id === selected.id;
              return (
                <Link
                  key={child.id}
                  href={`/reports?child=${encodeURIComponent(child.id)}`}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
                    active
                      ? 'border-emerald-300 bg-emerald-50 font-medium text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200 hover:bg-amber-50/50'
                  }`}
                >
                  <span aria-hidden="true">{child.avatar_emoji ?? '🧒'}</span>
                  {child.name}
                  {confirmedCountOf(child.id) === 0 ? (
                    <span className="text-xs text-slate-400">待首条确认</span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <section className="rounded-2xl border bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-4">
                <span
                  className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-3xl"
                  aria-hidden="true"
                >
                  {selected.avatar_emoji ?? '🧒'}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                      {selected.name}
                    </h2>
                    <Badge variant="secondary">{selected.class_name}</Badge>
                    {selected.is_demo ? <DemoBadge /> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    <Badge
                      variant="secondary"
                      className={
                        confirmed.length > 0
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-600'
                      }
                    >
                      已确认观察 {confirmed.length} 条
                    </Badge>
                    <span className="text-xs text-slate-500">
                      {confirmed.length > 0
                        ? `最近确认：${formatDateCn(confirmed[0].confirmed_at)}`
                        : '确认一条观察后开始回顾'}
                    </span>
                  </div>
                </div>
              </div>
              <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                <Link href={`/children/${selected.id}`}>
                  查看成长档案
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            </div>
          </section>

          {confirmed.length === 0 || !profile ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-start gap-3 p-6 sm:p-8">
                <span className="flex size-11 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                  <Sprout className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="font-medium text-slate-800">还没有已确认观察</h2>
                  <p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">
                    成长回顾只依据教师确认后的观察，不会把草稿当作正式记录。确认第一条观察后，
                    这里会出现成长小结、最近变化、活动支持摘要和证据时间线。
                  </p>
                </div>
                <Button asChild size="sm">
                  <Link href={`/observations/new?child_id=${encodeURIComponent(selected.id)}`}>
                    <PenLine className="size-4" />
                    记录一次观察
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <section aria-labelledby="summary-title" className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="summary-title" className="text-base font-semibold">
                      成长小结
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">基于已确认观察更新</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {storedProfile ? <AiBadge /> : null}
                    <Badge variant="outline" className="font-normal">
                      {isFallback ? '根据现有观察呈现' : '已更新'}
                    </Badge>
                  </div>
                </div>
                <Card className="border-emerald-200 bg-emerald-50/50">
                  <CardContent className="space-y-3 p-5 sm:p-6">
                    <p className="max-w-3xl text-[15px] leading-7 text-slate-700">
                      {profile.summary}
                    </p>
                    <p className="text-xs leading-5 text-slate-500">
                      {isFallback
                        ? '已有确认观察会先在这里呈现；下一次确认后，Agent 会继续更新这段小结。'
                        : `最近更新：${formatDateTimeCn(profileUpdatedAt)}`}
                    </p>
                  </CardContent>
                </Card>
              </section>

              <section className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">最近变化</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-7 text-slate-600">{profile.recent_change}</p>
                  </CardContent>
                </Card>

                <Card className="border-emerald-100">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Leaf className="size-4 text-emerald-600" aria-hidden="true" />
                      活动支持摘要
                      <AiBadge />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {support ? (
                      <>
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
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                          <span>最近生成：{formatDateTimeCn(support.generated_at)}</span>
                          <Link
                            href={`/children/${selected.id}`}
                            className="flex items-center gap-1 font-medium text-emerald-700 hover:text-emerald-800"
                          >
                            查看完整建议
                            <ArrowUpRight className="size-3.5" aria-hidden="true" />
                          </Link>
                        </div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm leading-6 text-slate-600">
                          还没有活动支持建议。进入成长档案后，可以从这些已确认观察生成 2～3 个可试试的活动。
                        </p>
                        <Link
                          href={`/children/${selected.id}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                        >
                          去生成活动支持
                          <ArrowUpRight className="size-4" aria-hidden="true" />
                        </Link>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </section>

              <section aria-labelledby="evidence-title">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="evidence-title" className="text-base font-semibold">
                      观察证据时间线
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                      原始观察、AI 草稿与教师确认稿分开放置，展开可逐一对照
                    </p>
                  </div>
                  <span className="text-xs text-slate-500">共 {confirmed.length} 条</span>
                </div>
                <div className="relative space-y-4 border-l border-amber-200 pl-5 sm:pl-7">
                  {confirmed.map((observation) => (
                    <div key={observation.id} className="relative">
                      <span
                        className="absolute -left-[25px] top-5 size-2.5 rounded-full bg-amber-400 ring-4 ring-amber-50 sm:-left-[33px]"
                        aria-hidden="true"
                      />
                      <Card>
                        <CardContent className="space-y-3 p-4">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">{formatDateCn(observation.observed_at)}</span>
                            {observation.context ? (
                              <span className="text-xs text-slate-500">{observation.context}</span>
                            ) : null}
                            <Badge variant="outline" className="font-normal">
                              {observation.confirmed_content.domain}
                            </Badge>
                            <Badge
                              variant="secondary"
                              className="ml-auto bg-emerald-100 text-emerald-700"
                            >
                              教师确认稿
                            </Badge>
                          </div>
                          <p className="line-clamp-2 text-sm leading-6 text-slate-600">
                            {observation.confirmed_content.objective_description}
                          </p>

                          <details className="group rounded-lg border border-slate-100 bg-slate-50/60">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-slate-600">
                              <span>展开原始观察与确认稿</span>
                              <ChevronDown
                                className="size-4 shrink-0 transition-transform group-open:rotate-180"
                                aria-hidden="true"
                              />
                            </summary>
                            <div className="space-y-3 border-t border-slate-100 p-3">
                              <div className="rounded-lg bg-white p-3">
                                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                                  <FileText className="size-3.5 text-emerald-700" aria-hidden="true" />
                                  原始观察（保存后不可修改）
                                </div>
                                <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700">
                                  {observation.raw_text}
                                </p>
                              </div>

                              {observation.ai_draft ? (
                                <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3">
                                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
                                    <Sparkles className="size-3.5 text-violet-500" aria-hidden="true" />
                                    AI 草稿（确认前版本，仅供追溯）
                                    <AiBadge />
                                  </div>
                                  <DraftView draft={observation.ai_draft} />
                                </div>
                              ) : null}

                              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
                                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-emerald-700">
                                  <BadgeCheck className="size-3.5" aria-hidden="true" />
                                  教师确认稿（已进入正册）
                                  <span className="font-normal text-slate-500">
                                    {formatDateTimeCn(observation.confirmed_at)}
                                  </span>
                                </div>
                                <DraftView draft={observation.confirmed_content} />
                              </div>
                            </div>
                          </details>

                          <div className="flex justify-end">
                            <Link
                              href={`/observations/${observation.id}/review`}
                              className="flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800"
                            >
                              打开这条记录
                              <ArrowUpRight className="size-3.5" aria-hidden="true" />
                            </Link>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
