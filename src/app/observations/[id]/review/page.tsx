import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { scopedGetChild as getChild, scopedGetObservation as getObservation } from '@/lib/accounts/scoped-queries';
import { ReviewClient } from './review-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '整理与确认',
};

export default async function ObservationReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const observation = await getObservation(id);
  if (!observation) notFound();
  if (!observation.can_write) {
    return (
      <div className="space-y-4">
        <p>{observation.access_projection === 'historical_read_only' ? '原班历史观察 · 只读回看' : '观察记录 · 管理员只读'}</p>
        <p className="whitespace-pre-wrap">{observation.raw_text}</p>
        {observation.confirmed_content ? <p>{observation.confirmed_content.objective_description}</p> : null}
      </div>
    );
  }
  const child = await getChild(observation.child_id);
  if (!child) notFound();

  return <ReviewClient observation={observation} child={child} />;
}
