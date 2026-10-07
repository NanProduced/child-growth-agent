# YAYA-API0 交付：第二波可序列化 HTTP 与事件协议（含 R1 返修）

2026-10-06。任务：在整合候选基线上发布可序列化的运行 / 查询 / 取消 / 事件 / 批准 / 执行请求协议与纯校验，
不实现运行 API 或 UI。最终候选完整 SHA 见交付回复（本文件随候选提交落地）。

- 初始候选 `bd1ea28cc6ec8ca0a1b18f2bc0530b54cd5fc51d`（45 项检查）。
- R1 返修（本文件对应候选，SHA 见交付回复）：只改 API0 协议、专属检查与文档，保留原 45 项；
  未重开 DATA / MEDIA / Agent 内核 / AUTH，未实现路由 / UI，未新增依赖，未真实服务。

## 1. 起点与工作树

| 项 | 值 |
|---|---|
| 准确起点 | `24b0588c07ce68968178660ba7dc1382292e8bdc`（codex/yaya-core-integration 候选） |
| 独立工作树 | `%TEMP%\opencode\yaya-api0` |
| 分支 | `codex/yaya-api0` |
| 前置阅读 | AGENTS、contract-v1、core-integration-r1 §7、`storage-types.ts` 对外投影 DTO、Agent 动作 / 事件 / 依赖端口 |
| harness | `scripts/harness-safety.ts` blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改（hash-object 复核） |
| RTK | `RTK.md` 不存在（仅记录，未创建 / 未安装）；本机存在 `rtk.exe` 不代表 RTK.md 或项目指令文件存在 |

未从 main 开工，未操作 P1 / 来源工作树，未 reset / 改写任何其他分支。

## 2. R1 返修内容（主评审四项 P1）

1. **浏览器消费边界**：协议层不再导入 `storage-types`（其运行时引入 `node:crypto`），摘要格式校验改为
   内联 `isYayaDigestHexWire`（服务器摘要计算不变）；检查新增真实 esbuild `platform=browser` 打包，
   不用 Node polyfill、不新增库。
2. **恢复响应边界**：解析扫描分离为 request / response / none——请求禁止伪造权威字段，响应只禁止秘密字段；
   `finished + proposed` 不再因 `content_digest` / `actor_account_id` 被误判。`classifyYayaRunLookup`
   对 `stopped` 终态统一套用 `safeYayaStopDetail`，查询恢复路径不再回传内部异常文本；四种终态往返均有断言。
3. **提案内容一致性**：`run_end` 与 `proposal_prepared` 改为**完整业务内容语义深比较**（proposal/batch 身份、
   动作/资源、逐项 item_key/target/digest、附件关联、payload 全部字段），键顺序无关；同 id 不同内容或重复/歧义
   一律 `contradictory_terminal`。
4. **执行响应语义核验**：新增 `assessYayaOperationsExecutionResponse(plan, body)`，复用冻结
   `compareBatchReceipts` / `queryOperationOutcome` / `receiptProvesSuccess` / `itemsToResend`：
   结构合法 ≠ 已保存；`saved + effect=unknown + 空业务标识` 判 `unverified_success`；缺项 / 错身份 / 矛盾回执
   分别 `response_incomplete` / `response_identity_mismatch` / `contradictory_receipt`；合法 failed / in_progress /
   unknown / unchanged / 幂等重复保留，显式恢复候选不自动重发。

主评审新增探针的五种错误行为已全部反转为正确断言（浏览器打包、finished+proposed 往返、同 id 异内容、
未证明 POST 成功、恢复路径停止详情脱敏）；主评审探针断言旧错误行为，故其在修复后按预期失败，不作为验收。

