# YAYA-MEDIA1-R1 交付｜回收租约原子协调、上传未知结果恢复、附图原子条件

- 起点 SHA：`6dc3cce3e1d207a915fe435aae22c118e9bb6236`（沿 `codex/yaya-media1` 追加；工作树 `%TEMP%\opencode\child-growth-yaya-media1`）。
- 状态：A/B/C 三项修复完成；原 28 项验收保留并通过；新增 20 项 RED→GREEN 反例全部通过；DATA 逐方法映射表见第 4 节。
- 未改：DATA SQL/schema/storage-types、冻结类型、AUTH/G0、业务 queries、LLM/UI、package/lock、harness（blob 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，preflight 校验通过）。

## 1. RED→GREEN（主评审复现的原始行为 vs 修复后）

用同一探针（双兼容替身，只调用公开服务 `recycleAttachment` / `uploadImages` / `appendObservationImages`）在旧提交与新实现上运行：

| 场景 | 旧 `6dc3cce`（RED） | 新（GREEN） |
|---|---|---|
| A 引用在“前置查询后、租约前”成立 | `a_status=deleted`、`a_objects_delta=-3` | `a_status=referenced`、`a_objects_delta=0` |
| B 注册已提交但响应丢失 | `b_first_ok=false`、`b_persisted_status=ready`、`b_objects_after_first=0`、`b_retry_ok=true` | `b_first_ok=true`、对象保留（+3）、`b_retry_ok=true` 且同一 attachment_id、对象不再新增 |
| C 两个并发追加同 `expected_revision=0` | `c_fulfilled=2`、`c_rejected=0` | `c_fulfilled=1`、`c_rejected=1`（`revision_conflict`） |

RED 输出（旧提交，探针 exit 1）与 GREEN 输出（修复后，`all_ok=true`）已按原样记录；探针与临时 worktree 已在提交前删除/移除。

## 2. 修复内容

### A 无引用核验与删除租约原子协调

- 前置 `getReferenceFacts` 只作快速判断；许可来自 `beginDeletionLease({attachment_id, expected_revision})`
  在**共同原子边界**重查完整引用集合 + ready/revision CAS：
  引用先成立→`referenced`；租约先成立→`link/append` 均被 `attachment_deleting` 拒绝；
  查询与租约之间新增引用→租约拒绝；revision 变化→`revision_conflict`；悬空引用/查询失败→`reference_query_incomplete`。
- 未知删除统一为 `deleting + delete_result="unknown"`（服务结果名保留 `deletion_unknown`）：不可新增引用、不恢复 ready；
  可凭当前 revision 重试删除并 `commitDeletion`；`deleting + delete_result=null` 视为租约进行中（`lease_busy`），不删对象。
- 对象删除仍在数据库事务外，只删记录中的三个精确 key；落账失败不假成功（对象可能已删、记录保持可核验 deleting 并如实报错）。

### B 上传未知结果不得破坏已提交对象

- **异常 ≠ 未提交**：注册异常后按原 `attachment_id` 读回；已提交且记录完整 → 恢复原结果（不重复写对象）；
  读回失败/未找到 → `upload_unknown` + 可恢复身份（`recoverable.attachment_id`），**保留对象**。
- **幂等与内容绑定**：带 `client_upload_id` 使用确定性 attachment_id（`sha256(owner+client)` 前 32 hex，UUID 形）；
  同键同内容恢复、同键异内容 `idempotency_conflict`；记录完整性逐字段校验，不默认 ready、不伪造 checksum。
- **补偿边界**：只有对象写入阶段失败（注册尚未发生）且无幂等键时才精确补偿本轮创建的 key；
  带幂等键保留对象供重试复用（避免与并发重复请求/迟到提交竞争）；`delete` 返回 unknown/抛错 → `compensation_unknown`，不宣称清理成功；
  不按前缀扫描清空；逐图结果，一张未知不影响其余图片与文字。

### C 附图 expected_revision 进入共同原子保存条件

- `appendObservationAttachments` 端口在**单一原子边界**内完成：附件 ready/owner 校验 → 观察级
  `expected_attachment_revision` CAS → 引用写入 + 追加审计（含 `source_confirmed_at`/`request_id`/`approval_id`）→ revision+1；
  服务层不再“先读后比较”；部分附件不可用时不产生任何半成功引用与修订。
