/**
 * MEDIA1 模块出口。
 *
 * 装配要点（DATA1/整合者）：
 * - 实现 AttachmentMetadataPort v2（真实 repository，DDL 由 DATA1 拥有；
 *   逐方法映射与缺口见 docs/yaya-v1/media1-r1-delivery.md）；
 * - 用 createObjectStore(loadMediaStorageConfig()) 取环境对应的对象存储；
 * - bindMediaRuntime({ metadata, store, environment }) 后路由即生效；
 * - 创建观察事务内调用 associateObservationImagesOnCreate（端口绑定同一事务）。
 */

export {
  MEDIA_MAX_IMAGES_PER_UPLOAD,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_ALLOWED_CONTENT_TYPES,
  MEDIA_MAX_PIXELS,
  MEDIA_VARIANTS,
  MEDIA_SIGNED_URL_MAX_TTL_SECONDS,
  assertShortSignedUrlTtl,
  variantContentType,
  type MediaContentType,
  type MediaVariant,
} from "./limits";
export { MediaError, mediaErrorBody, mediaErrorStatus, type MediaErrorCode } from "./errors";
export {
  assertBucketIdentityIsolated,
  buildObjectKey,
  createObjectStore,
  loadMediaStorageConfig,
  type MediaEnvironment,
  type MediaStorageConfig,
} from "./config";
export {
  assertSafeObjectKey,
  sha256Hex,
  type MediaObjectStore,
  type ObjectDeleteOutcome,
  type ObjectPutOutcome,
  type ObjectPutResult,
} from "./object-store";
export { LocalMediaObjectStore } from "./object-store-local";
export { S3MediaObjectStore, type S3MediaStoreConfig } from "./object-store-s3";
export {
  assertWithinPixelLimit,
  processImage,
  sniffImageContentType,
  type ProcessedImage,
} from "./image-processing";
export {
  ATTACHMENT_STATUSES,
  type AppendObservationAttachmentsInput,
  type AppendObservationAttachmentsResult,
  type AttachmentAuditEntry,
  type AttachmentDeleteResult,
  type AttachmentMetadataPort,
  type AttachmentRecord,
  type AttachmentReferenceFacts,
  type AttachmentStatus,
  type DeletionLeaseResult,
  type RegisterAttachmentInput,
} from "./metadata-port";
export { MemoryAttachmentMetadata, type MemoryMetadataFailpoint } from "./metadata-memory";
export { bindMediaRuntime, createLocalMediaRuntime, mediaRuntimeOrThrow, type MediaServiceDeps } from "./runtime";
export {
  attachmentRecordIsComplete,
  contentAttachmentId,
  deterministicAttachmentId,
  toAttachmentView,
  uploadImages,
  type UploadAttachmentView,
  type UploadBatchInput,
  type UploadBatchResult,
  type UploadFileInput,
  type UploadFileResult,
} from "./upload-service";
export {
  attachmentMetadataView,
  evaluateAttachmentRead,
  loadAttachmentContent,
  type AttachmentMetadataView,
  type AttachmentReadEvaluation,
  type MediaViewer,
  type RecordAccessLoader,
} from "./content-service";
export {
  appendObservationImages,
  associateObservationImagesOnCreate,
  assertHostChildWrite,
  type AppendObservationImagesInput,
  type CreateObservationAttachmentInput,
  type HostObservationFacts,
} from "./attachment-service";
export {
  recycleAttachment,
  type RecycleObjectOutcome,
  type RecycleResult,
} from "./retention-service";
export { requireMediaReadPrincipal, requireMediaWritePrincipal } from "./request-guard";
export {
  createDatabaseRecordAccessLoader,
  observationAccessFacts,
  observationRecordAccess,
} from "./record-access";
