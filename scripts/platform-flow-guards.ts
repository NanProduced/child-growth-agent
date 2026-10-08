import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { Client } from 'pg';
import { POST as childPost } from '../src/app/api/children/route';
import { POST as transferPost } from '../src/app/api/classes/[id]/children/route';
import { POST as uploadPost } from '../src/app/api/yaya/uploads/route';
import { GET as contentGet } from '../src/app/api/yaya/uploads/[id]/content/route';
import { GET as metadataGet } from '../src/app/api/yaya/uploads/[id]/route';
import { createSessionToken, computeCsrfToken } from '../src/lib/accounts/session';
import { createDataAttachmentMetadataPort } from '../src/lib/media/data-adapter';
import { LocalMediaObjectStore } from '../src/lib/media/object-store-local';
import type { MediaObjectStore } from '../src/lib/media/object-store';
import { bindMediaRuntime } from '../src/lib/media/runtime';
import { uploadImages } from '../src/lib/media/upload-service';
import { withPrivateWrite, yayaDataRepository } from '../src/lib/yaya/data';
import { modelGuardEnv, startModelRequestGuard } from './harness-safety';
import { createAcceptanceSeed } from './yaya/acceptance/seed';
import { syntheticSharedPhoto } from './yaya/acceptance/media';

async function main(): Promise<void> {
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  const seed = await createAcceptanceSeed();
  const db = new Client({ connectionString: seed.database_url });
  const origin = 'http://platform-flow.invalid';
  process.env.AUTH_TRUSTED_ORIGINS = origin;
  const failures: string[] = [];
  let passed = 0;
  const check = (condition: boolean, label: string): void => { if (condition) passed++; else failures.push(label); };
  try {
    await db.connect();
    console.log(JSON.stringify({ stage: 'resources', seed_id: seed.seed_id, container_id: seed.container_id, object_root: seed.object_root }));
    const session = async (accountId: string) => {
      const token = createSessionToken();
      await db.query("INSERT INTO app_sessions(account_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [accountId, token.tokenHash]);
      return { ...token, headers: { cookie: `cga_session=${token.token}`, origin, 'x-csrf-token': computeCsrfToken(token.token) } };
    };
    const teacher = await session(seed.manifest.accounts.teacher_a.account_id);
    const admin = await session(seed.manifest.accounts.admin.account_id);
    const jsonRequest = (path: string, headers: Record<string, string>, body: unknown) => new NextRequest(origin + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const before = await db.query('SELECT count(*) FROM children');
    const badBirth = await childPost(jsonRequest('/api/children', teacher.headers, { name: '[合成]日期反例', gender: '男', birth_date: '2022-02-30', class_id: seed.manifest.classes.class_a.id }));
    check(badBirth.status === 400, `birth_date invalid calendar day must be 400 (got ${badBirth.status})`);
    assert.deepEqual((await db.query('SELECT count(*) FROM children')).rows, before.rows, 'invalid birth date must not create a child');
    const target = seed.manifest.classes.class_b.id;
    const child = seed.manifest.children.class_a_trusted_empty.id;
    const enrollments = await db.query('SELECT * FROM child_class_enrollments WHERE child_id=$1 ORDER BY id', [child]);
    const badTransfer = await transferPost(jsonRequest(`/api/classes/${target}/children`, admin.headers, { child_id: child, start_date: '2026-02-30' }), { params: Promise.resolve({ id: target }) });
    check(badTransfer.status === 400, `start_date invalid calendar day must be 400 (got ${badTransfer.status})`);
    assert.deepEqual((await db.query('SELECT * FROM child_class_enrollments WHERE child_id=$1 ORDER BY id', [child])).rows, enrollments.rows, 'invalid transfer must leave all enrollment history intact');

    const owner = seed.manifest.accounts.teacher_c.account_id; // empty scope may upload private material
    const active = await session(owner);
    const metadata = createDataAttachmentMetadataPort();
    const store = new LocalMediaObjectStore(seed.object_root);
    const body = await syntheticSharedPhoto();
    let revoked = false;
    const revokingStore: MediaObjectStore = {
      get: store.get.bind(store), delete: store.delete.bind(store),
      putOnce: async (input) => {
        if (!revoked) {
          // NOWAIT proves the object I/O does not retain account/session DB locks.
          await db.query('BEGIN');
          await db.query('SELECT id FROM app_accounts WHERE id=$1 FOR UPDATE NOWAIT', [owner]);
          await db.query('SELECT id FROM app_sessions WHERE token_hash=$1 FOR UPDATE NOWAIT', [active.tokenHash]);
          await db.query('UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1', [active.tokenHash]);
          await db.query('COMMIT');
          revoked = true;
        }
        return store.putOnce(input);
      },
    };
    bindMediaRuntime({ metadata, store: revokingStore, environment: 'development' });
    const form = new FormData();
    form.append('client_batch_id', 'platform-flow-revoked');
    form.append('files', new Blob([new Uint8Array(body)], { type: 'image/png' }), 'synthetic.png');
    const counts = await db.query('SELECT count(*) FROM yaya_attachments WHERE uploader_account_id=$1', [owner]);
    const revokedUpload = await uploadPost(new NextRequest(origin + '/api/yaya/uploads', { method: 'POST', headers: active.headers, body: form }));
    check(revoked && revokedUpload.status === 401, `upload after session revocation during object I/O must be 401 (got ${revokedUpload.status})`);
    check(JSON.stringify((await db.query('SELECT count(*) FROM yaya_attachments WHERE uploader_account_id=$1', [owner])).rows) === JSON.stringify(counts.rows), 'revoked upload must commit zero metadata');

    // A valid private image must not be served after the same session expires/revokes during get.
    const valid = await session(owner);
    bindMediaRuntime(null);
    const normal = await uploadImages({ metadata, store, environment: 'development' }, { owner_account_id: owner, files: [{ filename: 'synthetic.png', declared_content_type: 'image/png', body, client_upload_id: 'platform-flow-content' }] });
    const image = normal.uploads[0];
    assert.ok(image?.ok);
    const imageId = image.attachment.attachment_id;
    bindMediaRuntime({ metadata, store: {
      putOnce: store.putOnce.bind(store), delete: store.delete.bind(store),
      get: async (key) => {
        await db.query('UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1', [valid.tokenHash]);
        return store.get(key);
      },
    }, environment: 'development' });
    const revokedContent = await contentGet(new NextRequest(origin + `/api/yaya/uploads/${imageId}/content`, { headers: valid.headers }), { params: Promise.resolve({ id: imageId }) });
    check(revokedContent.status === 401, `image response after I/O session revocation must be 401, without bytes (got ${revokedContent.status})`);

    const expiring = await session(owner);
    await db.query("UPDATE app_sessions SET expires_at=clock_timestamp()+interval '15 seconds' WHERE token_hash=$1", [expiring.tokenHash]);
    let locked = false;
    bindMediaRuntime({ metadata, store: {
      get: store.get.bind(store), delete: store.delete.bind(store),
      putOnce: async (input) => {
        if (input.key.endsWith('/model')) {
          await db.query('BEGIN');
          await db.query('SELECT id FROM app_sessions WHERE token_hash=$1 FOR UPDATE', [expiring.tokenHash]);
          locked = true;
        }
        return store.putOnce(input);
      },
    }, environment: 'development' });
    const expiryForm = new FormData();
    expiryForm.append('client_batch_id', 'platform-flow-expiry');
    expiryForm.append('files', new Blob([new Uint8Array(body)], { type: 'image/png' }), 'synthetic.png');
    const beforeExpiry = await db.query('SELECT count(*) FROM yaya_attachments WHERE uploader_account_id=$1', [owner]);
    const expiryWrite = uploadPost(new NextRequest(origin + '/api/yaya/uploads', { method: 'POST', headers: expiring.headers, body: expiryForm }));
    let waiting = false;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const activity = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%app_sessions%FOR SHARE%'");
      if (locked && activity.rows[0].n > 0) { waiting = true; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    check(waiting, 'upload metadata registration is observably waiting on original session lock');
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))+0.1) FROM app_sessions WHERE token_hash=$1', [expiring.tokenHash]);
    await db.query('COMMIT');
    const expiredUpload = await expiryWrite;
    check(expiredUpload.status === 401, `natural expiry after session lock wait must be 401 (got ${expiredUpload.status})`);
    check(JSON.stringify((await db.query('SELECT count(*) FROM yaya_attachments WHERE uploader_account_id=$1', [owner])).rows) === JSON.stringify(beforeExpiry.rows), 'expiry at registration lock must roll back metadata, not merely reject the final response');

    const proposalOwner = seed.manifest.accounts.teacher_a.account_id;
    const proposalUpload = await uploadImages({ metadata, store, environment: 'development' }, { owner_account_id: proposalOwner, files: [{ filename: 'synthetic.png', declared_content_type: 'image/png', body, client_upload_id: 'platform-flow-proposal' }] });
    const proposedImage = proposalUpload.uploads[0];
    assert.ok(proposedImage?.ok);
    const proposedImageId = proposedImage.attachment.attachment_id;
    const proposedChild = seed.manifest.children.class_a_trusted_empty.id;
    await withPrivateWrite({ headers: new Headers(teacher.headers) }, async ({ client, principal }) =>
      yayaDataRepository.prepareProposal(client, {
        conversation_id: seed.manifest.conversations.teacher_a_scenario.conversation_id,
        owner_account_id: principal.account_id,
        proposal_origin: 'teacher_card', auth: { kind: 'action', action: 'observation.write', resource: 'child' },
        items: [{ item_key: 'photo', target_id: proposedChild, action: 'observation.write', resource: 'child', resource_ref: { kind: 'child', child_id: proposedChild },
          payload: { kind: 'create_observation', child_id: proposedChild, observed_at: '2026-10-08', raw_text: '[合成]幼儿摆放积木并告诉同伴自己的摆放方法。', context: null, confirmed_class_id: null, image_ids: [proposedImageId], source_input: null },
          attachment_associations: [{ attachment_id: proposedImageId, target_id: proposedChild }], business_revision: null }],
      }));
    bindMediaRuntime({ metadata, store, environment: 'development' });
    const proposalContent = await contentGet(new NextRequest(origin + `/api/yaya/uploads/${proposedImageId}/content`, { headers: teacher.headers }), { params: Promise.resolve({ id: proposedImageId }) });
    check(proposalContent.status === 200, `a photo referenced by an authorized pending proposal must remain readable (got ${proposalContent.status})`);
    const proposalMetadata = await metadataGet(new NextRequest(origin + `/api/yaya/uploads/${proposedImageId}`, { headers: teacher.headers }), { params: Promise.resolve({ id: proposedImageId }) });
    check(proposalMetadata.status === 200, 'proposal image metadata uses the same source authorization as bytes');
    await db.query('UPDATE teacher_class_assignments SET removed_at=now() WHERE account_id=$1 AND class_id=$2 AND removed_at IS NULL', [proposalOwner, seed.manifest.classes.class_a.id]);
    const deniedProposalContent = await contentGet(new NextRequest(origin + `/api/yaya/uploads/${proposedImageId}/content`, { headers: teacher.headers }), { params: Promise.resolve({ id: proposedImageId }) });
    check(deniedProposalContent.status === 403, 'proposal owner/uploader alone must not bypass revoked business-source access');
    const deniedProposalMetadata = await metadataGet(new NextRequest(origin + `/api/yaya/uploads/${proposedImageId}`, { headers: teacher.headers }), { params: Promise.resolve({ id: proposedImageId }) });
    check(deniedProposalMetadata.status === 403, 'proposal metadata cannot bypass revoked source access');
    check(guard.hits === 0, 'zero provider requests');
    console.log(JSON.stringify({ passed, failed: failures.length, failures, layers: 'real route handlers + AUTH/session/CSRF + isolated PG + local objects + controlled I/O revocation; no Next server' }));
    if (failures.length) process.exitCode = 1;
  } finally {
    bindMediaRuntime(null);
    await db.query('ROLLBACK').catch(() => undefined);
    await db.end();
    await seed.teardown();
    await guard.close();
    console.log(JSON.stringify({ stage: 'cleanup', seed_id: seed.seed_id, status: 'verified' }));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'guard check failed'); process.exitCode = 1; });
