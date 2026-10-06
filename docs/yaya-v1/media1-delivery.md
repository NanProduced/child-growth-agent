# YAYA-MEDIA1 交付｜真实图片管线与授权引用服务

- 状态：实现完成，离线可运行验收通过；**真实桶、浏览器选图、真实模型看图、资料追加正式 DB 闭环为 NOT_RUN**（留给装配验收）。
- 共同基线：`11f87ab0d2224d273696ecb86a544768eb014f39`；分支 `codex/yaya-media1`；工作树 `%TEMP%\opencode\child-growth-yaya-media1`。
- 只提交自有文件；未改共享 types/AUTH/G0/业务 queries/LLM/UI/package/lock/harness/schema；未 push/部署/merge main。
- RTK：`RTK.md` 不存在（记录）；`rtk.exe` 存在于 `C:\Users\nanpr\.cargo\bin`，但无 grep 过滤器且未安装 hook，实际使用原生命令。

## 1. 文件与归属

| 文件 | 内容 |
|---|---|
| `src/lib/media/errors.ts` | 媒体错误码与 HTTP 映射 |
| `src/lib/media/limits.ts` | 8 图/次、10MiB/图、JPEG/PNG/WebP、40MP 像素上限、派生图规格、短 TTL 守卫 |
| `src/lib/media/object-store.ts` | 对象存储端口（只精确 key；无 list/前缀操作）、checksum、key 校验 |
| `src/lib/media/object-store-local.ts` | 本地文件系统替身（真实 I/O、写一次、回读校验、精确删除） |
| `src/lib/media/object-store-s3.ts` | S3 适配器（真实实现，`IfNoneMatch` 写一次 + HeadObject 回读；本任务不调用真实桶） |
| `src/lib/media/config.ts` | 环境/桶身份隔离、对象键、存储组装、fail-closed 配置加载 |
| `src/lib/media/image-processing.ts` | 魔数识别、解码/像素上限、EXIF 移除、缩略图（WebP）与模型图（JPEG） |
| `src/lib/media/metadata-port.ts` | **AttachmentMetadataPort**（冻结语义；DDL/repository 归 DATA1） |
| `src/lib/media/metadata-memory.ts` | 元数据进程内替身（状态机/CAS 租约/失败点注入；非生产 repository） |
| `src/lib/media/upload-service.ts` | 上传编排、逐图错误保留、幂等、半上传补偿 |
| `src/lib/media/content-service.ts` | 授权读取（复用冻结 `decideImageReadAccess`）、认证内容代理、checksum 核对 |
| `src/lib/media/attachment-service.ts` | 创建关联（事务内）与归档后追加（attach_observation_images） |
| `src/lib/media/retention-service.ts` | 引用保护、删除租约、精确回收、只解除自己会话引用 |
| `src/lib/media/request-guard.ts` | 账号私有读写守门（复用 AUTH 会话/CSRF，不虚构 AUTH action） |
| `src/lib/media/runtime.ts` | `bindMediaRuntime` / `mediaRuntimeOrThrow`（未绑定 fail closed 503） |
| `src/lib/media/record-access.ts` | 观察记录读取投影（`authorizeAction(observation.read)`） |
| `src/lib/media/route-error.ts` / `index.ts` | 路由错误映射与模块出口 |
| `src/app/api/yaya/uploads/route.ts` | POST 上传（multipart） |
| `src/app/api/yaya/uploads/[id]/route.ts` | GET 附件元数据 |
| `src/app/api/yaya/uploads/[id]/content/route.ts` | GET 认证内容代理（original/thumbnail/model） |
| `src/app/api/observations/[id]/attachments/route.ts` | POST 归档后追加资料（`attach_observation_images`） |
| `scripts/yaya/check-media.ts` | 离线可运行验收（28 项） |

## 2. 导出端口、方法与路由

### AttachmentMetadataPort（DATA1 实现接口）

- `findByClientUploadId(owner, client_upload_id)` / `insertPending(record)` / `markReady(id)` / `removePending(id)` / `get(id)`
- `addObservationReferences({observation_id, attachment_ids, actor_account_id}) → {added, attachment_revision}`
  （**必须在业务保存同一事务内调用**；逐附件校验 `status=ready`，原子递增宿主观察 attachment revision）
- `getObservationAttachmentRevision(observation_id)`
- `getReferenceFacts(attachment_id)`（观察全状态 + 消息 + 提案；查询不完整必须抛错，不得返回空集）
- `releaseConversationReferences({conversation_id, message_ids, owner_account_id})`
- `beginDeletionLease(id)`（CAS：ready/deletion_unknown → deleting 租约）
- `completeDeletion(id, lease_token, "deleted"|"unknown"|"failed")`
- `appendAttachmentAudit(entry)`（独立追加审计）

记录只保存 object key/checksum/尺寸/状态，**不含任何 URL**。

### 服务导出（`src/lib/media/index.ts`）

- `uploadImages(deps, {owner_account_id, files}) → {uploads[]}`（逐图 ok/error）
- `evaluateAttachmentRead` / `attachmentMetadataView` / `loadAttachmentContent`
- `associateObservationImagesOnCreate(deps, input)`（创建观察事务内）
- `appendObservationImages(deps, input)`（归档后追加；核 status/source_confirmed_at/revision/所有权 + 审计）
- `assertHostChildWrite(principal, host)`（observation.write/child，管理员 forbidden_role）
- `recycleAttachment(deps, {attachment_id}) → {status, objects[]}`；`releaseConversationReferences`
- `bindMediaRuntime` / `mediaRuntimeOrThrow` / `createLocalMediaRuntime`
- 装配：`bindMediaRuntime({metadata: DATA1 repository, store: createObjectStore(loadMediaStorageConfig()), environment})`；
  创建观察事务内用绑定同一事务的端口调用 `associateObservationImagesOnCreate`。

