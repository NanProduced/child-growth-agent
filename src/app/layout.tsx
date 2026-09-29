import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { TeacherProvider } from '@/components/teacher-provider';
import { TopNav } from '@/components/top-nav';

export const metadata: Metadata = {
  title: {
    default: '幼儿成长观察与活动支持智能体',
    template: '%s | 幼儿成长观察',
  },
  description:
    '面向幼儿园教师：观察录入 → AI 整理 → 教师确认 → 阶段回顾与活动建议。AI 产出仅作草稿，教师确认为准。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-amber-50/40 antialiased">
        <TeacherProvider>
          <TopNav />
          <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6">{children}</main>
        </TeacherProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
