# 幼儿成长观察与活动支持智能体（child-growth-agent）

面向幼儿园教师的观察记录智能体：教师录入观察原文 → 真实 AI（国产大模型）整理为结构化分析卡片 → 教师核对确认后归档 → 刷新后数据仍可查看。基于 [Next.js 16](https://nextjs.org) + [shadcn/ui](https://ui.shadcn.com) + 内置 PostgreSQL（Supabase PostgREST）+ coze-coding-dev-sdk LLM，由扣子编程 CLI 创建。

## 第一阶段范围（当前实现）

- **核心链路**：录入观察 → 保存原文（不可改写）→ 真实 AI 整理 → 教师确认 → 刷新后仍可查看。
- **页面**：工作台 `/`、幼儿档案 `/children`、档案详情 `/children/[id]`、观察列表 `/observations`、录入观察 `/observations/new`、整理与确认 `/observations/[id]/review`；活动计划与报告中心为下一阶段预留（建设中页）。
- **AI 任务**：观察整理（`doubao-seed-2-0-lite-260215`，服务端调用，输出结构化五大领域卡片；产出一律标注「AI 生成」，仅为草稿）。AI 失败可重试；已确认记录禁止 AI 再改写。
- **数据追溯**：`raw_text` 原文保存后永不修改；`ai_draft`（AI 草稿）与 `confirmed_content`（教师确认稿）分字段保存，可对照追溯。
- **演示数据**：内置 6 名合成幼儿与 3 条示例观察，全部标注「合成数据」，不含真实幼儿信息。

## 最小访问控制

- 口令来自服务端环境变量 `TEACHER_PASSCODE`（见 `.env.example`），不进前端代码、不落库。
- 访客只读：档案与观察记录可浏览；**所有写操作与 AI 调用**（新增幼儿、录入观察、AI 整理、确认归档）都在服务端 `requireTeacher()` 校验 httpOnly 签名 Cookie（HMAC-SHA256，7 天有效），前端状态不作为权限依据。
- 未配置口令时，写接口与 AI 接口一律返回 503（默认禁用）；不开放公众注册，无通用默认密码。
- 更换口令后所有旧会话立即失效（签名密钥随口令变化）。

## 数据库

- 表结构事实源：`src/storage/database/shared/schema.ts`（`children`、`observations`）。CRUD 通过 `@supabase/supabase-js`（PostgREST）在服务端完成。
- RLS：本项目不使用 Supabase Auth，两表启用 RLS 并按场景 A（公开读写策略）放行，鉴权由应用层 `requireTeacher()` 承担。
- 注意：本机 pnpm 环境下 `coze-coding-ai db generate-models / upgrade`（drizzle-kit）存在 npm 模块解析问题；首次建表 DDL 已通过平台 SQL 通道执行，与 `schema.ts` 严格一致。云端环境可直接使用 `db upgrade`。

## 快速开始

### 配置教师口令

```bash
cp .env.example .env   # 然后在 .env 中填写 TEACHER_PASSCODE=<你的口令>
```

### 启动开发服务器

```bash
coze-dev dev
```

启动后，在浏览器中打开 [http://localhost:5000](http://localhost:5000) 查看应用。

开发服务器支持热更新，修改代码后页面会自动刷新。

### 静态检查

```bash
coze-dev validate
```

### 构建生产版本

```bash
coze-dev build
```

### 启动生产服务器

```bash
coze-dev start
```

## 项目结构

```
src/
├── app/                      # Next.js App Router 目录
│   ├── layout.tsx           # 根布局组件
│   ├── page.tsx             # 首页
│   ├── globals.css          # 全局样式（包含 shadcn 主题变量）
│   └── [route]/             # 其他路由页面
├── components/              # React 组件目录
│   └── ui/                  # shadcn/ui 基础组件（优先使用）
│       ├── button.tsx
│       ├── card.tsx
│       └── ...
├── lib/                     # 工具函数库
│   └── utils.ts            # cn() 等工具函数
└── hooks/                   # 自定义 React Hooks（可选）

server/
├── index.ts                 # 自定义服务器入口
├── tsconfig.json           # Server TypeScript 配置
└── dist/                    # 编译输出目录（自动生成）
```

## 核心开发规范

### 1. 组件开发

**优先使用 shadcn/ui 基础组件**

本项目已预装完整的 shadcn/ui 组件库，位于 `src/components/ui/` 目录。开发时应优先使用这些组件作为基础：

```tsx
// ✅ 推荐：使用 shadcn 基础组件
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function MyComponent() {
  return (
    <Card>
      <CardHeader>标题</CardHeader>
      <CardContent>
        <Input placeholder="输入内容" />
        <Button>提交</Button>
      </CardContent>
    </Card>
  );
}
```

**可用的 shadcn 组件清单**

- 表单：`button`, `input`, `textarea`, `select`, `checkbox`, `radio-group`, `switch`, `slider`
- 布局：`card`, `separator`, `tabs`, `accordion`, `collapsible`, `scroll-area`
- 反馈：`alert`, `alert-dialog`, `dialog`, `toast`, `sonner`, `progress`
- 导航：`dropdown-menu`, `menubar`, `navigation-menu`, `context-menu`
- 数据展示：`table`, `avatar`, `badge`, `hover-card`, `tooltip`, `popover`
- 其他：`calendar`, `command`, `carousel`, `resizable`, `sidebar`

详见 `src/components/ui/` 目录下的具体组件实现。

### 2. 路由开发

Next.js 使用文件系统路由，在 `src/app/` 目录下创建文件夹即可添加路由：

```bash
# 创建新路由 /about
src/app/about/page.tsx

# 创建动态路由 /posts/[id]
src/app/posts/[id]/page.tsx

# 创建路由组（不影响 URL）
src/app/(marketing)/about/page.tsx

# 创建 API 路由
src/app/api/users/route.ts
```

**页面组件示例**

```tsx
// src/app/about/page.tsx
import { Button } from '@/components/ui/button';

export const metadata = {
  title: '关于我们',
  description: '关于页面描述',
};

export default function AboutPage() {
  return (
    <div>
      <h1>关于我们</h1>
      <Button>了解更多</Button>
    </div>
  );
}
```

**动态路由示例**

```tsx
// src/app/posts/[id]/page.tsx
export default async function PostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <div>文章 ID: {id}</div>;
}
```

**API 路由示例**

```tsx
// src/app/api/users/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ users: [] });
}

export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json({ success: true });
}
```

### 3. 依赖管理

**必须使用 pnpm 管理依赖**

```bash
# ✅ 安装依赖
pnpm install

# ✅ 添加新依赖
pnpm add package-name

# ✅ 添加开发依赖
pnpm add -D package-name

# ❌ 禁止使用 npm 或 yarn
# npm install  # 错误！
# yarn add     # 错误！
```

项目已配置 `preinstall` 脚本，使用其他包管理器会报错。

### 4. 样式开发

**使用 Tailwind CSS v4**

本项目使用 Tailwind CSS v4 进行样式开发，并已配置 shadcn 主题变量。

```tsx
// 使用 Tailwind 类名
<div className="flex items-center gap-4 p-4 rounded-lg bg-background">
  <Button className="bg-primary text-primary-foreground">
    主要按钮
  </Button>
</div>

// 使用 cn() 工具函数合并类名
import { cn } from '@/lib/utils';

<div className={cn(
  "base-class",
  condition && "conditional-class",
  className
)}>
  内容
</div>
```

**主题变量**

主题变量定义在 `src/app/globals.css` 中，支持亮色/暗色模式：

- `--background`, `--foreground`
- `--primary`, `--primary-foreground`
- `--secondary`, `--secondary-foreground`
- `--muted`, `--muted-foreground`
- `--accent`, `--accent-foreground`
- `--destructive`, `--destructive-foreground`
- `--border`, `--input`, `--ring`

### 5. 表单开发

推荐使用 `react-hook-form` + `zod` 进行表单开发：

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const formSchema = z.object({
  username: z.string().min(2, '用户名至少 2 个字符'),
  email: z.string().email('请输入有效的邮箱'),
});

export default function MyForm() {
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: { username: '', email: '' },
  });

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    console.log(data);
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <Input {...form.register('username')} />
      <Input {...form.register('email')} />
      <Button type="submit">提交</Button>
    </form>
  );
}
```

### 6. 数据获取

**服务端组件（推荐）**

```tsx
// src/app/posts/page.tsx
async function getPosts() {
  const res = await fetch('https://api.example.com/posts', {
    cache: 'no-store', // 或 'force-cache'
  });
  return res.json();
}

