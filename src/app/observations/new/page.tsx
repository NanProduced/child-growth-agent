import type { Metadata } from 'next';

import { observationFocusFromSearch, type EvidencePageSearch } from '@/lib/guide/navigation';
import { resolveCreateObservationAccess } from '@/lib/guide/write-access';

import { NewObservationClient } from './new-observation-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '开始记录观察',
};

/**
 * 录入页（G6-WRITE1）：服务端解析当前身份与写权限，客户端只负责表单与状态。
 * 关注条目与返回上下文在服务端按白名单校验后传入，不信任原始查询串。
 */
export default async function NewObservationPage({
  searchParams,
}: {
  searchParams: Promise<EvidencePageSearch>;
}) {
  const [search, writeAccess] = await Promise.all([searchParams, resolveCreateObservationAccess()]);
  const focus = observationFocusFromSearch(search);
  return <NewObservationClient writeAccess={writeAccess} focus={focus} />;
}
