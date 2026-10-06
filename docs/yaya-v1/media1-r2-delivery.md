# YAYA-MEDIA1-R2 交付｜无键上传同一身份恢复、登记回应核对、宿主前提入原子边界

- 起点 SHA：`87c81268e393fdf6422af98b89ba72f3031ebc23`（沿 `codex/yaya-media1` 追加；工作树 `%TEMP%\opencode\child-growth-yaya-media1`）。
- 被评审问题：无幂等键未知上传无法按原身份重试；注册正常返回未做一致性核对；宿主来源前提未在保存边界复核；映射文档仍引用 DATA 初版。
- 本文件 §4 是 MEDIA v2 端口到 **DATA-R1（`yaya-media-storage-r1` @ `3d96f69`）** 的唯一映射口径；**不宣称结构化直接兼容**，组合阶段必须按此绑定并做类型/实库验证（NOT_RUN）。

## 1. 三项修复与复现结果

### 1.1 无键上传的稳定身份（问题 1）

- 无 `client_upload_id` 的上传不再使用随机身份，而按 `owner + 原始字节 SHA-256` 派生内容身份
  （`contentAttachmentId`，与显式键命名空间分离）；同一输入重试必然命中同一身份。
- 未知结果仍只按原身份核对：读回成功恢复、读回失败保留对象与可恢复身份；
  **不新建操作绕过未知结果**；不同内容（含仅 EXIF 不同）身份不同，绝不静默复用旧图。
- 内容身份已被回收（deleted）时，为本次新上传分配随机兜底身份（主键不可复用）；
  只有该兜底身份在对象阶段失败时才做精确补偿（其余确定性身份保留对象供重试复用）。
- 产品语义：同一 owner 重复上传同一张照片会去重为同一附件（与“共同照片多引用、不重复上传”一致）；
  同内容重复上传不再产生新对象。

主评审探针（`yaya-media1-r1-review-20261006/probes.ts`）复跑：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `same_attachment_id` | false | **true** |
| `original_record_exists` | false | **true** |
| `objects_remaining` | 6 | **3** |
| `metadata_records` | 1 | **1** |

### 1.2 登记回应统一核对（问题 2）

- `registerAttachment` 正常返回与异常读回都走同一核对（`restoreRegistered`）：
  预期 `attachment_id`、owner、`source_checksum` 内容绑定、记录完整性、`ready` 状态；
  非 ready/错配/损坏回应**不显示成功**。
- 正常返回核对失败**不回读覆盖**不一致回应、不做破坏性补偿（对象保留）；
  只有“注册抛异常”才进入读回恢复路径。
- 探针复跑：`ack_status=deleting` → `reported_ok=false, reported_status=null`（修复前为 `true/ready`）。

### 1.3 宿主前提进入共同原子保存边界（问题 3）

- `appendObservationAttachments` 端口契约新增并实现宿主前提核验：在同一原子边界内
  重读宿主，要求 `status=confirmed` 且 `confirmed_at` 与提交的 `source_confirmed_at`
  同一时刻；不满足 → `observation_not_confirmed` / `source_conflict`，**零写入**
  （不写引用、不递增修订、不写审计）。把来源写进审计 ≠ 前提成立。
- 服务层预检保留为快速失败；权威条件在端口边界（内存替身已忠实实现）。
- 探针复跑：预检后宿主改为 draft → `appendObservationImages` 以
  `observation_not_confirmed` 拒绝（修复前写入 `append_revision=1, references=1, audits=1`）；
  仓库回归 D3/D4 断言修订/引用/审计全为 0。
- **DATA 侧仍需共同落实**（见 §4）：`casObservationAttachmentRefs` 当前只查宿主存在；
  追加原语必须在同一事务锁读宿主并核 `confirmed` 与 `source_confirmed_at`。

## 2. 端口变化（R1 → R2）

- `upload-service`：新增 `contentAttachmentId(owner, source_checksum)`；
  `deterministicAttachmentId` 改为 `client:` 命名空间（与内容身份隔离）；
  正常登记回应与异常读回统一 `restoreRegistered`（含预期 id 核对）；
  补偿条件改为“仅随机兜底身份”。
