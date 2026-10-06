# YAYA 媒体附件存储接口（DATA1-R1 发布）

状态：接口声明发布（本提交）；实现随 R1 同分支后续提交，见本文件 §7 的映射版本。
owner：YAYA-DATA1（`yaya_*` DDL、SQL、repository 唯一 owner）。
起点：`0f135a4b19901523cd1b4cf5f11780538b63ab57`（`codex/yaya-data1`）。
消费方参考实现：MEDIA1 `6dc3cce3e1d207a915fe435aae22c118e9bb6236` 的
`src/lib/media/metadata-port.ts` / `upload-service.ts` / `attachment-service.ts` / `retention-service.ts`（只读参考，未修改 MEDIA 文件）。
本文件是该端口到 DATA1 存储签名、SQL 与事务边界的唯一映射口径；MEDIA 在组合候选只消费本接口，真实装配与联合验收在后续执行。

## 1. 权威来源与不变量

- DDL：`scripts/upgrade-yaya-v1.sql`（幂等增量）；形状镜像：`src/storage/database/shared/schema.ts`。现有 7 张业务表不变。
- 不另建第二套媒体账本：继续使用 `yaya_attachments` / `yaya_attachment_refs` / `yaya_observation_attachment_meta` / `yaya_attachment_appends`。
- 记录只存对象标识/checksum/尺寸/状态，**不含任何 URL**；`metadata` 仅作非安全补充，不作为已核验字段的替代（宽高、checksum、类型、key 都是显式列）。
- 未知删除结果保留 `deleting + delete_result='unknown'`（端口映射 `deletion_unknown`），**不恢复 ready、不伪装 deleted**；`completeDeletion(..., "failed")` 仅用于调用方确认“未产生删除效果”的场景，才允许回 ready。
- 所有新增引用（消息/提案/观察）在同一事务内先按稳定顺序锁附件行、锁后核 `ready` 与 owner，再 INSERT 引用；删除租约使用同一协调锁（附件行 FOR UPDATE），并在锁后查询完整引用。批量任一附件不合法 → 整事务回滚。

## 2. 表与字段映射

### `yaya_attachments`（R1 增量列）

| 端口字段（MEDIA） | DATA1 列 | 说明 |
|---|---|---|
| `attachment_id` | `id` | |
| `owner_account_id` | `uploader_account_id` | 同一概念；账号私有上传者 |
| `status` | `status` + `delete_result` | 见 §3 状态机；端口状态由两列映射 |
| `object_key` / `thumbnail_key` / `model_key` | `object_key` / `thumbnail_key` / `model_key` | 三个派生对象精确 key |
| `content_type` | `media_type` | 原始类型 |
| `byte_size` | `byte_size` | 原图字节数 |
| `checksum_sha256` / `thumbnail_checksum` / `model_checksum` | `checksum_sha256` / `thumbnail_checksum` / `model_checksum` | 三对象写后回读校验值 |
| `width` / `height` | `width` / `height` | 解码后像素尺寸 |
| `client_upload_id` | `client_upload_id` | 同 owner 下部分唯一（幂等） |
| `created_at` | `created_at` | |
| `deletion_lease_id` | `deletion_lease_id` | 回收租约令牌；仅 deleting 持有期间非空 |

增量约束：`(uploader_account_id, client_upload_id)` 部分唯一（`client_upload_id IS NOT NULL`）；`status ∈ pending/ready/deleting/deleted`；既有 `checksum` 列在 R1 迁移中重命名为 `checksum_sha256`（幂等 DO 块）。

### `yaya_attachment_refs`

`(attachment_id, record_kind, record_id)` 唯一；`record_kind ∈ message/proposal/observation`。
消息引用在端口层带 `conversation_id`（由 `yaya_messages` 联表得到）。

### `yaya_attachment_appends`（R1 增量列）

| 端口字段（MEDIA `AttachmentAuditEntry`） | DATA1 列 |
|---|---|
| `audit_id` | `audit_id`（R1 新增） |
| `action` | `action`（R1 新增：`attach_observation_images` / `create_observation_attachments`） |
| `observation_id` | `observation_id` |
| `attachment_ids` | `attachment_ids` jsonb（R1 新增；一条审计含全部附件） |
| `actor_account_id` | `appended_by_account_id` |
| `source_confirmed_at` | `source_confirmed_at`（R1 新增） |
| `request_id` | `request_id`（R1 新增） |
| `recorded_at` | `appended_at` |

