import type { Metadata } from 'next';
import { CircleAlert } from 'lucide-react';
import Link from 'next/link';

import { HomepageMap } from '@/components/homepage-map';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { buildHomepageMapData, type HomepageMapData } from '@/lib/homepage-map-data';
import { listChildren, listClasses, listObservations } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '全园成长地图' };

export default async function HomePage() {
  let data: HomepageMapData | null = null;
  try {
    const [children, classes, observations] = await Promise.all([
      listChildren(), listClasses(), listObservations({ limit: 1000 }),
    ]);
    data = buildHomepageMapData(classes, children, observations);
  } catch {
    // 不把连接错误原文暴露给浏览器，避免带出数据库配置。
  }
  if (!data) {
    return (
      <section className="mx-auto max-w-2xl space-y-5 py-8">
        <h1 className="text-2xl font-semibold">全园成长地图</h1>
        <Alert>
          <CircleAlert className="size-4" />
          <AlertTitle>成长地图暂时无法加载</AlertTitle>
          <AlertDescription>数据库暂不可用，班级与观察记录尚未加载。请稍后重新加载。</AlertDescription>
        </Alert>
        <Button asChild className="min-h-11"><Link href="/">重新加载</Link></Button>
      </section>
    );
  }
  return <HomepageMap data={data} />;
}