### 路由

| 路由 | 守门 | 说明 |
|---|---|---|
| `POST /api/yaya/uploads` | 同源 + 会话 + CSRF | 最多 8 文件；`client_batch_id` 幂等；逐图结果；无 URL |
| `GET /api/yaya/uploads/[id]` | 会话 | 元数据投影（历史只读仅元数据；无权限 403） |
| `GET /api/yaya/uploads/[id]/content?variant=…` | 会话 | 认证代理字节；`metadata_only`/越权 403、对象缺失 410；`private, no-store` |
| `POST /api/observations/[id]/attachments` | `runBusinessWrite(observation.write, child)` + 服务内复核 | 追加资料；不改 raw_text/confirmed_content；管理员只读 |

## 3. 输入限制与冻结口径

- 每次最多 **8** 张、单图 **10MiB**、**JPEG/PNG/WebP**（服务端魔数 + 解码 + 40MP 像素上限；不信任声明类型/文件名）。
- 不支持格式**逐图**明确报错，其他图片与文字保留；不抓取任何远程 URL。
- 对象只写一次 + 写后回读 checksum；只存对象引用；不存长期公开/签名 URL（必要签名须 1–300s，`assertShortSignedUrlTtl` 守卫）。
- 账号私有上传不要求幼儿或 ≥10 字；未关联仅上传者；已关联按 `record_kind + record_id`；历史只读仅元数据。
- 图像处理移除 EXIF（含拍摄时间）并生成缩略图/模型图；拍摄时间/人脸不识别幼儿、不决定观察日期；共同照片多引用不复制对象。
- 创建观察附图随业务事务；归档后追加核宿主幼儿 observation.write/child、source_confirmed_at、附件 revision、所有权；独立审计；不自动成为指南证据。
- 删除聊天只解除自己会话引用；全状态观察 + 提案 + 其他消息引用保护；引用查询不完整不删；回收 CAS deleting 租约阻止新引用，外部删除在事务外，未知结果保留 `deletion_unknown` 可核验状态；只删记录中的精确 key，不按前缀清空。
- 开发/生产桶身份隔离（同 endpoint+桶即拒绝），前缀只作命名，不是权限。

## 4. 证据（本轮真实执行）

- `pnpm exec tsx scripts/yaya/check-media.ts`：**28/28 通过**，exit 0；输出
  `{"passed":28,"total":28,"failures":[],"real_egress":{"database":0,"s3":0,"model":0,"search":0}}`，
  清理输出 `{"cleanup":"removed",...}`。覆盖：坏魔数/坏解码/超字节/42MP 超像素、真实 EXIF 合成 JPEG 的移除与派生图、
  混合批次逐图保留、8/9 张边界、声明类型不符、写一次同/异字节、markReady/insertPending 失败补偿且不按前缀清空、
  未关联/已关联/历史只读/管理员授权正反例、篡改对象拒绝返回、引用查询不完整保守拒绝、
  创建关联与归档后追加（revision/source/未确认/非本人/管理员/越权/撤权）、共享多引用不复制、
  删除租约阻断与失败恢复、四状态观察+提案+其他会话引用保护、只解除自己引用、精确回收、
  未知删除结果保留并可重试、租约互斥、桶身份隔离与配置 fail closed、短 TTL 守卫。
- `pnpm ts-check`、`pnpm lint:build`、`pnpm lint:style` 全部通过。
- `pnpm next build` 通过，四条新路由出现在构建产物。
- 回归：`check-contract.ts` 68/68、`check-preflight.ts` 15/15、`check-tech0.ts`、`check-runtime-tech0.cjs` 均通过；
  `scripts/harness-safety.ts` blob 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`（preflight 校验通过）。
- 分层口径：图像处理为**真实 sharp 解码/编码**；对象 I/O 为**自有本地目标**（S3 适配器为真实代码未调用）；
  元数据为**进程内替身**（与 DATA1 repository 同语义）；无数据库/模型/搜索/真实 S3 请求，未读 `.env`，预算未动。

## 5. NOT_RUN / 待装配

1. 真实桶上传/签名/开发生产桶隔离核对（需桶授权）。
2. DATA1 repository 接入：`bindMediaRuntime` 绑真实元数据 + 创建观察事务内调用关联服务（正式 DB 闭环）。
3. 浏览器选图/拍照、真实模型看图、助手 UI 附件卡。
4. 真实账号 HTTP 联调（本任务路由为真实代码，未起服务）。
5. 消息/提案引用的写入路径归 DATA1 会话/提案流程（端口读取侧已定义）。

## 6. 清理与停止

- 自有临时目录 `%TEMP%\opencode\yaya-media1-check-*` 每次运行按身份精确删除（输出 `cleanup:removed`）。
- 未占用任何端口；未清理/占用他人资源；未改其他工作树。
- 生成物 `.next/` 为 gitignore；构建改写的 `next-env.d.ts` 已精确恢复。
- 停止：等整合者接入 DATA1 repository 与 UI/装配验收；不自行改 DATA1 或 UI。