- `metadata-memory`：`seedObservation(id, status, confirmed_at)`；
  `appendObservationAttachments` 在 CAS 前核验宿主 `confirmed` + `source_confirmed_at`。
- `metadata-port`：文档明确追加边界必须重读/锁定宿主并核来源前提。
- 未改：A/B/C 已修正确的 revision CAS、租约互斥、未知结果保留对象等语义（不退回）。

## 3. 验收与证据

- `check-media.ts`：**28/28**（原 28 项保留；上传/补偿项按内容身份语义更新，新增“回收后重新上传的兜底身份”补偿反例）。
- `check-media-r1.ts`：**25/25**（R1 的 20 项 + R2 新增 D1–D5）：
  D1 无键未知上传同一输入重试恢复；D2 非 ready 回应不显示成功且保留对象；
  D3 宿主前提边界变化拒绝且零写入；D4 来源前提边界变化 `source_conflict` 零写入；
  D5 无键内容绑定（同内容去重、异内容不同身份）。
- 主评审探针复跑见 §1（1、2 项日志，第 3 项以 `observation_not_confirmed` 拒绝退出）。
- `pnpm ts-check`、`pnpm lint:build`、`pnpm lint:style`、`pnpm next build` 通过；
  `check-contract` 68/68、`check-preflight` 15/15、`check-tech0`、`check-runtime-tech0.cjs` 通过；harness blob 未变。
- 分层：真实 sharp 处理 + 自有本地对象 I/O；元数据为内存替身；真实 egress 0，未读 `.env`，预算未动。

## 4. 唯一映射：MEDIA v2 端口 ↔ DATA-R1（`yaya-media-storage-r1` @ `3d96f69`）

> 说明：DATA-R1 发布的 `YayaAttachmentMetadataPort` 仍是 pending/markReady + token 租约形状，
> 与 MEDIA v2（单次原子登记 + revision CAS 租约 + 创建/追加分开）**结构不一致**；
> 组合阶段必须按本表写薄适配（或直接消费底层 repository 原语）并做类型与实库验证。
> 以下区分“列已存在”（DATA-R1 已交付）与“事务条件已实现/仍缺”。

### 4.1 表与列（DATA-R1 已交付，无需重复建列）

- `yaya_attachments`：`client_upload_id`（同 owner 部分唯一）、`object_key/thumbnail_key/model_key`、
  `checksum_sha256/thumbnail_checksum/model_checksum`、`width/height`、`status`、`revision`、
  `delete_result`、`deletion_lease_id`、`deleting_started_at/deleted_at`。
- `yaya_attachment_appends`：`audit_id`、`action`、`attachment_ids` jsonb、`source_confirmed_at`、`request_id`。
- 仍缺：**`source_checksum` 持久化**（MEDIA 内容绑定所需；列或显式 metadata 透传，不得默认/伪造）。

### 4.2 逐方法映射

