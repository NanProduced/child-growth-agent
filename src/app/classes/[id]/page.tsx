import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
  Eye,
  PenLine,
  UserPlus,
} from 'lucide-react';

import { ClassFormDialog } from '@/components/class-dialogs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AiBadge, DemoBadge, StatusBadge } from '@/components/status-badges';
import { ageText, excerpt, formatDateCn } from '@/lib/format';
import { getClass, getClassChildren, listObservations } from '@/lib/queries';
import {
  CLASS_STAGE_LABELS,
  type Child,
  type Observation,
  type SchoolClass,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '班级详情',
};

function SectionTitle({ title, hint, extra }: { title: string; hint?: string; extra?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </div>
      {extra}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed p-4 text-sm text-slate-500">{text}</p>;
}

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let klass: SchoolClass | null = null;
  let dbError: string | null = null;
  try {
    klass = await getClass(id);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  if (dbError) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/classes">
            <ArrowLeft className="size-4" />
            返回班级列表
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!klass) notFound();

  let children: Child[] = [];
  let allObservations: Observation[] = [];
  try {
    [children, allObservations] = await Promise.all([
      getClassChildren(id),
      listObservations({ limit: 1000 }),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  const observations = allObservations.filter((observation) => observation.class_id === id);
  const pending = observations.filter((observation) => observation.status !== 'confirmed');
  const recent = observations.slice(0, 6);
  const confirmedCount = observations.length - pending.length;
  const clues = observations
    .filter(
      (observation) => observation.status === 'confirmed' && observation.confirmed_content,
    )
    .slice(0, 6);
  const latest = observations[0];

  return (
    <div className="space-y-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/classes">
          <ArrowLeft className="size-4" />
          返回班级列表
        </Link>
      </Button>

      <section className="rounded-2xl border bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">{klass.name}</h1>
              <Badge variant="secondary">{CLASS_STAGE_LABELS[klass.stage]}</Badge>
              <Badge variant="outline" className="font-normal text-slate-600">
                {klass.school_year}
              </Badge>
              {!klass.is_active ? (
                <Badge
                  variant="outline"
                  className="border-slate-300 bg-slate-50 font-normal text-slate-500"
                >
                  已停用
                </Badge>
              ) : null}
            </div>
            <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600">
              <div className="flex items-center gap-1.5">
                <dt className="text-slate-400">儿童</dt>
                <dd>{children.length} 人</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-slate-400">已确认</dt>
                <dd className="text-emerald-700">{confirmedCount} 条</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-slate-400">待处理</dt>
                <dd className="text-amber-700">{pending.length} 条</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-slate-400">最近观察</dt>
                <dd>{latest ? formatDateCn(latest.observed_at) : '暂无'}</dd>
              </div>
            </dl>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href="/observations/new">
                <PenLine className="size-4" />
                开始记录观察
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/children/new">
                <UserPlus className="size-4" />
                建立成长档案
              </Link>
            </Button>
            <ClassFormDialog klass={klass} label="编辑班级" />
          </div>
        </div>
      </section>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>班级数据暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section>
            <SectionTitle
              title="儿童名单"
              hint="点击儿童可进入成长档案"
              extra={
                <span className="text-xs text-slate-500">
                  共 {children.length} 人
                </span>
              }
            />
            {children.length === 0 ? (
              <EmptyHint text="这个班级还没有儿童，可以先建立成长档案并分班。" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {children.map((child) => (
                  <Link key={child.id} href={`/children/${child.id}`} className="group min-w-0">
                    <Card className="h-full transition-colors group-hover:border-amber-300">
                      <CardContent className="flex items-center gap-3 p-4">
                        <span
                          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-100 text-2xl"
                          aria-hidden="true"
                        >
                          {child.avatar_emoji ?? '🧒'}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-slate-900">{child.name}</span>
                            {child.is_demo ? <DemoBadge /> : null}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">{ageText(child.birth_date)}</p>
                        </div>
                        <ArrowUpRight
                          className="ml-auto size-4 shrink-0 text-slate-400 transition-colors group-hover:text-amber-700"
                          aria-hidden="true"
                        />
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionTitle title="最近观察" hint="按保存时间倒序，点击进入整理与确认" />
            {recent.length === 0 ? (
              <EmptyHint text="班级还没有观察记录，从一次具体行为开始记录。" />
            ) : (
              <div className="relative space-y-3 border-l border-amber-200 pl-5 sm:pl-6">
                {recent.map((observation) => {
                  const child = children.find((c) => c.id === observation.child_id);
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
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-lg" aria-hidden="true">
                          {child?.avatar_emoji ?? '🧒'}
                        </span>
                        <span className="font-medium text-slate-800">
                          {child?.name ?? '未知幼儿'}
                        </span>
                        <span className="text-xs text-slate-500">
                          {formatDateCn(observation.observed_at)}
                          {observation.context ? ` · ${observation.context}` : ''}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {observation.ai_draft ? <AiBadge /> : null}
                          <StatusBadge status={observation.status} />
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                        {excerpt(observation.raw_text, 120)}
                      </p>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <SectionTitle
              title="待确认记录"
              hint="AI 已整理、待补充或待判断的记录会集中在这里"
              extra={
                <span className="text-xs text-slate-500">{pending.length} 条</span>
              }
            />
            {pending.length === 0 ? (
              <EmptyHint text="没有待处理的记录，班级观察都已确认归档。" />
            ) : (
              <div className="space-y-3">
                {pending.slice(0, 10).map((observation) => {
                  const child = children.find((c) => c.id === observation.child_id);
                  return (
                    <Link
                      key={observation.id}
                      href={`/observations/${observation.id}/review`}
                      className="group flex items-start gap-3 rounded-xl border bg-white p-4 transition-colors hover:border-amber-300 hover:bg-amber-50/20"
                    >
                      <span className="text-lg" aria-hidden="true">
                        {child?.avatar_emoji ?? '🧒'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium text-slate-800">
                            {child?.name ?? '未知幼儿'}
                          </span>
                          <span className="text-xs text-slate-500">
                            {formatDateCn(observation.observed_at)}
                          </span>
                          <StatusBadge status={observation.status} />
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-slate-600">
                          {excerpt(observation.raw_text, 100)}
                        </p>
                      </div>
                      <ArrowUpRight
                        className="mt-1 size-4 shrink-0 text-slate-400 transition-colors group-hover:text-amber-700"
                        aria-hidden="true"
                      />
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <Card className="border-emerald-200/80 bg-emerald-50/40">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Eye className="size-4 text-emerald-700" aria-hidden="true" />
                  班级近期观察线索
                </CardTitle>
              </CardHeader>
              <CardContent>
                {clues.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    确认观察后，这里会呈现班级里最近被记录到的发展亮点。
                  </p>
                ) : (
                  <ul className="space-y-3 text-sm leading-6 text-slate-600">
                    {clues.map((observation) => {
                      const child = children.find((c) => c.id === observation.child_id);
                      const highlight =
                        observation.confirmed_content?.highlights[0] ??
                        observation.confirmed_content?.objective_description;
                      return (
                        <li key={observation.id} className="flex gap-2">
                          <span
                            className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-400"
                            aria-hidden="true"
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-slate-700">
                              {child?.name ?? '未知幼儿'}
                            </span>
                            <span className="ml-2 text-xs text-slate-400">
                              {formatDateCn(observation.observed_at)}
                            </span>
                            <span className="mt-0.5 block">{highlight}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
