import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getChild, getObservation } from '@/lib/queries';
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
  const child = await getChild(observation.child_id);
  if (!child) notFound();

  return <ReviewClient observation={observation} child={child} />;
}