## 3. 交付文件与导出

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/lib/yaya/api-contract.ts` | 源码 | 协议常量与路径表；违规码；request/response 分离的权威 / 秘密字段扫描；run 发起 / 查询五态 / 取消请求与响应 Zod schema 与解析；NDJSON 事件 schema、行编解码、流校验（完整提案内容比对）、事件与终态投影、停止详情安全映射；失败投递选择；DATA 批准请求 schema；operations 执行最小请求 / 响应与语义核验；密码安全控件意图投影 |
| `scripts/yaya/check-api-contract.ts` | 装置 | **57 项**检查（原 45 + R1 新增 12，含真实 browser-target 打包） |
| `docs/yaya-v1/api-contract-v1.md` | 规范 | 接口路径表、JSON 例子、事件流语义、校验反例、未实现清单、NOT_RUN |
| 本文件 | 交付记录 | 起点、R1、验收、纪律、NOT_RUN、转交 |

未改：冻结 `src/lib/yaya/types.ts`、Agent 内核（`src/lib/yaya/agent/**`）、DATA / MEDIA、AUTH / G0、
现有 routes、`package.json` / `pnpm-lock.yaml`、UI、harness。`git diff` 仅含上述文件；
`package.json` / `pnpm-lock.yaml` / `types.ts` / `agent/types.ts` / `storage-types.ts` blob 与起点逐一致。

## 4. 协议口径摘要

- 复用不影子：事件 = 冻结 `YayaAgentEvent` + 信封（`protocol` / `run_id` / `seq`）+ 终态 `run_end`；
  提案 / 回执 / 查询结论 / 来源 / 停止原因 / payload 判别全部复用冻结类型；领域 payload 完整 schema 归 TOOLS1 / DATA，
  线上守卫只校验判别与秘密字段排除。
- 浏览器请求不含 `signal` / `onEvent`；run_id 由服务器建立；`client_request_id` 稳定绑定，丢失首响应可按 owner 查回。
- 五态查询：missing / in_progress / finished / unverifiable / service_failure 分开；查询不启动模型、不执行业务写；
  finished 的停止详情统一脱敏。
- 取消只停后续派发 / 消费，三个固定布尔明确“不撤销已提交业务、不保证上游物理取消”。
- 失败投递：头未发 HTTP 错误，流已开始显式终态；停止详情固定文案，不带内部异常栈 / 模型原始 JSON。
- 新请求严格对象 + 权威字段扫描，拒绝自报 Principal / scope / 角色 / 批准身份；密码类动作只回安全控件意图 / 目标。
- 协议层浏览器可直接打包：无 `node:` 内置 / Next / 数据库 / 模型依赖链。

## 5. 验收（本候选实跑）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm ts-check` | 通过 |
| Lint | `pnpm lint:build` | 通过 |
| 新协议检查 | `pnpm exec tsx scripts/yaya/check-api-contract.ts` | **57/57**，`reference_only: true` |
| 浏览器打包 | 检查内 esbuild `platform=browser` | 通过 |
| 核心契约 | `pnpm exec tsx scripts/yaya/check-contract.ts` | 68/68 |
| preflight | `pnpm exec tsx scripts/yaya/check-preflight.ts` | 15/15 |
| Agent 引擎回归 | `pnpm exec tsx scripts/yaya/check-agent-engine.ts` | 29/29，`real_model_requests: 0` |

计数只证明协议校验与纯函数判定通过，不称真实认证 / HTTP / 浏览器通过。

## 6. 资源与安全纪律

- 未读 `.env`，未连数据库 / 托管库，未调用真实 provider / 搜索 / S3，未发任何真实服务请求（模型守门 0 命中）。
- 模型预算 40/40 未动；未改 40/40 账本；未 push / 部署 / 合并 main。
- `pnpm install --frozen-lockfile` 仅安装本地依赖，未改 `package.json` / `pnpm-lock.yaml`。
- 未写任何凭证、连接串、口令进仓库、日志或提交。

## 7. NOT_RUN / NOT_IMPLEMENTED

- 运行路由（发起 / 查询 / 取消）、事件流写出、run 持久化与身份 / 来源重核装配：NOT_IMPLEMENTED（AGENT-APP1）。
- `operations` POST、工具 registry、批准执行装配、同事务业务 callback、密码安全窗口：NOT_IMPLEMENTED（TOOLS1）。
- 真实模型（含字符级流与物理取消）、真实认证 / HTTP / 浏览器、真实数据库 / 对象存储 / 托管部署：NOT_RUN。
- 查询五态与 client_request_id 绑定的真实数据接线、失败投递的真实 503 / 流中断：NOT_RUN（纯函数只验协议）。
- 浏览器证据仅为 esbuild 打包通过，不等于真实浏览器运行验收。

## 8. 停止与转交

API0 修复获批后再交付下游消费；协议接口通过后由 owner 转交 AGENT-APP1 接运行 API；UI1 只消费协议，
不自行修改或 fork。本任务到此停止：不实现运行 API、不实现 UI、不开始 TOOLS1。
