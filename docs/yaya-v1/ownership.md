# 芽芽助手 v1 并行归属与文件边界（YAYA0-CONTRACT 草案）

- 状态：`reference_only` 草案；与 `contract-draft.md`、`tool-coverage.md` 同批，待主评审。
- 基线：`e8225f04918de2073e194cb199dc8cf1bcb7f38f`；三个首轮任务（YAYA0/TECH0/DESIGN0）从同一完整 SHA 建独立工作树，不等待其他 agent 在制文件。
- 纪律：只提交自己文件、不 `git add .`、不 push、不部署、不合并 main、不 reset 其他分支；不修改 AUTH/G0 冻结类型与现有业务代码/queries/API/schema、PRODUCT/DESIGN、依赖锁、`.env`。

## 1. 本轮（YAYA0-CONTRACT）独占文件

| 文件 | 内容 | 备注 |
|---|---|---|
| `docs/yaya-v1/contract-draft.md` | 业务契约草案、DTO/批准/回执/来源/会话/不可信数据、最小存储/API 提案、反例 | 本文件 |
| `docs/yaya-v1/tool-coverage.md` | 全工具覆盖表与“无工具”清单 | 不登记未实现功能 |
| `docs/yaya-v1/ownership.md` | 并行 owner 表与共享变更流程 | 本文件 |
| `src/lib/yaya/types.ts` | 可组合 DTO 与批准/回执/投影纯函数 | 只读引用 AUTH 类型，不修改 |
| `scripts/yaya/check-contract.ts` | 离线 assert 参考检查（26 项） | 输出 `reference_only:true` |

## 2. 并行 owner 表（后续轮次）

| Owner | 独占范围 | 允许的文件/模块（示意，最终以主评审指定为准） | 依赖与停止点 |
|---|---|---|---|
| YAYA-TECH0 | SDK/runtime/图片存储/公开检索兼容性结论 | `docs/yaya-v1/tech0.md`；如需最小探针 `scripts/yaya/check-tech0.ts` | 与契约并行；不改运行时/依赖锁，不连真实资源，不调用模型；结论回填契约的 provisional 项 |
| YAYA-DESIGN0 | 右侧栏/独立工作区/移动端、消息卡、附件与小芽方向 | `docs/design/yaya-v1/**` | 设计不宣称真实工具执行；用户选稿前不改产品 UI |
| YAYA-DATA1 | 会话/消息/提案/批准/回执/附件关联存储；**唯一 schema/迁移 owner** | 迁移文件、`src/storage/database/shared/schema.ts`、yaya 存储仓库模块 | 主评审批准契约后开工；迁移仅隔离库验证；不碰现有业务表形状 |
| YAYA-MEDIA1 | 图片上传、授权预览、对象引用与图片处理；共用附件组件 | 新新媒体模块（如 `src/lib/media/**`、`src/app/api/media/**`） | 复用已装 S3/sharp 能力；不自行改业务归档；桶权限分层验证 |
| YAYA-TOOLS1 | 将平台操作封装为受控工具；**现有业务 routes/queries 兼容修改的唯一 owner** | 工具注册与执行适配、必要的 `src/lib/queries.ts`/routes 兼容改动 | 复用授权与既有服务；不复制绕过事务的写路径；按契约 DTO 校验 |
| YAYA-AGENT1 | 模型适配、幼教边界 Prompt、上下文/来源、受限工具循环、暂停/恢复、公开检索 | 新 agent 模块（如 `src/lib/yaya/agent/**`） | 接依赖；不自行做权限或确认算法；工具循环能力以 TECH0 结论为准 |
| YAYA-UI1 | 聊天侧栏与工作区、移动端、持久化历史、结构化卡片 | `src/components/yaya/**`、相关 app 路由页面 | 接确定 DTO；不做前端“假批准”；选稿后进行 |
| YAYA-INTEGRATE1 | 正式表单/Review/档案附件接入、跨模块组合与迁移次序 | 新候选整合工作树中的装配文件 | 不用 main；保留来源历史；组装与共享文件只由指定 owner 修改 |
| YAYA-QA1 | 真实账号/HTTP/隔离库/浏览器联合链路与受控并发 | 验收报告与隔离测试 | 真实 provider 单列待新预算；替身/fixture 不算质量通过 |
| YAYA0-CONTRACT（本 owner） | 契约与共享类型的修订 | 第 1 节文件 | 必须接收 TECH0 结论后由主评审冻结；结束后共享类型变更走本 owner/主评审 |

## 3. 契约与共享类型变更流程

1. `src/lib/yaya/types.ts` 在冻结前由 YAYA0 唯一修改；下游不得复制、fork 或私改。
2. AUTH 冻结（`src/lib/accounts/types.ts` 等）与 G0 冻结（`src/lib/guide/types.ts`、`view-types.ts`）**零修改**；需要扩展时先提接口问题，由主评审指定 owner。
3. 现有业务 routes/queries/schema 的兼容改动归 YAYA-TOOLS1/DATA1；其他 owner 只能通过接口调用。
4. TECH0 结论未交付前，`contract-draft.md` 第 11 节相关项保持 provisional；禁止任何模块按未确认的协议能力抢跑。
5. 产品边界争议（新工具、新角色、新数据）回契约负责人/主评审，不各自扩展接口。

## 4. 本工作树提交与资源纪律

- 分支 `codex/yaya0-contract`，基线 `e8225f04918de2073e194cb199dc8cf1bcb7f38f`；只做精确文件提交，不 `git add .`。
- 不修改：AUTH/G0 冻结文件、现有业务代码/queries/API/schema、PRODUCT/DESIGN、`pnpm-lock.yaml`、`.env`、其他 agent 文件。
- 不执行：DB 迁移、真实模型/对象存储/托管库调用、push、部署、合并 main、清理他人资源。
- `RTK.md` 不存在（仅记录，不创建/不安装）；`scripts/harness-safety.ts` blob 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。
