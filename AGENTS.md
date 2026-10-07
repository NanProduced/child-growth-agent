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

- 连接层：`src/storage/database/pg-client.ts` —— pg Pool 单例（挂 `globalThis` 防 HMR 重复建池），提供 `query<T>()` / `queryOne<T>()` 助手与共享保存/读取上下文（业务写必须经过事务 hook）
- 数据层：`src/lib/queries.ts` —— 班级、幼儿、分班、观察、确认与指南证据读写等原语，SQL 用 `to_jsonb(table.*) AS data` 序列化（时间戳为 ISO 字符串、jsonb 直传）
- 依赖：`pg`；`@supabase/supabase-js` 已移除；`supabase-client.ts` 已删除
- 表结构参考：`src/storage/database/shared/schema.ts`（children / classes / child_class_enrollments / observations / app_accounts / app_sessions / teacher_class_assignments）

## 账号与授权（AUTH v1，本地候选，尚未部署）

- 授权入口：`src/lib/accounts/access.ts`（`resolveServerAuth` / `requireServerAccess` / `withBusinessRead` / `runBusinessWrite`）与 `src/lib/accounts/scoped-queries.ts`（`scoped*` 读函数）；`src/lib/auth.ts` 只重导出并向后兼容旧调用。权限契约见 `docs/auth-v1/contract.md`，接入清单见 `docs/auth-v1/business-access-home.md`。
- 服务端是唯一授权事实：UI 隐藏按钮不构成授权；禁止缓存 Principal、禁止信任客户端声明的角色/班级/归属；资源归属必须每次从数据库重查。
- 登录：`/api/auth/login` 使用账号口令（scrypt + 随机盐）与数据库会话（HttpOnly 同源 Cookie、会话绑定 CSRF、固定期限、GET 不续期）；管理端教师管理在 `/admin/teachers` 与 `/api/admin/teachers/*`。
- 旧 `TEACHER_PASSCODE` 口令 Cookie 不再授权新业务，仅保留失败兼容入口；不应作为新版授权或部署前提。
- 错误语义：401 未认证、403 无权限、400 非法动作/资源组合、409 业务冲突、503 身份服务不可用（fail closed，配置缺失时同样 503）。

## 指南证据链（G5 读模型 + G6 前端写闭环，本地整合候选）

- 目录、读模型、建议与决定 API、儿童证据册/班级概览只读页面已实现（`src/lib/guide/`、`/api/observations/[id]/guide-evidence`、`/children/[id]/evidence`、`/classes/[id]/evidence`）。
- **前端关联写闭环已在 CLOSE-QA1 整合候选接入**（`scripts/check-flow-close-joint.ts` 联合验收）：从指南条目进入记录 → 录入原始观察 → 整理（测试替身）→ 教师确认并提交指南决定（与归档同一事务）→ 个人证据册展开引用 → 班级同期聚合与下钻。整合记录见 `docs/guide-evidence-v1/close-qa1-integration.md`。
- 真实模型质量、托管库迁移与生产发布均未验收；活动反馈、学期快照尚未实现，不属于当前 Demo 范围。

## 环境变量

| 变量 | 用途 | 备注 |
|---|---|---|
| `DATABASE_URL` | pg 直连连接串 | 本地优先使用；扣子编程生产环境没有自定义值时回退到平台注入的 `PGDATABASE_URL` |
| `AUTH_TRUSTED_ORIGINS` | 可信公开源（逗号分隔，含协议与端口） | AUTH v1 登录与登录后写保护的**必填项**；未配置时一律 fail closed（503），不信任 Host / X-Forwarded-* |
| `AUTH_SCHOOL_ID` | 单园所标识 | 可选，默认 `single-school` |
| `AUTH_COOKIE_SECURE` | 会话 Cookie 是否强制 Secure | 可选，留空时按可信源是否全为 https 自动判断 |
| `AUTH_LOGIN_RATE_LIMIT_MAX` / `AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS` | 登录限流（进程内固定窗口） | 可选，默认 10 次 / 300 秒 |
| `TEACHER_PASSCODE` | 旧教师口令 | 仅遗留兼容，不再用于 AUTH v1 授权，也不再是部署前提 |

