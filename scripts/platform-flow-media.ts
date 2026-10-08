import assert from 'node:assert/strict';
import { createDataAttachmentMetadataPort } from '../src/lib/media/data-adapter';
import { LocalMediaObjectStore } from '../src/lib/media/object-store-local';
import { sha256Hex, type MediaObjectStore } from '../src/lib/media/object-store';
import { recycleAttachment } from '../src/lib/media/retention-service';
import { uploadImages, recycledContentAttachmentId, type UploadBatchResult } from '../src/lib/media/upload-service';
import { createAcceptanceSeed } from './yaya/acceptance/seed';
import { syntheticSharedPhoto } from './yaya/acceptance/media';

function uploaded(result: UploadBatchResult): string {
  const item = result.uploads[0];
  assert.ok(item?.ok, 'control upload must succeed');
  return item.attachment.attachment_id;
}

// Real PG metadata + local file I/O; only the first request's model-object put
// is paused/fails. The second request uses the production upload pipeline.
async function main(): Promise<void> {
  const seed = await createAcceptanceSeed();
  const owner = seed.manifest.accounts.teacher_c.account_id;
  const metadata = createDataAttachmentMetadataPort();
  const store = new LocalMediaObjectStore(seed.object_root);
  const deps = { metadata, store, environment: 'development' as const };
  const body = await syntheticSharedPhoto();
  const input = { owner_account_id: owner, files: [{ filename: 'synthetic.png', declared_content_type: 'image/png', body, client_upload_id: null }] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const blocked = new Promise<void>((resolve) => { arrived = resolve; });
  let first: Promise<UploadBatchResult> | undefined;
  let deletes = 0;
  try {
    console.log(JSON.stringify({ stage: 'resources', seed_id: seed.seed_id, container_id: seed.container_id, object_root: seed.object_root, seed_checks: seed.verification.passed }));
    const originalId = uploaded(await uploadImages(deps, input));
    assert.equal((await recycleAttachment(deps, { attachment_id: originalId, actor_account_id: owner })).status, 'deleted');
    const expectedId = recycledContentAttachmentId(owner, sha256Hex(body), originalId);
    const failingStore: MediaObjectStore = {
      get: store.get.bind(store),
      delete: async (key) => { deletes++; return store.delete(key); },
      putOnce: async (item) => {
        if (item.key.endsWith('/model')) {
          arrived();
          await gate;
          throw new Error('controlled object I/O failure before registration');
        }
        return store.putOnce(item);
      },
    };
    first = uploadImages({ ...deps, store: failingStore }, input);
    await Promise.race([blocked, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('put gate not reached')), 15_000); timer.unref(); })]);
    const secondId = uploaded(await uploadImages(deps, input));
    assert.equal(secondId, expectedId, 'both requests share the deterministic recycled identity');
    const ready = await metadata.get(secondId);
    assert.equal(ready?.status, 'ready', 'second request committed metadata');
    assert.ok(ready);
    release();
    const failed = (await first).uploads[0];
    assert.ok(failed && !failed.ok, 'first request reports its I/O failure');
    for (const [key, checksum] of [[ready.object_key, ready.checksum_sha256], [ready.thumbnail_key, ready.thumbnail_checksum], [ready.model_key, ready.model_checksum]]) {
      const object = await store.get(key);
      assert.ok(object, 'RED: failed recycled upload must not delete the concurrent committed object');
      assert.equal(sha256Hex(object.body), checksum);
    }
    assert.equal(deletes, 0, 'no destructive compensation on shared stable identities');
    assert.equal(uploaded(await uploadImages(deps, input)), secondId, 'same-input retry restores the original result');
    // Retention remains the only deletion path: complete reference scan + lease.
    assert.equal((await recycleAttachment(deps, { attachment_id: secondId, actor_account_id: owner })).status, 'deleted');
    console.log(JSON.stringify({ ok: true, case: 'recycled-upload-concurrent-failure', layers: 'real PG metadata + production upload/retention + local file I/O + controlled put failure', real_model_requests: 0 }));
  } finally {
    release();
    await first;
    await seed.teardown();
    console.log(JSON.stringify({ stage: 'cleanup', seed_id: seed.seed_id, status: 'verified' }));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'media check failed'); process.exitCode = 1; });
