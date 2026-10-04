# 账号与授权 v1 文件归属与并行纪律（AUTH0-R1）

- 契约：`docs/auth-v1/contract.md`（**返修候选，等待主评审**）。
- 基线：`734f572925e7c298f2226679c00e3e4e978068b2`；工作树 `codex/auth0-contract`。
- 上一轮冻结候选 `734f572` 已被主评审指出问题，本轮为 R1 修订；R1 提交前不得作为实装基线。

## 文件归属

| 文件/模块 | 归属 | 内容 |
|---|---|---|
| `src/lib/accounts/types.ts` | AUTH0 契约负责人 | 冻结：Principal、AuthState、DataScope、动作/资源组合、错误码与映射、登录前/后保护、初始化、模型等待、接口 DTO |
| `src/lib/home-v2/types.ts` | AUTH0 契约负责人 | 冻结：首页 DTO（四态、范围、学段分组、待办计数、观察摘要、主行动） |
| `docs/auth-v1/contract.md` | AUTH0 契约负责人 | 本契约（R1） |
| `docs/auth-v1/ownership.md` | AUTH0 契约负责人 | 本文件 |
| `docs/auth-v1/auth0-r1-delivery.md` | AUTH0 契约负责人 | R1 交付报告：修正前后、反例结果、接口与待验证项 |
| `src/lib/accounts/__fixtures__/contract-fixtures.ts` | AUTH0 契约负责人 | 纯 fixture（不写库、不调模型） |
| `src/lib/home-v2/__fixtures__/contract-fixtures.ts` | AUTH0 契约负责人 | 纯 fixture |
| `scripts/check-auth-contract.ts` | AUTH0 契约负责人 | 离线参考检查（reference_only） |
| `PRODUCT.md`（新增范围小节） | AUTH0 契约负责人 | 仅局部同步已确认口径 |

## 只读依赖（本轮零修改）

- G0 冻结文件：`src/lib/guide/types.ts`、`src/lib/guide/view-types.ts`、`docs/guide-evidence-v1/contract.md`、`scripts/check-guide-contract.ts`、`src/lib/guide/__fixtures__/contract-fixtures.ts`。
- 现有实现：`src/lib/auth.ts`、`src/lib/queries.ts`、`src/storage/database/shared/schema.ts`、现有 API/页面、`DESIGN.md`、G1～G5 源码与测试装置、HOME0 文件、依赖与锁文件。
- 其他 agent 的工作树、分支、进程与容器一律不操作。

## 下游实现归属（建议，待主评审确认）

| 模块 | 归属 | 说明 |
|---|---|---|
| AUTH1：认证实现（scrypt、会话、登录前/后保护、限流、建表与迁移） | AUTH0 实现方 | 按 R1 契约；共享类型只能由契约负责人修订 |
| AUTH2：模型等待重核与写入协调、路由授权接入、旧入口切换 | AUTH0 实现方 | 第 6/8 节；G5 GET 从公开变受限由 G5 实现方按契约接入 |
| 首页 v2 数据装配与页面 | 首页 v2（HOME）实现方 | 只消费 `src/lib/home-v2/types.ts`；可操作待办、计数与主行动按 R1 规则；不得私自扩类型 |
| 审计元数据阶段 B/C | 契约负责人统一提案后实施 | 不得改 G0 冻结形状 |

## 并行纪律

1. 冻结文件只由契约负责人修改；其他模块需要变更时先提接口问题，不私自改变契约。
2. 不自动切换、合并或重置其他 agent 的分支；只提交自己负责的文件，保留正常提交历史。
3. 不 push、不部署、不修改生产环境变量；不输出 `.env`、口令、API Key、完整连接串。
4. 迁移 SQL 只能由实现方在隔离本地 PostgreSQL 执行；本契约轮不执行任何迁移，禁止对托管库或线上库执行。
5. 共享类型的后续修订必须由契约负责人统一落地，并同步 fixture 与检查。
6. 浏览器接口拦截只能证明 UI 状态，不能当作真实认证、数据库或模型全链路验收。

## 验证入口

- `pnpm exec tsx scripts/check-auth-contract.ts`（离线，输出 `reference_only: true`）
- `pnpm ts-check`
- `pnpm lint:build`

## 仓库事实记录

- 基线 `734f572`（及更早 `b02e4a1`）不存在 `RTK.md`（已核实），不补造、不安装；如后续需要，由仓库维护者单独决定。