本地 `.env` 不提交（.gitignore 已含）；`.env.example` 只保留变量名和说明。`.coze` 只保存项目与部署元数据，禁止写入数据库连接串、口令、API Key 或其他凭证。部署环境变量统一在扣子编程部署面板配置。

## 迁移

**区分演示库初始化与已有库升级**：`initialize-demo-db.sql` 是**演示库初始化脚本**，除建表/索引外还包含 `INSERT INTO children/observations/classes/child_class_enrollments` 合成种子数据，**不是生产纯结构迁移**（可按需截取 `INSERT INTO children` 之前的纯建表部分）；`upgrade-classes.sql` 除结构外**包含既有数据的回填**（班级快照等），也不是纯 DDL。本轮（CLOSE-QA1）未执行任何生产 SQL。

已存在增量迁移文件，**按以下顺序执行**（均可重复执行，先建表/索引/约束再回填）：

1. `scripts/initialize-demo-db.sql` —— 基础 schema + 合成演示数据（在 `INSERT INTO children` 前为纯建表/建索引部分，可按需截取）
2. `scripts/upgrade-classes.sql` —— 班级、分班与观察发生时班级快照（含数据回填）
3. `scripts/upgrade-guide-evidence-v1.sql` —— 指南证据列（须在 `upgrade-classes.sql` 之后，依赖 observations 与 classes.stage）
4. `scripts/upgrade-auth-v1.sql` —— 账号、会话、任教关系（AUTH1）

其他按需：`scripts/upgrade-agent-context.sql`、`scripts/upgrade-growth-profile.sql`。建表后的权威形状以 `src/storage/database/shared/schema.ts` 为准；生产库执行前必须核对表、索引与约束（含 `app_accounts_role_check` / `app_accounts_status_check`）已存在。

## 部署要点

1. 部署前在扣子编程部署面板的"生产环境变量"配置 `DATABASE_URL` 与 `AUTH_TRUSTED_ORIGINS`（新授权必需）；旧 `TEACHER_PASSCODE` 不再作为新版授权或部署前提
2. AI 整理使用当前选择的 provider；Coze provider 依赖平台注入的 LLM 网关凭证，StepFun provider 依赖本地/生产环境变量中的 StepFun 配置，不能把任何凭证写入仓库
3. 按上节顺序执行/核对迁移；部署前必须验证表和索引已存在
4. `.coze` 的部署标识是**扣子编程**体系的：`project_id` 必须等于沙箱 `COZE_PROJECT_ID`（当前 `7690843235199139866`，与线上站点埋点上报一致）。初始化快照曾带入旧扣子（低代码平台）的 `project_id`/`app_id`，2025-09 已纠正为扣子编程值并移除无对应概念的 `app_id`——两平台 ID 互不相通，勿混用

## 测试与验收（踩坑记录）

- **test_run 的每条 command 在隔离环境执行，/tmp 文件不跨命令共享**。带登录态的写接口测试必须单条命令自包含（同一 command 内先 login 再带 cookie 访问）；新版登录为账号口令 `/api/auth/login`，不是 `TEACHER_PASSCODE`
- 联调产生的测试数据要清理干净；隔离测试资源按本轮随机 run ID + 容器标签/数据库身份核验后清理，禁止按端口或名称前缀误杀，端口被占用时应直接退出
- `scripts/harness-safety.ts` 是已获批的安全装置，保持 blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 不变
- `pnpm lint --quiet` / `pnpm ts-check` 通过 ≠ 功能可用；写接口必须实际走一遍授权链路
- 真实模型预算受限：模型相关验证使用测试进程内替身并明确标注，不新增产品侧绕过开关；禁止无预算的真实 provider 请求
