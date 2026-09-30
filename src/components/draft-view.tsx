import { Quote } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { ObservationDraft } from '@/lib/types';

/** 只读展示一张观察分析卡片（AI 草稿与教师确认稿共用结构） */
export function DraftView({ draft }: { draft: ObservationDraft }) {
  return (
    <div className="space-y-4 text-sm leading-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-violet-100 text-violet-700">{draft.domain}</Badge>
        <Badge variant="outline">{draft.sub_domain}</Badge>
      </div>
      <div>
        <div className="mb-1 font-medium text-slate-700">发展表现说明</div>
        <p className="text-slate-600">{draft.objective_description}</p>
      </div>
      <div>
        <div className="mb-1 font-medium text-slate-700">发展亮点</div>
        <ul className="list-disc space-y-1 pl-5 text-slate-600">
          {draft.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1 font-medium text-slate-700">支持建议</div>
        <ul className="list-decimal space-y-1 pl-5 text-slate-600">
          {draft.support_suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      {draft.highlight_quote ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-amber-900">
          <Quote className="mb-1 inline size-3.5 text-amber-500" /> {draft.highlight_quote}
        </div>
      ) : null}
      {draft.teacher_note ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
          <span className="font-medium">教师备注：</span>
          {draft.teacher_note}
        </div>
      ) : null}
    </div>
  );
}