export default async function PostsPage() {
  const posts = await getPosts();

  return (
    <div>
      {posts.map(post => (
        <div key={post.id}>{post.title}</div>
      ))}
    </div>
  );
}
```

**客户端组件**

```tsx
'use client';

import { useEffect, useState } from 'react';

export default function ClientComponent() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch('/api/data')
      .then(res => res.json())
      .then(setData);
  }, []);

  return <div>{JSON.stringify(data)}</div>;
}
```

## 常见开发场景

### 添加新页面

1. 在 `src/app/` 下创建文件夹和 `page.tsx`
2. 使用 shadcn 组件构建 UI
3. 根据需要添加 `layout.tsx` 和 `loading.tsx`

### 创建业务组件

1. 在 `src/components/` 下创建组件文件（非 UI 组件）
2. 优先组合使用 `src/components/ui/` 中的基础组件
3. 使用 TypeScript 定义 Props 类型

### 添加全局状态

推荐使用 React Context 或 Zustand：

```tsx
// src/lib/store.ts
import { create } from 'zustand';

interface Store {
  count: number;
  increment: () => void;
}

export const useStore = create<Store>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));
```

### 集成数据库

推荐使用 Prisma 或 Drizzle ORM，在 `src/lib/db.ts` 中配置。

## 技术栈

- **框架**: Next.js 16.1.1 (App Router)
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **样式**: Tailwind CSS v4
- **表单**: React Hook Form + Zod
- **图标**: Lucide React
- **字体**: Geist Sans & Geist Mono
- **包管理器**: pnpm 9+
- **TypeScript**: 5.x

## 参考文档

- [Next.js 官方文档](https://nextjs.org/docs)
- [shadcn/ui 组件文档](https://ui.shadcn.com)
- [Tailwind CSS 文档](https://tailwindcss.com/docs)
- [React Hook Form](https://react-hook-form.com)

## 重要提示

1. **必须使用 pnpm** 作为包管理器
2. **优先使用 shadcn/ui 组件** 而不是从零开发基础组件
3. **遵循 Next.js App Router 规范**，正确区分服务端/客户端组件
4. **使用 TypeScript** 进行类型安全开发
5. **使用 `@/` 路径别名** 导入模块（已配置）

## 云盘源码与本地开发

Vite、Next.js、Nuxt 的 Unix 开发脚本在 `COZE_DRIVE_ROOT`（默认 `/Coze/Drive`）内通过
`scripts/local-workspace.cjs` 将源码用 `rsync` 同步到本机临时目录。系统需提供 Node.js、pnpm、bash 和 rsync。
所有开发与修复仍在云盘源码目录完成，从该目录执行 `.coze` 的 `[dev]` 命令。

- `prepare.sh` 同步并在本地安装依赖；安装成功且云盘依赖输入未变化时，仅将更新的锁文件回写云盘。
- `dev.sh` 在本地镜像运行开发服务，每轮 rsync 结束后等待一秒再同步，框架监听本地文件进行热更新。
  同步失败或依赖输入变化时停止服务；修复后重新运行 `prepare.sh` / `dev.sh`。
- `validate.sh` 使用独立的本地 `check` 目录，避免类型生成影响正在运行的 `dev` 服务。
- 同步排除 `.git`、`node_modules`、日志和框架输出；不要在镜像修复源码或将依赖、编译产物回传云盘。
  日志和 PID 默认保留在源码目录的 `logs/`，实际镜像路径见脚本输出。

本地镜像仅用于 `[dev].build/run/validate`。部署配置、`build.sh`、`start.sh` 保持原流程；
普通本地目录和 Windows PowerShell 入口也保持原流程。
存量项目通过新版 CLI 的 `coze-dev patch --dry-run` / `coze-dev patch` 升级，沿用 patch 总开关。
仅升级完整匹配旧模板的三个 Unix 开发脚本并保留端口；自定义开发脚本、命令或同名 helper 会跳过。
