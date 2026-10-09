import type { Metadata } from 'next';
import { AccountsError } from '@/lib/accounts/errors';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardCheck,
  Eye,
  Lightbulb,
  PenLine,
  Sprout,
} from 'lucide-react';

import { ActivitySupportSection } from '@/components/activity-support-section';
import { TransferClassDialog } from '@/components/class-dialogs';
import { GrowthProfileRetry } from '@/components/growth-profile-retry';
import { ReadFailureNotice, readFailureKind } from '@/components/read-failure-notice';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badges';
import {
  ageText,
  classLabel,
  excerpt,
  formatDateCn,
  formatDateTimeCn,
  schoolClassLabel,
} from '@/lib/format';
import { hasCurrentActivitySupport } from '@/lib/activity-support';
import { buildGrowthProfileFallback } from '@/lib/growth-profile';
import { resolveServerAuth } from '@/lib/accounts/access';
import { scopedGetChild as getChild, scopedListClasses as listClasses, scopedListEnrollments as listEnrollments, scopedListObservations as listObservations } from '@/lib/accounts/scoped-queries';
import { evidenceEntryQuery } from '@/lib/guide/navigation';
import type {
  Child,
  ChildClassEnrollment,
  GrowthProfileDraft,
  Observation,
  SchoolClass,
} from '@/lib/types';
import { activitySupportSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '成长档案详情',
};

