# YAYA-DATA1-R1 交付：私域投影、引用锁互斥与媒体存储接口

状态：实现完成，隔离库与全部回归通过；等整合者接入（不自行开始 TOOLS1）。
起点：`0f135a4b19901523cd1b4cf5f11780538b63ab57`（`codex/yaya-data1`）。
接口声明先行提交：`7182677a37eea3a96785827d815343dc38d400e6`（`docs/yaya-v1/media-storage-interface-r1.md`）。
实现提交：见本轮最终报告（本文件同批提交）。
harness blob：`6702f2ddf3b436e79f8c92ae8756c33f611a8503`（未修改，preflight 校验通过）。`RTK.md` 不存在（仅记录）。未读 `.env`，真实 provider/搜索/S3 请求 0，预算 40/40 未动。

## 1. 修复项与逐项 RED→GREEN

### A：对外响应真正移除受限标题与内容

根因：`projectConversationSummary` 用 `{...view}` 保留了内部 `title`；消息保存/列表/幂等/改名/删除响应直接返回 `toConversationView`；损坏 `title_source_fragments` 被 `[]` 兜底，等价“无来源手工标题”。

修复：
- 新增对外投影 DTO `YayaConversationSummaryView`（只有 `projected_title`/`title_restricted` 与白名单字段），**不含原始 `title` / `title_source_fragments`**；`YayaConversationView` 明确标注“内部存储视图，绝不可直接序列化”。
- 所有会话/消息响应路径统一投影：list/detail、POST、幂等回放、PATCH、DELETE、消息保存/列表；错误体不携带标题。
- `toConversationView` 对损坏/缺失来源返回 `null`（受限语义）；`projectConversationView` 对 `null` 直接回退“受限会话”。
- 非 full 片段 `provenance` 一律 `null`（label/ref_id/derived_from 不得成为泄漏旁路）。
- GET 不写库、不续期、不调模型（模型守门 0 命中）。

RED（当前实现实测，A/B 脚本 `--` 修复前 19 项失败中的 11 项）：受限派生标题原样出现在 detail/rename/delete/list/message 响应；`title`/`title_source_fragments` 字段存在；损坏来源被当作手工标题放行；受限 provenance.label 出现在消息响应。
GREEN：`check-data-r1-db.ts` 58/58；同一响应全文断言不含 `PRIVATE_*` 标记，正向对照（手工标题、可读派生标题、普通正文、完整 provenance）全部保留。

### B：所有新增附件引用共享租约互斥边界

根因：`assertAttachmentsReadyForOwner` 是无锁 SELECT；saveMessage / prepareProposal / appendObservationAttachments 先查后插；仅 linkAttachmentRef 用 `FOR UPDATE`。FK 的 KEY SHARE 只能挡住“先写引用再取租约”，挡不住“先取租约后写引用”（非键列 UPDATE 与 KEY SHARE 相容）。

修复：新增唯一协调原语 `lockAttachmentsForReference`：附件 id 去重后按 `attachment_id` 稳定排序 `FOR UPDATE`，锁后核存在/owner/`status=ready`；接入全部四个引用写入方（消息、提案、观察追加、通用 link）与媒体端口 `addObservationReferences`。删除租约在同一附件行上锁并锁后查完整引用；观察追加的锁序统一为「附件（排序）→ observation meta」。

RED（实测）：`saveMessage` / `prepareProposal` / `appendObservationAttachments` 在“租约先成立（未提交）”时仍写入引用并提交（3×2 项失败）；多附件逆序写入同样穿透。
GREEN：四个写入方 × 两方向受控双连接 16 项 + 多附件锁序 3 项全部通过——引用先成立时租约阻塞并最终 `attachment_referenced`；租约先成立时写入阻塞并在租约提交后 `attachment_conflict`，最终行状态证明无半条消息/提案/引用/审计（`check-data-r1-db.ts` 58/58 内）。

### C：提案 owner 不能替代业务来源权限

根因：`getProposal` 只核 owner 返回完整 payload；`evaluateAttachmentAccess` 对本人提案引用直接 full。

修复：
- 新增 `getProjectedProposal`（`GET /api/yaya/proposals?proposal_id=` 使用）：owner 边界后逐项按**当前**业务来源 `readAccessResourceFacts + authorizeAction` 投影；`access ∈ full/historical_read_only/denied/unavailable/broken`，非 full 时 `payload=null`；保留 `operation_id` 等恢复身份，不用 404 掩盖恢复。
- 提案图片引用按业务记录投影：`evaluateAttachmentAccess` 的 proposal 分支改为读取条目的资源引用并重核当前权限；多引用继续走冻结 `decideImageReadAccess`（full 优先、顺序无关）。内部执行读取仍用 `getProposal`。
- 管理员/他人提案仍 404；operation 回执按 owner 查询不受撤权影响。

RED（实测 7 项）：撤权/转班后 payload 仍返回；无 `attachments` 投影；历史只读未按元数据限制。
GREEN：撤权、转班、仅旧提案图片、旧提案+正式观察双引用、历史只读仅元数据、有效 full 引用优先、管理员 404、同 owner 正常对照、原 operation 查询矩阵全部通过（`check-data-r1-media-db.ts` 56/56）。

