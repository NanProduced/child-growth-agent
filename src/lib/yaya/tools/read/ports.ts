/**
 * TOOLS-READ1 默认端口实现：直接复用现有服务端身份与 scoped 读取边界。
 *
 * - 每次调用都重新解析当前身份/任教范围（withScopedRead / withBusinessRead），
 *   不缓存 Principal、不接受调用方自报角色或班级；
 * - 单对象读取复用 AUTH 动作（class.read / child.read / observation.read /
 *   teacher.manage+school），空任教与越权由现有链路拒绝；
 * - 静态教育参考只做“登录且账号有效”边界（authenticated_reference），
 *   有效未分配账号仍可读，但不读任何园所私域数据。
 */
import { serverRequest, withBusinessRead } from '@/lib/accounts/access';
import { loadAccountsConfig } from '@/lib/accounts/config';
import { AccountsError } from '@/lib/accounts/errors';
import { resolveRequestAuth, type HeaderCarrier } from '@/lib/accounts/guards';
import type { Principal } from '@/lib/accounts/types';
import { listTeachers } from '@/lib/accounts/repository';
import {
  scopedGetObservation,
  scopedListChildren,
  scopedListClasses,
  scopedListObservations,
} from '@/lib/accounts/scoped-queries';
import { getClassHistoryCounts, resolveClassContextAt } from '@/lib/class-context';
import { loadChildEvidenceBook, loadClassEvidenceOverview } from '@/lib/guide/read-model';
import { getChild, getClass, getClassChildren } from '@/lib/queries';

import type { YayaReadPorts } from './types';

async function requireReferenceAccess(request?: HeaderCarrier): Promise<Principal> {
  const config = loadAccountsConfig();
  if (!config) {
    throw new AccountsError('identity_unavailable', '认证服务未配置，教育参考读取已关闭。');
  }
  const auth = await resolveRequestAuth(request ?? (await serverRequest()), config);
  if (auth.state.kind === 'unavailable') {
    throw new AccountsError('identity_unavailable', '身份服务暂时不可用，请稍后重试。');
  }
  if (auth.state.kind !== 'authenticated') {
    throw new AccountsError('unauthenticated', '请先登录园所账号。');
  }
  const principal: Principal = auth.state.principal;
  if (principal.account_status !== 'active') {
    throw new AccountsError('account_disabled', '账号已停用。');
  }
  return principal;
}

/** 真实读取端口；不连数据库直到第一次调用（路由/装配可安全 import） */
export function createYayaReadPorts(): YayaReadPorts {
  return {
    listChildren: (request) => scopedListChildren(request),
    listClasses: (input, request) => scopedListClasses({ catalog: input.catalog }, request),
    getClassBundle: (classId, request) =>
      withBusinessRead(request, 'class.read', { kind: 'class', class_id: classId }, async () => {
        const klass = await getClass(classId);
        if (!klass) return null;
        return {
          klass,
          children: await getClassChildren(classId),
          history: await getClassHistoryCounts(classId),
        };
      }),
    resolveChildClass: (input, request) =>
      withBusinessRead(
        request,
        'child.read',
        { kind: 'child', child_id: input.childId },
        async () => {
          const child = await getChild(input.childId);
          if (!child) return null;
          return { child, lookup: await resolveClassContextAt(input.childId, input.observedAt) };
        },
      ),
    listObservations: (filters, request) =>
      scopedListObservations(
        { childId: filters.childId, status: filters.status, limit: filters.limit },
        request,
      ),
    getObservation: (observationId, request) => scopedGetObservation(observationId, request),
    getChildProfile: (childId, request) =>
      withBusinessRead(request, 'child.read', { kind: 'child', child_id: childId }, async () => {
        const child = await getChild(childId);
        if (!child) return null;
        return {
          child,
          growth_profile: child.growth_profile,
          activity_support: child.growth_profile?.activity_support ?? null,
        };
      }),
    loadChildEvidenceBook: (childId, query, request) =>
      withBusinessRead(request, 'child.read', { kind: 'child', child_id: childId }, () =>
        loadChildEvidenceBook(childId, query),
      ),
    loadClassEvidenceOverview: (classId, query, request) =>
      withBusinessRead(request, 'class.read', { kind: 'class', class_id: classId }, () =>
        loadClassEvidenceOverview(classId, query),
      ),
    listTeacherAccounts: (request) =>
      withBusinessRead(request, 'teacher.manage', { kind: 'school' }, () => listTeachers()),
    requireReferenceAccess: (request) => requireReferenceAccess(request),
  };
}
