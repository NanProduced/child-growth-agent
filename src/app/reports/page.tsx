import { Construction, FileBarChart2 } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata = {
  title: '报告中心',
};

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">报告中心</h1>
        <p className="mt-1 text-sm text-slate-600">
          汇总每个幼儿的发展观察，生成阶段回顾报告供教师查阅与导出。
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileBarChart2 className="size-5 text-amber-600" />
            下一阶段上线
          </CardTitle>
          <CardDescription className="flex items-start gap-2">
            <Construction className="mt-0.5 size-4 shrink-0" />
            阶段回顾报告、班级发展概览与导出能力将在第二阶段开放，敬请期待。
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          计划中的能力：按幼儿/时间段汇总已确认观察 → AI 起草阶段回顾（标注 AI 生成）→
          教师修订确认 → 支持打印与导出。
        </CardContent>
      </Card>
    </div>
  );
}
