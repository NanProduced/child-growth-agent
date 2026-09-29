import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { TeacherProvider } from '@/components/teacher-provider';
import { TopNav } from '@/components/top-nav';

export const metadata: Metadata = {
  title: {
    default: '芽芽观察',
    template: '%s | 芽芽观察',
  },
  description:
    '面向幼儿园教师的轻量成长观察应用：记录事实、确认观察、持续回看。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-amber-50/50 antialiased">
        <TeacherProvider>
          <TopNav />
          <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6">{children}</main>
        </TeacherProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
