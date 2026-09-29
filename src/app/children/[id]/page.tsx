import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardCheck,
  FlaskConical,
  HeartPulse,
  Languages,
  Palette,
  PenLine,
  Users,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AiBadge, DemoBadge, StatusBadge } from '@/components/status-badges';
import { ageText, excerpt, formatDateCn } from '@/lib/format';
import { getChild, listObservations } from '@/lib/queries';
import { FIVE_DOMAINS, type Child, type Observation } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '幼儿档案详情',
};

type Domain = (typeof FIVE_DOMAINS)[number];

const DOMAIN_META: Record<
  Domain,
  { icon: typeof HeartPulse; hint: string }
> = {
  健康: { icon: HeartPulse, hint: '身体动作、生活习惯与自我照料' },
  语言: { icon: Languages, hint: '表达、倾听与交流' },
  社会: { icon: Users, hint: '同伴交往、规则与情绪表达' },
  科学: { icon: FlaskConical, hint: '发现、提问与探索' },
  艺术: { icon: Palette, hint: '感受、表现与创造' },
};

function isDomain(value: string): value is Domain {
  return (FIVE_DOMAINS as readonly string[]).includes(value);
}

export default async function ChildDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let child: Child | null = null;
  let dbError: string | null = null;
  try {
    child = await getChild(id);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
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
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!child) notFound();

  let observations: Observation[] = [];
  try {
    observations = await listObservations({ childId: id });
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
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
  const domainObservations = new Map<Domain, Observation[]>();
  for (const observation of confirmedObservations) {
    const domain = observation.confirmed_content?.domain;
    if (!domain || !isDomain(domain)) continue;
    const records = domainObservations.get(domain) ?? [];
    records.push(observation);
    domainObservations.set(domain, records);
  }
  const latestConfirmed = confirmedObservations[0];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/children">
          <ArrowLeft className="size-4" />
          返回档案列表
        </Link>
      </Button>

      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-5 p-6">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-amber-100 text-4xl">
              {child.avatar_emoji ?? '🧒'}
            </span>
            <div className="min-w-0">
              <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                {child.name}
                <Badge variant="outline" className="font-normal">
                  {child.gender}
                </Badge>
                <Badge variant="secondary">{child.class_name}</Badge>
                {child.is_demo ? <DemoBadge /> : null}
              </CardTitle>
              <p className="mt-1 text-sm text-slate-500">
                出生日期 {formatDateCn(child.birth_date)} · 当前 {ageText(child.birth_date)}
              </p>
              {child.note ? (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{child.note}</p>
              ) : null}
            </div>
          </div>
          <Button asChild size="lg" className="shrink-0">
            <Link href={`/observations/new?child_id=${encodeURIComponent(child.id)}`}>
              <PenLine className="size-4" />
              记录一次观察
            </Link>
          </Button>
        </CardContent>
      </Card>

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">五大领域发展线索</h2>
            <p className="mt-1 text-xs text-slate-500">仅显示教师已确认的观察证据</p>
          </div>
          <span className="text-xs text-slate-500">已确认 {confirmedObservations.length} 条</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {FIVE_DOMAINS.map((domain) => {
            const records = domainObservations.get(domain) ?? [];
            const latest = records[0];
            const Icon = DOMAIN_META[domain].icon;
            const content = latest?.confirmed_content;
            const summary = content?.objective_description || content?.highlight_quote;

            return (
              <Card key={domain} className="h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <CardTitle className="text-base">{domain}</CardTitle>
                  </div>
                  <p className="text-xs text-slate-500">
                    {records.length > 0 ? `已确认 ${records.length} 条观察` : '正在了解'}
                  </p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {latest ? (
                    <>
                      <p className="text-xs text-slate-500">
                        最近观察：{formatDateCn(latest.observed_at)}
                      </p>
                      <p className="line-clamp-3 text-sm leading-6 text-slate-600">
                        {excerpt(summary || latest.raw_text, 88)}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm leading-6 text-slate-500">
                      {DOMAIN_META[domain].hint}，等待新的观察记录。
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.6fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="size-4 text-amber-600" />
              最近变化
            </CardTitle>
          </CardHeader>
          <CardContent>
            {latestConfirmed ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{formatDateCn(latestConfirmed.observed_at)}</span>
                  {latestConfirmed.context ? (
                    <span className="text-xs text-slate-500">{latestConfirmed.context}</span>
                  ) : null}
                  <StatusBadge status={latestConfirmed.status} />
                </div>
                <p className="text-sm leading-6 text-slate-600">
                  {excerpt(
                    latestConfirmed.confirmed_content?.objective_description ||
                      latestConfirmed.confirmed_content?.highlight_quote ||
                      latestConfirmed.raw_text,
                    140,
                  )}
                </p>
              </div>
            ) : (
              <p className="text-sm leading-6 text-slate-500">
                {observations.length > 0
                  ? `当前已有 ${observations.length} 条观察，教师确认后会在这里呈现。`
                  : '还没有已确认的观察，记录一次具体行为就能开始积累。'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">档案小结</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            <p>已确认观察 {confirmedObservations.length} 条</p>
            <p>覆盖领域 {domainObservations.size} / {FIVE_DOMAINS.length}</p>
            <p className="text-xs leading-5 text-slate-500">
              这里记录的是教师确认过的观察证据，不做分数或等级评价。
            </p>
          </CardContent>
        </Card>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">观察时间线（{observations.length}）</h2>
            <p className="mt-1 text-xs text-slate-500">原文保留，点击记录可进入查看与确认</p>
          </div>
          {observations.length > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/observations/new?child_id=${encodeURIComponent(child.id)}`}>
                <PenLine className="size-4" />
                再记一条
              </Link>
            </Button>
          ) : null}
        </div>
        {observations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                <ClipboardCheck className="size-5" />
              </span>
              <div>
                <h3 className="font-medium">还没有观察记录</h3>
                <p className="mt-1 text-sm text-slate-500">
                  从一次具体行为开始，逐步形成这个孩子的观察档案。
                </p>
              </div>
              <Button asChild>
                <Link href={`/observations/new?child_id=${encodeURIComponent(child.id)}`}>
                  <PenLine className="size-4" />
                  记录一次观察
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {observations.map((obs) => (
              <Link key={obs.id} href={`/observations/${obs.id}/review`} className="block">
                <Card className="transition-shadow hover:shadow-md">
                  <CardContent className="space-y-1.5 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{formatDateCn(obs.observed_at)}</span>
                      {obs.context ? (
                        <span className="text-xs text-slate-500">{obs.context}</span>
                      ) : null}
                      {obs.confirmed_content?.domain ? (
                        <Badge variant="outline" className="font-normal">
                          {obs.confirmed_content.domain}
                        </Badge>
                      ) : null}
                      <span className="ml-auto flex items-center gap-2">
                        {obs.ai_draft ? <AiBadge /> : null}
                        <StatusBadge status={obs.status} />
                      </span>
                    </div>
                    <p className="text-sm text-slate-600">{excerpt(obs.raw_text, 100)}</p>
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
