# YAYA-DATA1-R2 交付：媒体端口三缺口收尾

状态：实现完成，隔离库与全部回归通过；等整合者接入（不自行开始 TOOLS1）。
起点：`3d96f69ba9fea6102d11492e5bdd3f3189b9aca6`（`codex/yaya-data1`）。
评审复现：`%TEMP%\opencode\yaya-data1-r1-review-20261006\REVIEW.md` + `db-probes.ts`（只读参考，未修改）。
harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改；未读 `.env`；真实 provider/搜索/S3 请求 0；预算 40/40 未动。

## 1. P1：媒体租约取得时锁后核完整引用

问题：`acquireAttachmentDeletionLease` 只看附件行状态，不核查引用；图片已有引用仍 `acquired` 并进入 `deleting`（实库复现 `lease_outcome=acquired, status=deleting, refs=1`）。

修复：抽出唯一锁内引用核查原语 `attachmentLeaseReferenceState`（完整引用查询：观察/消息/提案；悬空引用按 incomplete）：
- `beginAttachmentDeletion`（旧）与 `acquireAttachmentDeletionLease`（媒体端口）共用；
- 媒体租约：锁附件行后重新核查，`referenced`/`incomplete` → `not_ready`，状态保持原值（ready/deletion_unknown），绝不进入 deleting；
- 旧函数保持 `attachment_referenced` / 新增 `reference_incomplete` 错误语义；
- 不依赖调用方前置 `getReferenceFacts`（前置查询只是快速路径）。

RED：R2 检查实测 `outcome=acquired` 且状态 deleting（有引用）；悬空引用同样 acquired。
GREEN：有引用 → `not_ready` 且状态 ready；悬空引用 → `not_ready`。

## 2. P1：归档追加携带 expected_revision

问题：媒体端口 `addObservationReferences` 无版本条件；两次 expected=0 都成功，revision=2。

修复：
- 抽出 CAS 核心 `casObservationAttachmentRefs`（锁附件稳定序 → 锁 meta → expected 比对 → 拒绝重复 → 插引用 revision+1）；
- `appendObservationAttachments` 复用该核心（保留逐附件审计行，行为不变）；
- 新增 `addObservationAttachmentRefsAtRevision`（repository）与端口方法 `addObservationReferencesAtRevision`；
- 端口 `addObservationReferences` 接受可选 `expected_attachment_revision`：提供时走 CAS（等价显式方法），不提供时保持创建关联语义——创建与归档追加明确区分；
- 媒体接口文档 §4 已同步（评审要求的符号先发布）。

RED：带 expected 的端口调用被忽略，第二次仍成功、revision=2。
GREEN：首个 expected=0 成功 revision=1；第二个 expected=0 → `revision_conflict`；最终 revision=1。

## 3. P2：共享照片评估全部匹配条目并取最佳投影

问题：`evaluateAttachmentAccess` 提案分支遇到首个匹配条目就 `break`；无权条目在前 → denied，有权条目在前 → full（顺序依赖）。

修复：新增纯函数 `aggregateProposalRecordAccess`（full > historical_read_only > 无；denied/unavailable/broken 不覆盖其他条目的合法投影）；提案分支评估**全部**匹配条目后聚合，结果与顺序无关；多引用仍走冻结 `decideImageReadAccess` 的最佳投影。

RED：deny-first 共享照片不可读；payload 矩阵检查同时失败。
GREEN：两种条目顺序均 full 可读；无权条目 payload 仍扣留、有权条目 payload 保留。

## 4. 验收（本轮实际执行）

| 检查 | 结果 |
|---|---|
| `pnpm ts-check` / `pnpm lint:build` | 通过 |
| `check-data-r1.ts`（纯，含新增 R2 聚合顺序） | 10/10 |
| `check-data-r1-media-db.ts`（C/D，含新增 R2 三组） | 67/67（原 56 + 11 新增） |
| `check-data-r1-db.ts`（A/B） | 58/58 |
| `check-data-db.ts`（旧实库 116） | 116/116（迁移两次、7 表列签名不变） |
| `check-data.ts`（旧纯 27） | 27/27 |
| `check-contract.ts` / `check-preflight.ts` | 68/68 / 15/15 |
| `check-auth-contract.ts` / `check-guide-contract.ts` | 36/36 / 19/19 |
| `check-business-access.ts`（旧业务访问） | 113/113 |

## 5. 文件与分层

- 代码：`src/lib/yaya/data/{invariants,access-facts,attachments,media-port,index}.ts`、`src/lib/yaya/storage-types.ts`。
- 检查：`scripts/yaya/check-data-r1.ts`、`scripts/yaya/check-data-r1-media-db.ts`（新增 R2 反例，旧断言未删）。
- 文档：本文件 + `media-storage-interface-r1.md`（§3/§4 同步 R2 语义）。
- 分层：纯函数/替身、隔离库真实 repository+事务、真实 route handler HTTP（无 Next server）；业务回调仍为 DATA1 SQL 替身；正式 MEDIA 装配、真实 S3、浏览器 NOT_RUN。
- 清理：一次性容器按 ID+标签核验删除、无残留；模型守门 0 命中；临时日志已删。
- 停止：不创建 operations POST、不开始 TOOLS1。
