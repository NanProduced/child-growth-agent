import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  FileText,
  PenLine,
  Sparkles,
  Sprout,
} from 'lucide-react';

import { DraftView } from '@/components/draft-view';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AiBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { hasCurrentActivitySupport } from '@/lib/activity-support';
import { buildGrowthProfileFallback } from '@/lib/growth-profile';
import { ageText, classLabel, formatDateCn, formatDateTimeCn } from '@/lib/format';
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
  // 空状态入口只做视图选择：先待确认，再待补充，再草稿；都没有则去记录
  const pendingTarget =
    selectedObservations.find((observation) => observation.status === 'ai_organized') ??
    selectedObservations.find((observation) => observation.status === 'needs_input') ??
    selectedObservations.find((observation) => observation.status === 'draft') ??
    null;
  const pendingEntry: { label: string; href: string } = pendingTarget
    ? {
        label: pendingTarget.status === 'ai_organized' ? '先确认一条观察' : '继续整理观察',
        href: `/observations/${pendingTarget.id}/review`,
      }
    : {
        label: '记录一次观察',
        href: selected
          ? `/observations/new?child_id=${encodeURIComponent(selected.id)}`
          : '/observations/new',
      };
  const storedProfile = selected?.growth_profile ?? null;
  const profile = storedProfile ?? buildGrowthProfileFallback(confirmed);
  const isFallback = !storedProfile || storedProfile.is_fallback === true;
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
          挑一个小朋友，沿已确认的观察回看这一段成长：小结、最近变化、线索、活动支持与证据时间线。
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
          <nav
            aria-label="选择小朋友"
            className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm"
          >
            <span className="mr-1 text-xs text-slate-500">选择小朋友</span>
            {children.map((child) => {
              const active = child.id === selected.id;
              const count = confirmedCountOf(child.id);
              return (
                <Link
                  key={child.id}
                  href={`/reports?child=${encodeURIComponent(child.id)}`}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 underline-offset-4 ${
                    active
                      ? 'font-semibold text-emerald-800 underline decoration-emerald-500 decoration-2'
                      : 'text-slate-600 hover:text-slate-900 hover:underline'
                  }`}
                >
                  <span aria-hidden="true">{child.avatar_emoji ?? '🧒'}</span>
                  <span className="min-w-0 break-words">{child.name}</span>
                  {count === 0 ? (
                    <span className="text-xs font-normal text-slate-400">待首条确认</span>
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
                    <h2 className="min-w-0 break-words text-lg font-semibold tracking-tight text-slate-900">
                      {selected.name}
                    </h2>
                    <Badge variant="secondary">
                      {classLabel(selected.class_stage, selected.class_name) ?? '未分班'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-500">{ageText(selected.birth_date)}</p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm" className="min-h-11 w-full sm:w-auto">
                <Link href={`/children/${selected.id}`}>
                  查看成长档案
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-4">
              <div className="min-w-0">
                <dt className="text-xs text-slate-500">已确认观察</dt>
                <dd className="mt-1 text-sm font-medium text-slate-800">{confirmed.length} 条</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-slate-500">最近确认</dt>
                <dd className="mt-1 text-sm font-medium text-slate-800">
                  {confirmed.length > 0 ? formatDateCn(confirmed[0].confirmed_at) : '还没有'}
                </dd>
              </div>
            </dl>
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
                    这里会出现成长小结、最近变化、观察到的线索、活动支持摘要和证据时间线。
                  </p>
                </div>
                <Button asChild size="sm" className="min-h-11">
                  <Link href={pendingEntry.href}>
                    <PenLine className="size-4" />
                    {pendingEntry.label}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <section aria-labelledby="summary-title">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="summary-title" className="text-base font-semibold">
                      成长小结
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">基于已确认观察更新</p>
                  </div>
                  <Badge variant="outline" className="font-normal">
                    {isFallback ? '根据现有观察呈现' : '已更新'}
                  </Badge>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 sm:p-6">
                  <p className="max-w-3xl break-words text-base leading-7 text-slate-700">
                    {profile.summary}
                  </p>
                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    {isFallback
                      ? '已有确认观察会先在这里呈现；下一次确认后，Agent 会继续更新这段小结。'
                      : `最近更新：${formatDateTimeCn(profileUpdatedAt)}`}
                  </p>
                </div>
              </section>

              <section
                aria-labelledby="change-title"
                className="border-t border-slate-200/80 pt-5"
              >
                <h2 id="change-title" className="text-base font-semibold">
                  最近变化
                </h2>
                <p className="mt-2 max-w-3xl break-words text-sm leading-7 text-slate-600">
                  {profile.recent_change}
                </p>
              </section>

              <section
                aria-labelledby="clues-title"
                className="border-t border-slate-200/80 pt-5"
              >
                <h2 id="clues-title" className="text-base font-semibold">
                  观察到的线索
                </h2>
                {profile.development_clues.length === 0 ? (
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    继续记录并确认观察后，这里会积累这个小朋友的发展线索。
                  </p>
                ) : (
                  <ul className="mt-2 max-w-3xl space-y-2 text-sm leading-6 text-slate-600">
                    {profile.development_clues.map((clue, index) => (
                      <li key={`${clue}-${index}`} className="flex gap-2">
                        <span
                          className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-400"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 break-words">{clue}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                aria-labelledby="support-title"
                className="border-t border-slate-200/80 pt-5"
              >
                <div className="mb-3">
                  <h2 id="support-title" className="text-base font-semibold">
                    活动支持摘要
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    从已确认观察整理，可在成长档案里重新生成
                  </p>
                </div>
                {support ? (
                  <div className="space-y-3">
                    <ul className="divide-y divide-slate-200/80 border-y border-slate-200/80">
                      {support.suggestions.map((suggestion) => (
                        <li key={suggestion.title} className="min-w-0 px-2 py-3 sm:px-3">
                          <p className="break-words text-sm font-medium leading-6 text-slate-800">
                            {suggestion.title}
                          </p>
                          <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-slate-500">
                            {suggestion.purpose}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <span>最近生成：{formatDateTimeCn(support.generated_at)}</span>
                      <Link
                        href={`/children/${selected.id}`}
                        className="inline-flex min-h-11 items-center gap-1 font-medium text-emerald-700 hover:text-emerald-800"
                      >
                        查看完整建议
                        <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-xl text-sm leading-6 text-slate-600">
                      还没有活动支持建议。进入成长档案后，可以从这些已确认观察生成 2～3 个可试试的活动。
                    </p>
                    <Link
                      href={`/children/${selected.id}`}
                      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                    >
                      去生成活动支持
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </Link>
                  </div>
                )}
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
                      <div className="min-w-0 rounded-xl border border-slate-200/80 bg-white p-4">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">
                            {formatDateCn(observation.observed_at)}
                          </span>
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
                        <p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-slate-600">
                          {observation.confirmed_content.objective_description}
                        </p>

                        <details className="group mt-3 rounded-lg border border-slate-100 bg-slate-50/60">
                          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-slate-600">
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
                              <p className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">
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

                        <div className="mt-2 flex justify-end">
                          <Link
                            href={`/observations/${observation.id}/review`}
                            className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800"
                          >
                            打开这条记录
                            <ArrowUpRight className="size-3.5" aria-hidden="true" />
                          </Link>
                        </div>
                      </div>
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