| MEDIA v2 | DATA-R1 原语（`src/lib/yaya/data/attachments.ts`） | 映射要点 | 缺口 / 绑定要求 |
|---|---|---|---|
| `get(id)` | `getAttachment`（`YayaAttachmentView`，含 revision/delete_result） | 标量字段直映；三 key/checksum/宽高/client_upload_id 已是显式列；端口状态由 `status+delete_result` 还原（deleting+unknown → `deleting`+`delete_result:"unknown"`） | **`source_checksum` 无列**：要求 DATA 持久化并回传；缺失按记录不完整拒绝，不默认 ready |
| `registerAttachment` | `insertPendingAttachment` + `markAttachmentReady`（同一短事务） | 两步合一：insert pending（显式列全齐）→ ready CAS revision+1；适配器不得把 pending 中间态当成功返回 | 结构差异（DATA 两阶段 vs MEDIA 单次）；组合适配器须在同一事务内完成或 DATA 提供单次 ready 登记原语 |
| `getReferenceFacts` | `getMediaAttachmentReferenceFacts`（不完整抛 `reference_incomplete`） | 三类引用直映；MEDIA 期望 `reference_query_complete` 布尔：适配器把抛出转为 `complete=false` | 不得把不完整当空集 |
| `beginDeletionLease({id,expected_revision})` | `beginAttachmentDeletion(client,{attachment_id,expected_revision,actor_account_id})` | 锁附件行 + **锁内完整引用重查** + revision CAS，满足 MEDIA v2 原子条件；异常码映射 `attachment_referenced→referenced`、`revision_conflict→revision_conflict`、`attachment_missing→not_found`、`attachment_conflict→not_ready` | DATA-R1 媒体端口 `acquireAttachmentDeletionLease`（token、referenced 折叠为 `not_ready`、无 revision 前提）**不足以**绑定；组合必须用旧 CAS 原语（或扩展媒体租约）。**不得退回 token 租约** |
| `commitDeletion` / `failDeletion` | `commitAttachmentDeletion` / `failAttachmentDeletion`（expected_revision） | 直映；`failDeletion` 保持 `deleting+unknown`、绝不回 ready | 不得绑定 `completeAttachmentDeletionByLease`（token 身份、`failed` 回 ready） |
| `linkObservationReferences` | 逐附件 `linkAttachmentRef`（锁行、ready+owner、ON CONFLICT DO NOTHING、不递增 revision） | 创建观察事务内调用；与 MEDIA v2 创建语义一致 | DATA 媒体端口 `addObservationAttachmentRefs` 会递增 revision，与 MEDIA v2“创建不递增”冲突；组合需统一（推荐 `linkAttachmentRef`）并验证 |
| `appendObservationAttachments` | 目标：宿主前提锁读 + `addObservationAttachmentRefsAtRevision` + `appendMediaAttachmentAudit`（同一 TransactionClient） | CAS + 引用 + 审计可同事务组合；`source_confirmed_at/request_id` 列已存在 | **宿主前提未消费**：`casObservationAttachmentRefs` 只 `SELECT id FROM observations`；要求 DATA 在同一事务锁读宿主并核 `status=confirmed` 与 `confirmed_at=source_confirmed_at`（否则整事务回滚）。来源写进审计 ≠ 前提成立 |
| `getObservationAttachmentRevision` | `getObservationAttachmentRevisionNumber` | 直映 | — |
| 会话解除引用 | `releaseConversationAttachmentRefs` | DATA 已有；MEDIA 不直接调用（DATA `deleteConversation` 内部使用） | — |

### 4.3 错误码映射（组合适配器）

| DATA-R1 `YayaDataError.code` | MEDIA `MediaError.code` |
|---|---|
| `attachment_missing` | `attachment_not_found` |
| `attachment_conflict`（owner 不符） | `not_owner` |
| `attachment_conflict`（deleting） | `attachment_deleting` |
| `attachment_conflict`（pending/deleted） | `attachment_gone` |
| `revision_conflict` | `revision_conflict`（租约/追加 CAS；不改写成 metadata_conflict） |
| `reference_incomplete` | `reference_query_incomplete`（读取与回收保守拒绝） |
| `invalid_request` | `invalid_request` |
| 唯一冲突（insert 附件/幂等键） | `object_conflict` / `idempotency_conflict` |

### 4.4 待 DATA 明确的两项（当前不得宣称已闭环）

1. **`source_checksum` 持久化**（内容绑定与同键异内容冲突判定）。
2. **追加原语的宿主前提核验**（`confirmed` + `source_confirmed_at` 在同一事务成立）。
   另建议：媒体租约原语提供 `expected_revision` 与可区分的 `referenced` 结果（或明确组合绑定旧 CAS 原语）。

## 5. 清理与 NOT_RUN

- 主评审探针目录只读复用，未修改；未新增临时 worktree；check 临时目录按身份删除（输出 `cleanup:removed`）；未占端口。
- NOT_RUN：真实 DATA repository 联合装配与类型/实库验证（`bindMediaRuntime` 绑 DATA 适配器）；
  DATA 侧 `source_checksum` 列/透传与追加宿主前提核验；真实桶/浏览器/真实模型看图；
  内容身份去重的产品级确认（UI 附件卡是否接受同图去重）。本文件不把替身兼容称为正式 DB 闭环。
- 停止：仅本地提交，不 push/部署/merge main；不进入 UI 或正式平台 tool 装配。
