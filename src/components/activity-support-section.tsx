'use client';

import { useState } from 'react';
import { Leaf, Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTeacher } from '@/components/teacher-provider';
import { fetchWithAccountAuth } from "@/lib/accounts/client";
import type { ActivitySupport } from '@/lib/types';

type ActivitySupportSectionProps = {
  childId: string;
  confirmedObservationCount: number;
  initialSupport: ActivitySupport | null;
  /** 已保存建议的来源观察已过期：提示需要更新，不冒充最新依据 */
  hasStaleSupport?: boolean;
  /** 只读查看（管理员）：可完整阅读已有建议，隐藏生成/重生成/重试等教学写控件 */
  readOnly?: boolean;
};

function ActivitySupportCard({ support }: { support: ActivitySupport['suggestions'][number] }) {
  return (
    <Card className="min-w-0 border-emerald-100 bg-white">
      <CardHeader className="space-y-2 pb-3">
        <CardTitle className="break-words text-base leading-6">{support.title}</CardTitle>
        <CardDescription className="break-words leading-6">{support.purpose}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-6">
        <div>
          <h3 className="mb-1 font-medium text-slate-700">可以这样做</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-slate-600">
            {support.steps.map((step, index) => (
              <li key={`${step}-${index}`} className="break-words pl-1">
                {step}
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-lg bg-emerald-50/70 px-3 py-2.5">
          <h3 className="mb-1 flex items-center gap-1.5 font-medium text-emerald-800">
            <Leaf className="size-3.5" aria-hidden="true" />
            继续观察
          </h3>
          <p className="break-words text-emerald-900/80">{support.observe}</p>
        </div>

        <details className="group rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center font-medium text-slate-600 group-open:mb-2">
            <span className="group-open:hidden">材料与调整方式</span>
            <span className="hidden group-open:inline">收起材料与调整方式</span>
          </summary>
          <div className="space-y-3 text-slate-600">
            <div>
              <h3 className="mb-1 text-xs font-medium text-slate-500">材料</h3>
              {support.materials.length > 0 ? (
                <p className="break-words">{support.materials.join('、')}</p>
              ) : (
                <p>不需要额外材料</p>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium text-slate-500">根据反应调整</h3>
              <p className="break-words">{support.adaptation}</p>
            </div>
          </div>
        </details>

        <div className="border-t border-slate-100 pt-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-500">
            <Badge variant="outline" className="font-normal text-slate-500">
              依据
            </Badge>
            已确认观察线索
          </div>
          <ul className="space-y-1 text-xs leading-5 text-slate-500">
            {support.evidence.map((evidence, index) => (
              <li key={`${evidence}-${index}`} className="break-words">
                {evidence}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingCards() {
  return (
    <div className="grid gap-4 md:grid-cols-3" aria-label="正在生成活动支持" aria-busy="true">
      {[0, 1, 2].map((item) => (
        <Card key={item} className="border-emerald-100">
          <CardContent className="space-y-4 p-5">
            <div className="h-5 w-2/3 animate-pulse rounded bg-emerald-100" />
            <div className="space-y-2">
              <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="h-24 animate-pulse rounded-lg bg-slate-50" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ActivitySupportSection({
  childId,
  confirmedObservationCount,
  initialSupport,
  hasStaleSupport = false,
  readOnly = false,
}: ActivitySupportSectionProps) {
  const { loading: authLoading, configured, isTeacher } = useTeacher();
  const [support, setSupport] = useState<ActivitySupport | null>(initialSupport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teacherReady = configured && isTeacher;

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetchWithAccountAuth(`/api/children/${encodeURIComponent(childId)}/activity-support`, {
        method: 'POST',
      });
      const data = (await response.json().catch(() => ({}))) as {
        activitySupport?: ActivitySupport | null;
        message?: string;
      };
      if (!response.ok || !data.activitySupport) {
        throw new Error(data.message ?? '生成活动支持失败，请稍后重试');
      }
      setSupport(data.activitySupport);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成活动支持失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="activity-support-title" className="space-y-3" data-testid="activity-support-section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="activity-support-title" className="text-base font-semibold">
              活动支持
            </h2>
            <Badge variant="outline" className="font-normal text-emerald-700">
              少量建议
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            {readOnly
              ? '教师从已确认观察和成长小结整理的建议，可在这里查看步骤、材料与依据。'
              : '从已确认观察和成长小结出发，给下一次活动一个可以试试的方向。'}
          </p>
        </div>
        {!readOnly && confirmedObservationCount > 0 ? (
          <Button
            type="button"
            variant={support ? 'outline' : 'default'}
            size="sm"
            className="w-full sm:w-auto"
            disabled={busy || authLoading || !teacherReady}
            onClick={() => void handleGenerate()}
            title={!teacherReady && !authLoading ? '请先进入园所账号' : undefined}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : support ? <RefreshCw className="size-4" /> : <Sparkles className="size-4" />}
            {busy ? '正在生成…' : support ? '重新生成' : '生成活动支持'}
          </Button>
        ) : null}
      </div>

      {confirmedObservationCount === 0 ? (
        <Card className="border-dashed border-emerald-200 bg-emerald-50/30">
          <CardContent className="flex items-start gap-3 p-5 sm:p-6">
            <Leaf className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden="true" />
            <div>
              <h3 className="font-medium text-slate-800">{readOnly ? '还没有活动支持建议' : '先确认一条观察'}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {readOnly
                  ? '活动支持由教师从已确认观察生成；生成后可以在这里查看完整建议与依据。'
                  : '活动支持只会读取教师确认后的观察，不会把草稿或待补充内容当成事实。'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : busy && !support ? (
        <LoadingCards />
      ) : support ? (
        <>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>最新建议暂未生成</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>{error}，当前仍保留上一次建议。</span>
                {readOnly ? null : (
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleGenerate()} disabled={busy || !teacherReady}>
                    再试一次
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="grid min-w-0 gap-4 md:grid-cols-3">
            {support.suggestions.map((suggestion) => (
              <ActivitySupportCard key={suggestion.title} support={suggestion} />
            ))}
          </div>
          <p className="text-xs leading-5 text-slate-500" aria-live="polite">
            {busy ? '正在用最新的已确认观察重新整理建议…' : '建议已随成长档案保存，可按现场情况灵活调整。'}
          </p>
        </>
      ) : error ? (
        <Alert variant="destructive">
          <AlertTitle>活动支持暂未生成</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            {readOnly ? null : (
              <Button type="button" variant="outline" size="sm" onClick={() => void handleGenerate()} disabled={busy || !teacherReady}>
                再试一次
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <Card className="border-emerald-100 bg-emerald-50/20">
          <CardContent className="flex flex-col items-start gap-3 p-5 sm:p-6">
            <Sparkles className="size-5 text-emerald-600" aria-hidden="true" />
            <div>
              <h3 className="font-medium text-slate-800">
                {hasStaleSupport ? '活动支持建议需要更新' : '还没有活动支持建议'}
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {readOnly
                  ? hasStaleSupport
                    ? '已确认观察有更新，上一次建议基于较早的观察；请由教师重新生成后查看最新依据。'
                    : '暂时还没有可查看的活动支持。生成活动支持由教师在成长档案中完成。'
                  : hasStaleSupport
                    ? '已确认观察有更新，上一次建议基于较早的观察；可以重新生成，旧建议不会冒充最新依据。'
                    : authLoading
                      ? '正在确认教师身份…'
                      : teacherReady
                        ? '点击“生成活动支持”，从已确认观察中整理 2～3 个可试试的活动。'
                        : configured
                          ? '进入园所账号后，可以从已确认观察生成活动支持。'
                          : '当前未配置教师口令，暂时不能生成活动支持。'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