- 创建观察关联走 `linkObservationReferences`（随创建事务、不递增追加修订、不写追加审计）；
  归档后追加不改 raw_text/confirmed_content；授权/确认来源/所有权/管理员只读守门保留。

## 3. 端口变化（v1 → v2）

| v1 | v2（对齐 DATA 已发布 repository） |
|---|---|
| `pending/ready/deleting/deleted/deletion_unknown` 状态 | `ready/deleting/deleted` + `revision` CAS + `delete_result`（未知=deleting+unknown） |
| `insertPending` / `markReady` / `removePending` | `registerAttachment`（单次原子登记，insert 即 ready） |
| `findByClientUploadId` | 确定性 `attachment_id` + `get` 读回（`client_upload_id` 存 metadata） |
| `addObservationReferences`（无 CAS） | `linkObservationReferences`（创建）/ `appendObservationAttachments`（归档追加，含 expected_revision+审计） |
| `beginDeletionLease(id)`（无 revision、不重查引用） | `beginDeletionLease({id, expected_revision})`（原子重查引用 + CAS） |
| `completeDeletion(id, lease_token, outcome)` | `commitDeletion({id, expected_revision})` / `failDeletion({id, expected_revision})` |
| `releaseConversationReferences` | 移除：该语义归 DATA `deleteConversation`（返回解除/无引用候选） |
| `appendAttachmentAudit` | 移除：追加审计由 `appendObservationAttachments` 原子写入 |

新增错误码：`idempotency_conflict`、`upload_unknown`、`compensation_unknown`、`attachment_conflict`；
`MediaError` 支持内部 `details`（可恢复身份，不保证对外暴露）。

## 4. DATA 逐方法需求与映射表（`src/lib/yaya/storage-types.ts` @ `0f135a4`）

| MEDIA1 端口 v2 | DATA repository | 映射 | 缺口 / 对 DATA 的要求 |
|---|---|---|---|
| `get(id)` | `getAttachment(client,id)` | 标量字段直映；`thumbnail_key/model_key/thumbnail_checksum/model_checksum/width/height/source_checksum/client_upload_id` 从 `metadata` jsonb **逐字段解析校验**；缺失/空白→记录不完整→`upload_unknown`/冲突，不默认 ready、不做类型强转 | DATA 保证 metadata jsonb 原样往返；不改 DATA 文件 |
| `registerAttachment(input)` | `registerAttachment(client,input)` | `object_key/checksum/byte_size/media_type`=原图；`source_kind="raw_input"`、`derived_from=null`；扩展字段在 `metadata={schema:"media1-v1",width,height,thumbnail_*,model_*,source_checksum,client_upload_id,environment}`；`attachment_id` 由 MEDIA 生成 | ①DATA 无 `client_upload_id` 列/查询：owner+client 幂等由**确定性 attachment_id + metadata.source_checksum** 完成；②DATA 单次 ready 写入无 pending：MEDIA 不假设 pending，异常后读回 |
| `getReferenceFacts(id)` | `queryAttachmentLifecycle(client,id)` | `reference_query_complete` 与 message/proposal/observation 三类直映；悬空引用→false | false 一律 `reference_query_incomplete`（读取与回收保守拒绝） |
| `beginDeletionLease({id,expected_revision})` | `beginAttachmentDeletion(client,{attachment_id,expected_revision,actor_account_id})` | DATA 同事务 `FOR UPDATE` 附件行→refs>0 抛 `attachment_referenced`→CAS ready+revision→deleting；`linkAttachmentRef` 同锁行，引用与租约互斥。异常码映射：`attachment_referenced→referenced`、`revision_conflict→revision_conflict`、`attachment_missing→not_found`、`attachment_conflict→not_ready` | ①`actor_account_id`：MEDIA 回收无 principal（候选来自 DATA 会话删除/运维），装配时由调用方提供系统/操作者身份；②DATA 在同一事务重查引用，满足“前置查询不能单独授权删除” |
| `commitDeletion` | `commitAttachmentDeletion` | 直映；`expected_revision`=租约返回的新 revision | — |
| `failDeletion` | `failAttachmentDeletion` | 直映：保持 `deleting+delete_result=unknown`，不恢复 ready | — |
| `linkObservationReferences` | 逐附件 `linkAttachmentRef` | 创建观察事务内调用（同一 TransactionClient 全有或全无）；不递增 revision、无审计（与 DATA 创建路径一致）；MEDIA 端口内先整体校验再写入 | DATA 无批量方法；事务回滚兜底 |
| `appendObservationAttachments` | `appendObservationAttachments` | 单一原子边界：ready+owner 校验→观察 revision CAS→引用+审计→revision+1；MEDIA 传入 `source_confirmed_at/request_id` | **DATA `yaya_attachment_appends` 无 `source_confirmed_at/request_id` 列**（仅 approval_id/note）：要求 DATA 增加来源前提列或等价共同保存条件；MEDIA 不把来源塞进 note、不伪造审计 |
| `getObservationAttachmentRevision` | 同名 | 直映（view→数字） | 仅核对/测试，权威判定在 append CAS |
| 会话删除解除引用 | `deleteConversation` | `detached_attachment_ids/unreferenced_attachment_ids` 只是回收候选；MEDIA 不再提供该端口方法 | 语义归 DATA；MEDIA 消费候选后再走自身生命周期检查 |

