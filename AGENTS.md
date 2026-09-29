# 项目上下文

### 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
│   ├── build.sh            # 构建脚本
│   ├── dev.sh              # 开发环境启动脚本
│   ├── prepare.sh          # 预处理脚本
│   └── start.sh            # 生产环境启动脚本
├── src/
│   ├── app/                # 页面路由与布局
│   ├── components/ui/      # Shadcn UI 组件库
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/                # 工具库
│   │   └── utils.ts        # 通用工具函数 (cn)
│   └── server.ts           # 自定义服务端入口
├── next.config.ts          # Next.js 配置
├── package.json            # 项目依赖管理
└── tsconfig.json           # TypeScript 配置
```

- 项目文件（如 app 目录、pages 目录、components 等）默认初始化到 `src/` 目录下。

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

## 开发规范

### 编码规范

- 默认按 TypeScript `strict` 心智写代码；优先复用当前作用域已声明的变量、函数、类型和导入，禁止引用未声明标识符或拼错变量名。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值、解构项、事件对象、`catch` 错误在使用前应有明确类型或先完成类型收窄，并清理未使用的变量和导入。

### next.config 配置规范

- 配置的路径不要写死绝对路径，必须使用 path.resolve(__dirname, ...)、import.meta.dirname 或 process.cwd() 动态拼接。

### Hydration 问题防范

1. 严禁在 JSX 渲染逻辑中直接使用 typeof window、Date.now()、Math.random() 等动态数据。**必须使用 'use client' 并配合 useEffect + useState 确保动态内容仅在客户端挂载后渲染**；同时严禁非法 HTML 嵌套（如 <p> 嵌套 <div>）。
2. **禁止使用 head 标签**，优先使用 metadata，详见文档：https://nextjs.org/docs/app/api-reference/functions/generate-metadata
   1. 三方 CSS、字体等资源可在 `globals.css` 中顶部通过 `@import` 引入或使用 next/font
   2. preload, preconnect, dns-prefetch 通过 ReactDOM 的 preload、preconnect、dns-prefetch 方法引入
   3. json-ld 可阅读 https://nextjs.org/docs/app/guides/json-ld

## UI 设计与组件规范 (UI & Styling Standards)

- 模板默认预装核心组件库 `shadcn/ui`，位于`src/components/ui/`目录下
- Next.js 项目**必须默认**采用 shadcn/ui 组件、风格和规范，**除非用户指定用其他的组件和规范。**

---

# 项目：幼儿成长观察记录（child-growth-agent）

教师录入幼儿观察原始记录 → AI 按《3-6 岁儿童学习与发展指南》整理成发展性评价草稿 → 教师确认归档。核心不变量：**raw_text（原始观察）永不改写**；AI 产出仅为草稿，教师确认后才成为正式记录。

## 数据访问架构（重要，2025-09 变更）

**已从 supabase-js（PostgREST）切换为 pg 直连**。原因：平台托管数据库未注册 PostgREST 网关，supabase-js 无法连接；项目也未建立平台数据库集成授权。

- 连接层：`src/storage/database/pg-client.ts` —— pg Pool 单例（挂 `globalThis` 防 HMR 重复建池），提供 `query<T>()` / `queryOne<T>()` 助手
- 数据层：`src/lib/queries.ts` —— 9 个函数，SQL 用 `to_jsonb(table.*) AS data` 序列化（保持与 PostgREST 一致的 JSON 形态：时间戳为 ISO 字符串、jsonb 直传），错误文案与原实现一致
- 依赖：`pg`；`@supabase/supabase-js` 已移除；`supabase-client.ts` 已删除
- 表结构参考：`src/lib/db/schema.ts`（children / observations，外键 cascade，4 个索引）

## 环境变量

| 变量 | 用途 | 备注 |
|---|---|---|
| `DATABASE_URL` | pg 直连连接串 | **部署环境必配**（生产环境变量面板）。sslmode=require |
| `TEACHER_PASSCODE` | 教师登录口令 | /api/auth/login 校验；本地 `.env` 有联调值 |

本地 `.env` 不提交（.gitignore 已含）；`.env.example` 保留字段说明。

## 部署要点

1. 部署前在扣子编程部署面板的"生产环境变量"配置 `DATABASE_URL` 与 `TEACHER_PASSCODE`，缺一不可
2. AI 整理功能依赖平台注入的 LLM 网关凭证（COZE_API_TOKEN 等），**本地沙箱无此凭证属正常现象**，部署环境自动注入；本地 `/api/observations/:id/organize` 会返回 200 + 业务错误提示
3. 数据库迁移是幂等 DDL（CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS），部署后首次请求前无需手工执行

## 测试与验收（踩坑记录）

- **test_run 的每条 command 在隔离环境执行，/tmp 文件不跨命令共享**。带登录态的写接口测试必须单条命令自包含：`curl -s -c /tmp/ck -X POST -d '{"passcode":"..."}' .../api/auth/login > /dev/null && curl -s -b /tmp/ck ...`（同一 command 内先 login 再带 cookie）
- 联调产生的测试数据要清理干净，演示数据用固定 UUID（a1c1.../b2c2... 前缀）+ is_demo 标记，可精准重置
- `pnpm lint --quiet` / `pnpm ts-check` 通过 ≠ 功能可用；写接口必须实际 curl 走一遍
