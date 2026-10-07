import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { resolveServerAuth } from '@/lib/accounts/access';
import { scopedGetChild as getChild, scopedGetObservation as getObservation, scopedListObservations } from '@/lib/accounts/scoped-queries';
import { GUIDE_CATALOG } from '@/data/guide';
import type { BasisSourceOption, GuideItemOption, GuideWriteAccessView } from '@/lib/guide/association-types';
import { listGuideItems } from '@/lib/guide/catalog';
import { observationFocusFromSearch, type EvidencePageSearch } from '@/lib/guide/navigation';
import { parseGuideEvidence } from '@/lib/guide/runtime';
import type { ObservationClassContextSnapshot } from '@/lib/guide/types';
import type { EvidenceLinkView } from '@/lib/guide/view-types';
import { buildGuideResponseLinks } from '@/lib/queries';
import { CLASS_STAGE_LABELS } from '@/lib/types';

import { ReviewClient } from './review-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '整理与确认',
};

/** 可写路径由 scopedGetObservation 决定：历史只读与管理员只读在上方提前返回，不挂载写客户端 */
const FULL_TEACHER_ACCESS: GuideWriteAccessView = {
  can_record: true,
  can_decide: true,
  can_organize: true,
  mode: 'account_teacher',
  read_only_reason: null,
};

function goalLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const domain of GUIDE_CATALOG.domains) {
    for (const subDomain of domain.sub_domains) {
      for (const goal of subDomain.goals) {
        labels[goal.id] = `${domain.name} · ${subDomain.name} · 目标${goal.index} ${goal.title}`;
      }
    }
  }
  return labels;
}

export default async function ObservationReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<EvidencePageSearch>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
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

  const focus = observationFocusFromSearch(search);
  const observationId = observation.id;
  const [items, confirmedObservations, auth] = await Promise.all([
    listGuideItems(),
    scopedListObservations({ childId: observation.child_id, status: 'confirmed' }),
    resolveServerAuth(),
  ]);
  // 稳定的页面身份：账号变化时客户端必须清空上一个身份的私人草稿
  const viewerKey =
    auth.state.kind === 'authenticated' ? auth.state.principal.account_id : 'anonymous';

  const itemOptions: GuideItemOption[] = items.map((item) => ({
    id: item.id,
    text: item.text,
    age_band: item.age_band,
    evidence_type: item.product_rules.evidence_type,
    adult_help: item.product_rules.adult_help,
    counts_in_behavior_stats: item.product_rules.counts_in_behavior_stats,
    goal_id: item.goal_id,
  }));

  function sourceOption(source: {
    id: string;
    observed_at: string;
    context: string | null;
    class_context_snapshot: ObservationClassContextSnapshot | null | undefined;
    raw_text: string;
    confirmed_content: { highlight_quote: string; highlights: string[] } | null;
    status: 'confirmed' | 'pending';
  }): BasisSourceOption {
    const snapshot = source.class_context_snapshot ?? null;
    return {
      id: source.id,
      observed_at: source.observed_at,
      context: source.context,
      class_label: snapshot ? `${snapshot.class_name} · ${CLASS_STAGE_LABELS[snapshot.stage]}` : null,
      is_host: source.id === observationId,
      raw_text: source.raw_text,
      confirmed: source.confirmed_content
        ? {
            highlight_quote: source.confirmed_content.highlight_quote,
            highlights: source.confirmed_content.highlights,
          }
        : null,
      status: source.status,
    };
  }

  const basisSources: BasisSourceOption[] = [];
  if (observation.status !== 'confirmed') {
    basisSources.push(
      sourceOption({
        id: observation.id,
        observed_at: observation.observed_at,
        context: observation.context,
        class_context_snapshot: observation.class_context_snapshot,
        raw_text: observation.raw_text,
        confirmed_content: null,
        status: 'pending',
      }),
    );
  }
  for (const source of confirmedObservations) {
    basisSources.push(
      sourceOption({
        id: source.id,
        observed_at: source.observed_at,
        context: source.context,
        class_context_snapshot: source.class_context_snapshot,
        raw_text: source.raw_text,
        confirmed_content: source.confirmed_content,
        status: 'confirmed',
      }),
    );
  }

  const parsed = parseGuideEvidence(observation.guide_evidence);
  let revision = parsed.kind === 'ok' ? parsed.revision : 0;
  let links: EvidenceLinkView[] = [];
  let detailUnavailable = parsed.kind === 'unreadable';
  try {
    const built = await buildGuideResponseLinks(observation);
    revision = built.revision;
    links = built.links;
  } catch {
    // 已保存的关联详情补查失败：如实提示，不回退成“没有关联”，也不影响手动关联
    detailUnavailable = true;
  }

  // 服务端版本戳：观察修订、状态与关联修订/详情任一变化都代表新的服务端状态
  const serverStamp = [
    observation.updated_at ?? '',
    observation.status,
    revision,
    links.length,
    detailUnavailable ? 'detail-unavailable' : 'detail-ok',
  ].join('|');

  return (
    <ReviewClient
      observation={observation}
      child={child}
      writeAccess={FULL_TEACHER_ACCESS}
      guide={{
        mode: observation.status === 'confirmed' ? 'archived' : 'pre_archive',
        revision,
        links,
        detailUnavailable,
        itemOptions,
        goalLabels: goalLabels(),
        basisSources,
        focusItemId: focus.itemId,
        focusItemUnknown: Boolean(focus.itemId && !itemOptions.some((item) => item.id === focus.itemId)),
        returnHref: focus.returnTo,
        viewerKey,
        serverStamp,
      }}
    />
  );
}