### 逐条需求覆盖

- **owner+client_upload_id 内容绑定与幂等**：确定性 attachment_id + `metadata.source_checksum`；同键同内容恢复、异内容 `idempotency_conflict`（B6 反例）。
- **pending→ready 及未知结果读回**：DATA 单次 ready；MEDIA 注册异常后读回恢复/未知保留（B2/B3/B4）。
- **original/thumbnail/model 三对象及各 checksum/尺寸**：DATA 一列集承载原图；派生对象与尺寸在 metadata jsonb；缺失按不完整拒绝（C5）。
- **删除租约身份、状态、revision 和未知删除**：revision CAS；无 lease token（身份=revision）；未知=deleting+unknown（A6/A7/原 21/25）。
- **全部引用类别**：三类引用查询 + `linkAttachmentRef` 通用写入（A4）。
- **创建关联/归档追加的事务、expected_revision 和审计**：C1–C4 与映射表。

未使用类型强转、默认 ready、伪造 checksum 或空引用填平差异；不复制 SQL、不改 DATA 文件。

## 5. 验收与证据

- `check-media.ts`：**28/28**（原 28 项语义保留；补偿/租约项按 R1 语义更新为“未知结果保留对象、失败不恢复 ready”）。
- `check-media-r1.ts`：**20/20**（A1–A7、B1–B7、C1–C6；含引用先成立/租约先成立/查询与租约之间新增引用/多引用共享照片/悬空与查询失败/revision 不匹配/未知状态不可引用；提交前失败/提交后响应丢失/读回失败/迟到提交交错/补偿删除未知/同键同内容与异内容/混合批次；并发同前提一成功一冲突/部分附件不半成功/审计与修订同源/来源前提入边界/完整性拒绝）。
- `pnpm ts-check`、`pnpm lint:build`、`pnpm lint:style`、`pnpm next build`（四条路由与构建产物正常）全部通过。
- 回归：`check-contract` 68/68、`check-preflight` 15/15、`check-tech0`、`check-runtime-tech0.cjs` 通过；harness blob 未变。
- 分层：真实 sharp 处理 + 自有本地对象 I/O；元数据为内存替身（与 DATA 语义逐条对齐）；真实 egress 0/0/0/0，未读 `.env`，预算未动。

## 6. 清理与 NOT_RUN

- 临时 RED worktree（`%TEMP%\opencode\media1-r1-red`，含 node_modules junction）已移除；临时探针/调试脚本已在提交前删除；每次 check 的自有临时目录按身份删除（输出 `cleanup:removed`）；未占端口、未动他方资源。
- NOT_RUN（留装配验收）：真实 DATA repository 联合装配（`bindMediaRuntime` 绑真实附件 repository；创建观察事务内绑定同一 client）；
  DATA `actor_account_id`（回收操作者身份）与 `yaya_attachment_appends.source_confirmed_at/request_id` 列；真实桶/浏览器/真实模型看图；回收候选（`unreferenced_attachment_ids`）到 MEDIA 回收的正式编排。
- 停止：仅本地提交，不 push/部署/merge main；不进入 UI 或正式平台 tool 装配。
