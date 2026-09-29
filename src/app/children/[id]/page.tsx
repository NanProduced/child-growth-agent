import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AiBadge, DemoBadge, StatusBadge } from '@/components/status-badges';
import { ageText, excerpt, formatDateCn } from '@/lib/format';
import { getChild, listObservations } from '@/lib/queries';
import type { Observation } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '幼儿档案详情',
};

export default async function ChildDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const child = await getChild(id);
  if (!child) notFound();

  let observations: Observation[] = [];
  try {
    observations = await listObservations({ childId: id });
  } catch {
    observations = [];
  }

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/children">
          <ArrowLeft className="size-4" />
          返回档案列表
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <span className="text-4xl">{child.avatar_emoji ?? '🧒'}</span>
            <div>
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
            </div>
          </div>
        </CardHeader>
        {child.note ? (
          <CardContent>
            <p className="text-sm leading-6 text-slate-600">{child.note}</p>
          </CardContent>
        ) : null}
      </Card>

      <section>
        <h2 className="mb-3 text-base font-semibold">观察时间线（{observations.length}）</h2>
        {observations.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-slate-500">
              还没有该幼儿的观察记录。
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
