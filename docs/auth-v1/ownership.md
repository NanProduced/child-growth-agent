# 账号与授权 v1 文件归属与并行纪律

- 契约：`docs/auth-v1/contract.md`（AUTH0，冻结）。
- 基线：`b02e4a1284ac9423d5bffd3ab9436db12aeccf23`；工作树 `codex/auth0-contract`。

## 文件归属

| 文件/模块 | 归属 | 内容 |
|---|---|---|
| `src/lib/accounts/types.ts` | AUTH0 契约负责人 | 冻结：Principal、AuthState、DataScope、访问动作、错误体、教师管理/会话/接口 DTO |
| `src/lib/home-v2/types.ts` | AUTH0 契约负责人 | 冻结：首页展示 DTO（未登录/教师/管理员/身份不可用、范围、学段分组、行动、观察摘要） |
| `docs/auth-v1/contract.md` | AUTH0 契约负责人 | 本契约 |
| `docs/auth-v1/ownership.md` | AUTH0 契约负责人 | 本文件 |
| `src/lib/accounts/__fixtures__/contract-fixtures.ts` | AUTH0 契约负责人 | 纯 fixture（不写库、不调模型） |
| `src/lib/home-v2/__fixtures__/contract-fixtures.ts` | AUTH0 契约负责人 | 纯 fixture |
| `scripts/check-auth-contract.ts` | AUTH0 契约负责人 | 离线参考检查（reference_only） |
| `PRODUCT.md`（新增范围小节） | AUTH0 契约负责人 | 仅局部更新已确认口径 |

## 只读依赖（本轮零修改）

- G0 冻结文件：`src/lib/guide/types.ts`、`src/lib/guide/view-types.ts`、`docs/guide-evidence-v1/contract.md`、`scripts/check-guide-contract.ts`、`src/lib/guide/__fixtures__/contract-fixtures.ts`。
- 现有实现：`src/lib/auth.ts`、`src/lib/queries.ts`、`src/storage/database/shared/schema.ts`、业务路由、`DESIGN.md`、UI 组件。
- 现有未跟踪文件与 main / 其他工作树中的改动（不 touch）。

## 下游实现归属（建议，待主评审确认）

| 模块 | 归属 | 说明 |
|---|---|---|
| 认证实现（scrypt、会话、CSRF、限流、账号/会话/任教表与迁移） | AUTH0 实现方 | 必须按本契约；共享类型只能由契约负责人修订 |
| 旧入口切换、路由授权接入 | AUTH0 实现方 | 第 6 节清单；G5 GET 从公开变受限由 G5 实现方按本契约接入 |
| 首页 v2 数据装配与页面 | 首页 v2 实现方 | 只消费 `src/lib/home-v2/types.ts`，不在前端过滤全园数据 |
| 审计元数据阶段 B/C | 契约负责人统一提案后实施 | 不得改 G0 冻结形状 |

## 并行纪律

1. 冻结文件只由契约负责人修改；其他模块需要变更时先提接口问题，不私自改变契约。
2. 不自动切换、合并或重置其他 agent 的分支；只提交自己负责的文件，保留正常提交历史。
3. 不 push、不部署、不修改生产环境变量；不输出 `.env`、口令、API Key、完整连接串。
4. 迁移 SQL 只能由实现方在隔离本地 PostgreSQL 执行；本契约轮不执行任何迁移，禁止对托管库或线上库执行。
5. 共享类型（`src/lib/accounts/types.ts`、`src/lib/home-v2/types.ts`）的后续修订必须由契约负责人统一落地，并同步 fixture 与检查。
6. 浏览器接口拦截只能证明 UI 状态，不能当作真实认证、数据库或模型全链路验收。

## 验证入口

- `pnpm ts-check`
- `pnpm lint:build`
- `pnpm tsx scripts/check-auth-contract.ts`（离线，输出 `reference_only: true`）

## 仓库事实记录

- 基线 `b02e4a1` 不存在 `RTK.md`（已核实），本契约不补造；如后续需要，由仓库维护者单独决定。
