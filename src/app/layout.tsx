import type { Metadata } from 'next';
import './globals.css';
import '@/components/home-v2/home-fonts.css';
import { Toaster } from '@/components/ui/sonner';
import { TeacherProvider } from '@/components/teacher-provider';
import { TopNav } from '@/components/top-nav';
import { resolveServerAuth } from '@/lib/accounts/access';

export const metadata: Metadata = {
  title: {
    default: '芽芽观察',
    template: '%s | 芽芽观察',
  },
  description:
    '面向幼儿园教师的轻量成长观察应用：记录事实、确认观察、持续回看。',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const resolved = await resolveServerAuth();
  const initial = { state: resolved.state, session: resolved.session, csrf: resolved.csrf };
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-background antialiased">
        <TeacherProvider initial={initial}>
          <TopNav />
          <main className="mx-auto w-full max-w-[1536px] px-4 pb-16 pt-6 sm:px-6 lg:px-10">{children}</main>
        </TeacherProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
