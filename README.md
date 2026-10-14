# 芽芽观察

面向幼儿园教师的成长观察与活动支持智能体。

芽芽观察把教师在一日生活、区域活动、户外活动和集体活动中记录下来的真实行为，整理成可追溯的发展性观察记录，并在教师确认后沉淀为成长档案和后续支持依据。

线上演示：<https://childgrowth.coze.site>

> 产品不是幼儿测评、打分或排名系统。AI 负责整理、提问和提供支持建议，教师始终保留核对、修改和确认权。

## 产品主线

```text
教师登录与班级授权 → 建立成长档案 / 录入观察 → 保存原文
→ AI 整理草稿 → 教师修改与确认 → 指南证据与成长档案
→ 活动支持 / 家园沟通 / 芽芽自然语言助手
```

核心原则：先记录事实，再形成理解；AI 提供支持，教师保留判断；关注发展过程，不给幼儿打分。

## 主要功能

| 模块 | 用途 |
| --- | --- |
| 工作台与账号权限 | 园所账号登录、教师任教班级范围、管理员班级与教师管理 |
| 成长档案与观察记录 | 录入情境、日期和原始观察，完成 AI 整理、教师修改和确认归档 |
| 指南证据 | 将观察关联到健康、语言、社会、科学、艺术五大领域的具体表现条目 |
| 班级证据概览 | 用人数分布和证据状态查看班级情况，不把统计结果当作能力评分 |
| 活动与成长支持 | 基于已确认观察生成发展性支持建议，并保留依据和教师判断 |
| 家园沟通 | 按时间范围选择已确认记录，生成教师核对后分享给家长的文字 |
| 芽芽智能体 | 用自然语言查询业务信息；涉及写入时先形成提案并等待教师批准 |
| 图片与附件 | 校验、去 EXIF、生成缩略图和模型图，再进入授权分析链路 |

## 可信记录边界

- `raw_text` 是教师原始观察，保存后不可改写。
- AI 草稿、教师修改稿和教师确认稿分开保存；未确认内容不会直接进入正式成长档案。
- 指南年龄段是参考范围，不是统一达标期限。
- 正式证据状态只有“暂无相关记录”“已有相关线索”“已确认观察到”。
- 持续性表现需要跨日事实或明确期间依据，不使用“自动满三次即掌握”等规则。
- 数据损坏、来源失效或权限不可核验时显示不可用，不伪造 0%、成功或空数据。
- 不生成医疗、心理诊断，不对幼儿评分、排名或贴能力等级标签。
- 演示数据使用合成记录；源码、日志、截图和视频不得包含密码、Cookie、连接串或对象存储签名 URL。

## 技术架构

```text
Next.js App Router / React UI
        ↓
页面与 API Route Handlers
        ↓
业务服务、指南证据读写模型、芽芽 Agent Engine
        ↓
权限边界、事务型 Repository / Port
        ↓
PostgreSQL 直连 + Coze/StepFun LLM + 媒体对象存储
```

技术栈：Next.js 16.1、React 19、TypeScript 5、shadcn/ui、Radix UI、Tailwind CSS 4、Assistant UI、Recharts、`pg`、`sharp`、`coze-coding-dev-sdk` 和 pnpm 9+。

生产环境使用扣子平台注入的运行时身份和对象存储配置；本地开发不得复制平台凭证，也不得把 API Key、数据库连接串或口令提交到仓库。

## 数据库与迁移

数据库通过 `pg` 直连，数据访问集中在 `src/lib` 与 `src/storage/database`。迁移脚本位于 `scripts/`，覆盖基础业务表、班级历史、成长支持、账号授权、指南证据、芽芽运行记录、聊天绑定、家园沟通和附件元数据。

生产执行迁移前必须先完成备份、隔离库重复执行、schema 指纹核对和回滚兼容性核验；不要在生产运行演示 reset 脚本。

## 快速开始

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Windows 也可以使用：

```powershell
pwsh scripts/dev.ps1
```

常用变量见 `.env.example`：`DATABASE_URL`、`AUTH_TRUSTED_ORIGINS`、`AUTH_SCHOOL_ID`、`LLM_PROVIDER`、StepFun 配置和本地媒体配置。旧的 `TEACHER_PASSCODE` 不作为新版账号授权机制；生产账号、数据库和平台身份由部署流程配置。

## 代码结构

```text
src/app/                    # 页面与 API Route Handlers
src/components/             # 页面业务组件
src/components/ui/          # shadcn/ui 基础组件
src/lib/guide/              # 指南目录、证据读模型与决定规则
src/lib/yaya/               # 芽芽 Agent、数据投影、工具和协议
src/lib/media/              # 图片上传、内容读取和保留策略
src/lib/accounts/           # 账号、会话与班级范围授权
src/storage/database/       # PostgreSQL 连接与共享 schema
scripts/                    # 构建、迁移、验收与安全检查
docs/                       # 产品契约、设计、交付和验收证据
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

本项目使用 `pg` 直连 PostgreSQL；请复用 `src/storage/database/pg-client.ts` 与现有 Repository，不要在页面组件中直接拼接数据库连接或引入第二套数据访问层。

## 技术栈补充

- **模型与平台**：`coze-coding-dev-sdk`、Coze provider、StepFun provider
- **媒体**：`sharp`、本地对象存储、扣子平台 S3Storage 适配
- **数据可视化**：Recharts + shadcn chart primitives
- **表单与校验**：React Hook Form、Zod
- **图标与交互**：Lucide React、Radix UI

## 参考文档

- [Next.js 官方文档](https://nextjs.org/docs)
- [shadcn/ui 组件文档](https://ui.shadcn.com)
- [Tailwind CSS 文档](https://tailwindcss.com/docs)
- [React Hook Form](https://react-hook-form.com)
- [产品上下文与术语](PRODUCT.md)
- [视觉与交互规范](DESIGN.md)
- [指南证据契约](docs/guide-evidence-v1/contract.md)
- [芽芽设计与交互资料](docs/design/yaya-v1/README.md)
- [家园沟通交付记录](docs/family-communication-v1-delivery.md)
- [平台 UI/UX 评审证据](docs/platform-review/)

## 重要提示

1. **必须使用 pnpm** 作为包管理器。
2. **优先复用 shadcn/ui、现有业务服务和端口**，不要重复实现授权、媒体或事务逻辑。
3. **遵循 Next.js App Router 规范**，正确区分服务端/客户端组件，避免 hydration 问题。
4. **使用 TypeScript 严格类型**，不要提交 `any`、凭证或生产数据。
5. **涉及 AI、写入和附件的改动必须补充失败、权限、空数据和恢复路径检查**。

## 参赛材料准备原则

江西省教育厅指南要求 AI 创新应用案例同时说明应用文字材料、推进过程与成效的数字故事、以及支撑成果材料；开发过程需要能说明平台/技术选择、提示词、知识结构、交互逻辑或关键代码，并突出“可复现”。

建议围绕一条教师工作故事准备材料：

```text
真实观察输入 → AI 整理草稿 → 教师确认 → 指南证据与成长档案
→ 班级/个体回看 → 活动支持或家园分享 → 芽芽自然语言查询
```

提交包应明确区分“已实现”“隔离环境验收”“线上演示可见”和“尚未运行”，所有截图、录屏和样例数据使用合成数据，不编造效率提升或教育效果数字。

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