function ProfileCard({
  title,
  icon,
  children,
  className,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function GrowthProfileSections({
  profile,
  updatedAt,
  isFallback,
}: {
  profile: GrowthProfileDraft;
  updatedAt: string | null;
  isFallback: boolean;
}) {
  return (
    <>
      <section aria-labelledby="growth-summary-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="growth-summary-title" className="text-base font-semibold">
              成长小结
            </h2>
            <p className="mt-1 text-xs text-slate-500">来自教师已确认的观察</p>
          </div>
          <Badge variant="outline" className="font-normal">
            {isFallback ? '观察摘要' : '已更新'}
          </Badge>
        </div>
        <Card className="border-emerald-200 bg-emerald-50/50">
          <CardContent className="space-y-3 p-5 sm:p-6">
            <p className="max-w-3xl text-base leading-7 text-slate-700">{profile.summary}</p>
            {!isFallback ? <p className="text-xs leading-5 text-slate-500">最近更新：{formatDateTimeCn(updatedAt)}</p> : null}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <ProfileCard
          title="最近变化"
          icon={<ClipboardCheck className="size-4 text-amber-600" aria-hidden="true" />}
        >
          <p className="text-sm leading-7 text-slate-600">{profile.recent_change}</p>
        </ProfileCard>

        <ProfileCard
          title="观察到的线索"
          icon={<Eye className="size-4 text-sky-600" aria-hidden="true" />}
        >
          <ul className="space-y-2 text-sm leading-6 text-slate-600">
            {profile.development_clues.map((clue, index) => (
              <li key={`${clue}-${index}`} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-sky-400" aria-hidden="true" />
                <span>{clue}</span>
              </li>
            ))}
          </ul>
        </ProfileCard>
      </section>

      <section aria-labelledby="next-support-title">
        <div className="space-y-4 rounded-2xl border border-sky-200 bg-sky-50/50 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Lightbulb className="size-4 text-emerald-600" aria-hidden="true" />
            <h2 id="next-support-title" className="text-base font-semibold text-slate-900">下一步支持</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-white/80 p-4">
              <p className="text-xs font-medium text-emerald-700">可以试试</p>
              <p className="mt-2 text-sm leading-7 text-slate-600">{profile.next_support}</p>
            </div>
            <div className="rounded-xl bg-white/80 p-4">
              <p className="text-xs font-medium text-sky-700">继续观察</p>
              <p className="mt-2 text-sm leading-7 text-slate-600">{profile.next_focus}</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export default async function ChildDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await resolveServerAuth();
  if (auth.state.kind !== 'authenticated') {
    return <ReadFailureNotice kind={auth.state.kind === 'unavailable' ? 'unavailable' : 'login'} what="成长档案" retryHref={`/children/${encodeURIComponent(id)}`} />;
  }
  // UI projection only: the server re-authorizes every read and write.
  const isAdmin = auth.state.principal.role === 'admin';
  let child: Child | null = null;
  let dbError: string | null = null;
  try {
    child = await getChild(id);
  } catch (e) {
    if (e instanceof AccountsError) {
      if (e.code === 'not_found') notFound();
      return <ReadFailureNotice kind={readFailureKind(e)} what="成长档案" retryHref={`/children/${encodeURIComponent(id)}`} />;
    }
    dbError = '成长档案暂时无法加载，请稍后重试。';
  }

  if (dbError) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/children">
            <ArrowLeft className="size-4" />
            返回档案列表
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>成长档案暂时无法查看</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!child) notFound();

  let observations: Observation[] = [];
  let enrollments: ChildClassEnrollment[] = [];
  let classes: SchoolClass[] = [];
  try {
    [observations, enrollments, classes] = await Promise.all([
      listObservations({ childId: id }),
      listEnrollments(id),
      listClasses(),
    ]);
  } catch (e) {
    if (e instanceof AccountsError) {
      if (e.code === 'not_found') notFound();
      return <ReadFailureNotice kind={readFailureKind(e)} what="成长档案的观察与班级轨迹" retryHref={`/children/${encodeURIComponent(id)}`} />;
    }
    dbError = '观察与班级记录暂时无法加载，请稍后重试。';
  }

  if (dbError) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/children">
            <ArrowLeft className="size-4" />
            返回档案列表
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>观察记录暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const confirmedObservations = observations.filter(
    (observation) => observation.status === 'confirmed' && observation.confirmed_content,
  );
  const fallbackProfile = buildGrowthProfileFallback(confirmedObservations);
  const profile = child.growth_profile ?? fallbackProfile;
  const isFallback =
    child.growth_profile?.is_fallback === true ||
    (!child.growth_profile && Boolean(fallbackProfile));
  const profileObservationIds = child.growth_profile?.source_observation_ids ?? [];
  const profileIsCurrent = Boolean(
    child.growth_profile &&
      profileObservationIds.length === confirmedObservations.length &&
      confirmedObservations.every((observation) => profileObservationIds.includes(observation.id)),
  );
  const storedActivitySupport = activitySupportSchema.safeParse(
    child.growth_profile?.activity_support,
  );
  const activitySupport =
    storedActivitySupport.success &&
    hasCurrentActivitySupport(storedActivitySupport.data, confirmedObservations)
      ? storedActivitySupport.data
      : null;
  const hasStaleActivitySupport = Boolean(
    storedActivitySupport.success && storedActivitySupport.data && !activitySupport,
  );

  return (
    <div data-platform-surface="child-detail" className="space-y-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/children">
          <ArrowLeft className="size-4" />
          返回档案列表
        </Link>
      </Button>

      <section className="rounded-2xl border bg-white p-5 sm:p-6">
        <div className="flex flex-col flex-wrap gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4 sm:basis-[20rem] sm:flex-1">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-amber-100 text-4xl">
              {child.avatar_emoji ?? '🧒'}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight text-slate-900">{child.name}</h1>
                <Badge variant="outline" className="font-normal">
                  {child.gender}
                </Badge>
                <Badge variant="secondary">
                  {classLabel(child.class_stage, child.class_name) ?? '未分班'}
                </Badge>
                {child.current_class ? (
                  <Link
                    href={`/classes/${child.current_class.id}`}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center text-sm text-emerald-700 hover:text-emerald-800"
                  >
                    查看班级
                  </Link>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-slate-500">
                出生日期 {formatDateCn(child.birth_date)} · 当前 {ageText(child.birth_date)}
              </p>
              {child.note ? (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{child.note}</p>
              ) : null}
            </div>
          </div>
          <div className="flex min-w-0 max-w-full shrink-0 flex-wrap gap-2">
            {!isAdmin ? <Button asChild variant="outline"><Link href={`/family-communication?child=${encodeURIComponent(child.id)}`}>家园沟通</Link></Button> : null}
            <Button asChild variant="outline" className="min-h-11">
              <Link href={`/children/${encodeURIComponent(child.id)}/evidence?${evidenceEntryQuery(child.class_stage)}`}>
                查看指南证据册
              </Link>
            </Button>
            {isAdmin ? <TransferClassDialog child={child} classes={classes} /> : null}
            {isAdmin ? null : (
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link href={`/observations/new?child_id=${encodeURIComponent(child.id)}`}>
                  <PenLine className="size-4" />
                  记录一次观察
                </Link>
              </Button>
            )}
          </div>
        </div>
      </section>

      <section aria-label="观察概览" className="grid grid-cols-2 divide-x divide-y divide-slate-200/80 border-y border-slate-200/80 sm:grid-cols-3 sm:divide-y-0">
        <div className="px-3 py-3 sm:px-4">
          <p className="text-xs text-slate-500">已确认观察</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{confirmedObservations.length} 条</p>
        </div>
        <div className="px-3 py-3 sm:px-4">
          <p className="text-xs text-slate-500">最近记录</p>
          <p className="mt-1 text-sm font-medium text-slate-800">
            {observations[0] ? formatDateCn(observations[0].observed_at) : '还没有记录'}
          </p>
        </div>
        <div className="col-span-2 px-3 py-3 sm:col-span-1 sm:px-4">
          <p className="text-xs text-slate-500">当前班级</p>
          <p className="mt-1 text-sm font-medium text-slate-800 [overflow-wrap:anywhere]">
            {classLabel(child.class_stage, child.class_name) ?? '暂未分班'}
          </p>
        </div>
      </section>

      {enrollments.length > 1 ? (
        <section className="rounded-xl border bg-white p-4 sm:p-5" aria-labelledby="class-trail-title">
          <h2 id="class-trail-title" className="text-sm font-medium text-slate-700">
            成长轨迹 · 班级
          </h2>
          <ul className="mt-3 space-y-2">
            {enrollments.map((enrollment) => {
              const klass = classes.find((c) => c.id === enrollment.class_id);
              const isCurrent = !enrollment.end_date;
              return (
                <li key={enrollment.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${isCurrent ? 'bg-emerald-500' : 'bg-amber-300'}`}
                    aria-hidden="true"
                  />
                  <span>
                    {formatDateCn(enrollment.start_date)} 至{' '}
                    {enrollment.end_date ? formatDateCn(enrollment.end_date) : '今'}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className={isCurrent ? 'font-medium text-slate-800' : ''}>
                    {classLabel(klass?.stage ?? null, klass?.name ?? enrollment.class_id)}
                    {isCurrent ? '（当前）' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {profile ? (
        <GrowthProfileSections
          profile={profile}
          updatedAt={child.growth_profile?.updated_at ?? null}
          isFallback={isFallback}
        />
      ) : (
        <Card className="border-dashed border-emerald-200 bg-emerald-50/40">
          <CardContent className="flex flex-col items-start gap-3 p-5 sm:p-6">
            <Sprout className="size-6 text-emerald-600" aria-hidden="true" />
            <div>
              <h2 className="font-semibold text-slate-800">成长小结</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                确认一条观察后，可以在这里回顾。
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {confirmedObservations.length > 0 && !profileIsCurrent ? (
        <GrowthProfileRetry childId={child.id} hasStoredProfile={Boolean(child.growth_profile)} />
      ) : null}

      <ActivitySupportSection
        childId={child.id}
        confirmedObservationCount={confirmedObservations.length}
        initialSupport={activitySupport}
        hasStaleSupport={hasStaleActivitySupport}
        readOnly={isAdmin}
      />

      <section aria-labelledby="observation-timeline-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="observation-timeline-title" className="text-base font-semibold">
              观察证据时间线
            </h2>
            <p className="mt-1 text-xs text-slate-500">打开记录，查看原文和确认稿。</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">共 {observations.length} 条</span>
            {!isAdmin && observations.length > 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/observations/new?child_id=${encodeURIComponent(child.id)}`}>
                  <PenLine className="size-4" />
                  再记一条
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
        {observations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                <ClipboardCheck className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="font-medium">还没有观察记录</h3>
                <p className="mt-1 text-sm text-slate-500">
                  {isAdmin
                    ? '教师记录观察后，会显示在这里。'
                    : '记录幼儿的具体行为或原话。'}
                </p>
              </div>
              {isAdmin ? null : (
                <Button asChild>
                  <Link href={`/observations/new?child_id=${encodeURIComponent(child.id)}`}>
                    <PenLine className="size-4" />
                    记录一次观察
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="relative space-y-4 border-l border-amber-200 pl-5 sm:pl-7">
            {observations.map((obs) => (
              <Link
                key={obs.id}
                href={`/observations/${obs.id}/review`}
                className="group relative block"
              >
                <span
                  className="absolute -left-[25px] top-5 size-2.5 rounded-full bg-amber-400 ring-4 ring-amber-50 transition-colors group-hover:bg-emerald-500 sm:-left-[33px]"
                  aria-hidden="true"
                />
                <Card className="transition-colors group-hover:border-amber-300">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{formatDateCn(obs.observed_at)}</span>
                      {obs.context ? <span className="text-xs text-slate-500">{obs.context}</span> : null}
                      {obs.observed_class && obs.class_id !== child.class_id ? (
                        <span className="text-xs text-slate-500">
                          当时在 {schoolClassLabel(obs.observed_class)}
                        </span>
                      ) : null}
                      {obs.confirmed_content?.domain ? (
                        <Badge variant="outline" className="font-normal">
                          {obs.confirmed_content.domain}
                        </Badge>
                      ) : null}
                      <span className="ml-auto flex items-center gap-2">
                        <StatusBadge status={obs.status} />
                      </span>
                    </div>
                    <p className="text-sm leading-6 text-slate-600">{excerpt(obs.raw_text, 120)}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