原逐附件 revision 审计行（`attachment_id` + `attachment_revision`）保留，两列为 NULL 时表示 MEDIA 聚合审计行。

## 3. 状态机（端口 ↔ 存储）

| 存储 `status` / `delete_result` | 端口 `status` |
|---|---|
| `pending` | `pending` |
| `ready` | `ready` |
| `deleting` / `NULL` | `deleting`（租约进行中） |
| `deleting` / `unknown` | `deletion_unknown`（结果未知，可重新取得租约） |
| `deleted` / `deleted` | `deleted` |

转换：

- `insertPending`：仅 `pending`，`client_upload_id` 冲突 → `object_conflict` 语义；
- `markReady`：仅 `pending → ready`（CAS，revision+1）；其他状态 → `metadata_conflict` 语义；
- `beginDeletionLease`：先锁附件行，**锁后重新核查完整引用**（不依赖调用方的前置 `getReferenceFacts`）：`ready` 或 `deletion_unknown` 且引用查询完整且零引用 → `deleting`（新 `deletion_lease_id`，`delete_result` 清空，revision+1）；已有任何引用或引用查询不完整 → 返回 `not_ready`（状态保持原值，不进入 deleting）；`deleting`/`deleted`/`pending`/缺失分别返回 `already_deleting`/`already_deleted`/`not_ready`/`not_found`；
- `completeDeletion(id, lease_token, outcome)`：锁行并核对令牌与 `deleting` 状态；`deleted → deleted`，`unknown → deleting+unknown`，`failed → ready`（清空租约与 delete_result）；
- 端口读到的 `deletion_unknown` 允许再次 `beginDeletionLease`；任何路径不得把 `unknown` 直接变回 `ready`。

## 4. 端口方法 → DATA1 签名逐项映射

DATA1 发布两类入口（`src/lib/yaya/data/media-port.ts`，随实现提交）：

- **事务绑定**：`bindYayaAttachmentMetadataPort(client: TransactionClient): YayaAttachmentMetadataPort`
  —— 方法全部使用传入 client，不另开连接、不自行提交；供 MEDIA 在业务保存事务内绑定（创建观察附图必须在同一事务）。
- **普通短事务**：`createYayaAttachmentMetadataPort(connect?: TransactionConnect): YayaAttachmentMetadataPort`
  —— 每个方法内部 `withTransaction` 包装（缺省走 pg-client 连接池），用于无外层事务的调用。

| MEDIA `AttachmentMetadataPort` 方法 | DATA1 repository 原语（事务内） | 语义要点 |
|---|---|---|
| `findByClientUploadId(owner, client_upload_id)` | `findAttachmentByClientUploadId(client, owner, clientUploadId)` | 按 `(owner, client_upload_id)` 唯一索引查询；未命中 null |
| `insertPending(record)` | `insertPendingAttachment(client, input)` | 插入 `pending`；id/client_upload_id 冲突 → 冲突错误，不覆盖 |
| `markReady(id)` | `markAttachmentReady(client, id)` | pending→ready CAS，revision+1，返回记录 |
| `removePending(id)` | `removePendingAttachment(client, id)` | 仅 pending 可删；返回是否删除 |
| `get(id)` | `getMediaAttachment(client, id)` | 端口记录映射（含派生 key/宽高/租约） |
| `addObservationReferences({observation_id, attachment_ids, actor_account_id})` | `addObservationAttachmentRefs(client, input)` | **创建关联**：先锁附件（稳定排序）核 ready+owner，再锁 `yaya_observation_attachment_meta`，跳过已存在引用，`added` 计数，revision += added。不带版本前提 |
| `addObservationReferences({…, expected_attachment_revision})`（R2 可选字段） | `addObservationAttachmentRefsAtRevision(client, input)` | **归档追加**：提供 expected 时走同一 CAS 原语；不匹配抛 `revision_conflict` |
| `addObservationReferencesAtRevision({observation_id, attachment_ids, actor_account_id, expected_attachment_revision})` | `addObservationAttachmentRefsAtRevision(client, input)` | 归档追加的显式 CAS 入口（推荐；与 `appendObservationAttachments` 同一核心，revision+1，不写逐附件审计） |
| `getObservationAttachmentRevision(observation_id)` | `getObservationAttachmentRevisionNumber(client, observationId)` | 无 meta 行按 0 |
| `getReferenceFacts(attachment_id)` | `queryAttachmentLifecycle(client, attachmentId)` | 三种引用完整返回；悬空引用/查询失败 → 抛错（调用方按“引用查询不完整”保守拒绝回收） |
| `releaseConversationReferences({conversation_id, message_ids, owner_account_id})` | `releaseConversationAttachmentRefs(client, input)` | 先核会话 owner 属于该账号；只删指定消息在自己会话内的消息引用；返回删除条数 |
| `beginDeletionLease(id)` | `acquireAttachmentDeletionLease(client, id)` | 锁附件行后**重新核查完整引用**：零引用才发租约；有引用/查询不完整 → `not_ready`（不进入 deleting）。与旧 `beginAttachmentDeletion` 共用同一锁内引用核查原语 |
| `completeDeletion(id, lease_token, outcome)` | `completeAttachmentDeletionByLease(client, input)` | 令牌核对；三态映射见 §3 |
| `appendAttachmentAudit(entry)` | `appendMediaAttachmentAudit(client, entry)` | 独立审计行；不改 raw_text/confirmed_content |