### D：媒体附件存储接口（MEDIA 消费）

声明：`docs/yaya-v1/media-storage-interface-r1.md`（先行提交 SHA `7182677a`）。实现：
- 迁移增量（幂等）：`yaya_attachments` 增加 `client_upload_id`（同 owner 部分唯一）、`thumbnail_key`/`model_key`、三个 checksum、`width`/`height`、`deletion_lease_id`；`checksum` 重命名 `checksum_sha256`；状态词表加 `pending`；`yaya_attachment_appends` 增加 `audit_id`/`action`/`attachment_ids`/`source_confirmed_at`/`request_id`，逐附件列可为 NULL 以承载 MEDIA 聚合审计。
- repository 原语：`findAttachmentByClientUploadId`、`insertPendingAttachment`、`markAttachmentReady`（pending→ready CAS）、`removePendingAttachment`、`getMediaAttachment`、`addObservationAttachmentRefs`（锁+幂等 added/revision）、`getObservationAttachmentRevisionNumber`、`getMediaAttachmentReferenceFacts`（悬空→`reference_incomplete` 抛错）、`releaseConversationAttachmentRefs`（只解除指定 owner 会话消息引用）、`acquireAttachmentDeletionLease`（ready/deletion_unknown 可取，令牌落库）、`completeAttachmentDeletionByLease`（令牌核对；unknown 保留 deletion_unknown，failed 才回 ready）、`appendMediaAttachmentAudit`。
- 端口工厂：`bindYayaAttachmentMetadataPort(client)`（事务绑定）与 `createYayaAttachmentMetadataPort(connect?)`（短事务），方法名与 MEDIA `AttachmentMetadataPort` 结构一致；错误码映射表见接口文档 §5。未编辑任何 MEDIA 文件，未用 `as unknown` 冒充装配。

RED（实测 10 项）：能力/端口不存在或不可用（方法存在性断言）、C 相关投影失败。
GREEN：client_upload_id 幂等与 owner 隔离、pending 不可引用/不可取租约、pending→ready CAS、removePending、added/revision 幂等、悬空引用拒绝、只解除自己会话引用、租约令牌/错误令牌/unknown 无损/重取/deleted 终态、聚合审计落库、绑定与短事务端口可用，全部通过（56/56）。

## 2. 验收命令与结果（本轮实际执行）

| 检查 | 结果 |
|---|---|
| `pnpm ts-check` / `pnpm lint:build` | 通过 |
| `check-data.ts`（旧纯 27） | 27/27（仅状态词表断言随 D 扩展为含 `pending`，其余断言未动） |
| `check-data-r1.ts`（新纯） | 9/9 |
| `check-contract.ts` / `check-preflight.ts` | 68/68 / 15/15 |
| `check-auth-contract.ts` / `check-guide-contract.ts` | 36/36 / 19/19 |
| `check-data-db.ts`（旧实库 116） | 116/116（迁移两次、现有 7 表列签名不变） |
| `check-data-r1-db.ts`（A+B） | 58/58 |
| `check-data-r1-media-db.ts`（C+D） | 56/56 |
| `check-business-access.ts`（旧业务访问） | 113/113 |

## 3. 分层口径（不混称）

- 纯函数/替身：`check-data*.ts`（无数据库/网络）。
- 隔离库 + 真实事务：`check-data-db`、`check-data-r1-db`、`check-data-r1-media-db`（一次性本地 Docker PostgreSQL，标签 `child-growth-agent.data1-r1*`；真实 repository + 受控双连接）。
- 真实 HTTP：上述 DB 脚本以真实 route handler + `NextRequest`（Cookie/Origin/CSRF）走完整请求语义；**未启动 Next server**。
- 业务回调仍为 DATA1 自有 SQL 替身（非 TOOLS1 正式装配）；MEDIA 端口仅数据面，真实 S3/桶、MEDIA 路由、浏览器、端到端业务闭环 NOT_RUN。

## 4. 资源与清理

- 每次检查独立一次性容器，结束按容器 ID + 标签核验删除；RED 运行中的中断/失败路径经 finally 清理，事后核对无残留。
- `startModelRequestGuard` 全程启用，`guard.hits === 0`；未读 `.env`、未连托管库、未调用模型/搜索/S3。
- 生成物：无（`.next` 未生成）；临时日志文件已删除。

## 5. 接入差异与停止点

- `GET /api/yaya/proposals?proposal_id=` 现在是**投影响应**（`items[].payload` 仅 full）；执行内部读取不受影响。
- 会话响应 DTO 换为 `YayaConversationSummaryView`；`renameConversation`/`deleteConversation` 输入改为 `{ principal, school_id, conversation_id, expected_revision, ... }`。
- 附件 DTO 字段 `checksum` → `checksum_sha256`；状态数组新增 `pending`。
- MEDIA 接入按 `media-storage-interface-r1.md` 的工厂与错误映射表；正式装配与联合验收在后续组合候选执行。
- 按任务要求停止，不创建 operations POST、不开始 TOOLS1。
