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
}: {
  childId: string;
  hasStoredProfile: boolean;
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

  return (
    <Alert className={error ? 'border-amber-200 bg-amber-50/70' : 'border-sky-200 bg-sky-50/60'}>
      <RefreshCw className="size-4 text-sky-700" />
      <AlertTitle>{error ? '成长小结仍未更新' : '成长小结可以继续整理'}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {error ?? (hasStoredProfile
            ? '可以根据最新的已确认观察重新整理这段小结。'
            : '当前内容先根据已确认观察呈现；可以请求 Agent 生成更完整的小结。')}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleRetry()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {busy ? '正在更新…' : '重新生成成长小结'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