> 说明：`getReferenceFacts` 与 `beginDeletionLease` 的分工是“先判断能否回收、后取租约”，但**租约取得时仍必须在同一锁内重新核查引用**（R2 修正）：前置查询只用于快速路径，不能作为租约的保护。DATA1 的旧 `beginAttachmentDeletion`（带 expected_revision）与媒体端口租约共用同一锁内引用核查原语，语义一致。

## 5. 错误映射（组合候选适配器必须按此表转换）

| DATA1 `YayaDataError.code` | 场景 | MEDIA `MediaError.code` |
|---|---|---|
| `attachment_missing` | 附件不存在 | `attachment_not_found` |
| `attachment_conflict`（owner 不符） | 非上传者 | `not_owner` |
| `attachment_conflict`（status deleting） | 租约中新增引用 | `attachment_deleting` |
| `attachment_conflict`（status pending/deleted） | 不可用 | `attachment_gone` |
| `revision_conflict` | 状态/revision 竞争 | `metadata_conflict` |
| `reference_incomplete` | 引用查询不完整 | `metadata_unavailable`（MEDIA 侧转为 `reference_query_incomplete`） |
| `invalid_request` | 形状不合法 | `invalid_request` |
| 唯一冲突（insertPending/insert 附件） | 幂等重复 | `object_conflict` |

DATA1 不 import MEDIA 的类型或错误，也不以 `as unknown` 冒充装配；组合候选由整合者按上表写薄适配（或直接以结构化类型消费 `YayaAttachmentMetadataPort`）。

## 6. 调用方式

```ts
// 无外层事务：普通短事务（上传、回收等）
const metadata = createYayaAttachmentMetadataPort();
await metadata.insertPending(record);

// 业务保存事务内：绑定同一 client（创建观察附图、归档后追加）
await withTransaction(async (client) => {
  const bound = bindYayaAttachmentMetadataPort(client);
  await associateObservationImagesOnCreate({ metadata: bound, ... }, input);
  // ……同一事务内写业务记录
});
```

约束：绑定版方法不得自行 BEGIN/COMMIT；短事务版方法不得在已有事务内调用（否则会另开连接，违反同一事务口径）。两者都不在对象存储等待期间持有数据库事务——对象 I/O 在事务外，只有元数据/引用/审计在事务内。

## 7. 实现与验证状态

- 本文件为接口声明提交（`7182677a37eea3a96785827d815343dc38d400e6`）；实现（迁移增量、storage-types DTO、`src/lib/yaya/data/media-port.ts` 工厂与 repository 原语）随 R1 实现提交落地，见 `docs/yaya-v1/data1-r1-delivery.md`。`YAYA_MEDIA_INTERFACE_REVISION = "yaya-media-storage-r1"` 标明口径版本。
- 验证：R1 隔离库检查覆盖 `client_upload_id` 幂等、pending→ready CAS、三派生对象持久化、租约令牌/unknown 无损与重取、四类引用写入的受控双连接互斥、仅解除自己会话引用、观察 revision CAS 与独立聚合审计、现有 7 表列签名不变。
- NOT_RUN（本声明范围）：真实 S3/桶、MEDIA 正式装配、浏览器、端到端业务闭环。
