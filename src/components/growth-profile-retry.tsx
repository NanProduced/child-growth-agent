'use client';

import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTeacher } from '@/components/teacher-provider';
import { fetchWithAccountAuth } from "@/lib/accounts/client";

export function GrowthProfileRetry({
  childId,
  hasStoredProfile,
  isCurrent = false,
}: {
  childId: string;
  hasStoredProfile: boolean;
  isCurrent?: boolean;
}) {
  const router = useRouter();
  const { loading: authLoading, configured, isTeacher } = useTeacher();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (authLoading || !configured || !isTeacher) return null;

  async function handleRetry() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetchWithAccountAuth(`/api/children/${encodeURIComponent(childId)}/growth-profile`, {
        method: 'POST',
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? '成长小结暂未更新，请稍后重试');
      toast.success('成长小结已更新');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '成长小结暂未更新，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  if (isCurrent) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-3">
        {error ? <p role="alert" className="text-sm text-amber-800">{error}</p> : null}
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void handleRetry()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
          {busy ? '正在整理…' : '重新整理成长小结'}
        </Button>
      </div>
    );
  }

  return (
    <Alert className={error ? 'border-amber-200 bg-amber-50/70' : 'border-sky-200 bg-sky-50/60'}>
      <RefreshCw className="size-4 text-sky-700" />
      <AlertTitle>{error ? '小结暂未更新' : hasStoredProfile ? '小结待更新' : '小结尚未整理'}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {error ?? (hasStoredProfile
            ? '可根据当前已确认的观察重新整理。'
            : '当前是观察摘要，可请芽芽整理成小结。')}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleRetry()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {busy ? '正在整理…' : hasStoredProfile ? '更新成长小结' : '整理成长小结'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
