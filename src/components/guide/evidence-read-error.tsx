import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function EvidenceReadError({ backHref, retryHref, resetHref, message }: {
  backHref: string; retryHref: string; resetHref?: string; message: string;
}) {
  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTitle>证据资料暂不可读</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-3">
        <Button asChild className="min-h-11"><Link href={retryHref}>重新读取</Link></Button>
        {resetHref ? <Button asChild variant="outline" className="min-h-11"><Link href={resetHref}>查看全部历史</Link></Button> : null}
        <Button asChild variant="outline" className="min-h-11"><Link href={backHref}>返回详情</Link></Button>
      </div>
    </div>
  );
}
