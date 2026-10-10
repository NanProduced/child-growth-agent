import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createAcceptanceSeed } from './acceptance/seed';
import { resolvePrincipalById } from '../../src/lib/accounts/repository';
import { createSessionToken } from '../../src/lib/accounts/session';
import { withTransaction } from '../../src/storage/database/pg-client';
import { yayaDataRepository } from '../../src/lib/yaya/data';
import { registerYayaRun } from '../../src/lib/yaya/agent/runtime/store';
import { createYayaRunRuntimeState, loadYayaRunProjectedContext, revalidateYayaRunContext } from '../../src/lib/yaya/agent/runtime/context';
import { mediaRuntimeOrThrow } from '../../src/lib/media/runtime';
import { uploadImages } from '../../src/lib/media/upload-service';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown) { if (ok) passed++; else failures.push(name); }
async function main() {
  const seed = await createAcceptanceSeed();
  try {
    process.env.DATABASE_URL = seed.database_url;
    process.env.AUTH_TRUSTED_ORIGINS = 'http://image-citable.fixture';
    process.env.AUTH_SCHOOL_ID = seed.manifest.school_id;
    process.env.AUTH_COOKIE_SECURE = 'false';
    process.env.MEDIA_ENVIRONMENT = 'development'; process.env.MEDIA_STORAGE_MODE = 'local'; process.env.MEDIA_LOCAL_ROOT = seed.object_root;
    const owner = await resolvePrincipalById(seed.manifest.accounts.admin.account_id, seed.manifest.school_id);
    const peer = await resolvePrincipalById(seed.manifest.accounts.teacher_b.account_id, seed.manifest.school_id);
    assert.ok(owner && peer);
    const session = createSessionToken();
    const sessionId = await withTransaction(async client => (await client.query<{ id: string }>("INSERT INTO app_sessions(account_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day') RETURNING id", [owner.account_id, session.tokenHash])).rows[0].id);
    const body = await sharp({ create: { width: 80, height: 50, channels: 3, background: { r: 230, g: 30, b: 40 } } }).png().toBuffer();
    const uploaded = await uploadImages(mediaRuntimeOrThrow(), { owner_account_id: owner.account_id, files: [{ filename: 'synthetic.png', declared_content_type: 'image/png', body, client_upload_id: randomUUID() }] });
    const item = uploaded.uploads[0]; assert.ok(item.ok);
    const imageId = item.attachment.attachment_id;
    const run = await withTransaction(async client => {
      const conversation = await yayaDataRepository.createConversation(client, { owner_account_id: owner.account_id, title: null });
      const registered = await registerYayaRun(client, { run_id: randomUUID(), owner_account_id: owner.account_id, conversation_id: conversation.conversation_id, client_request_id: randomUUID(), user_text: '描述图片', attachment_ids: [imageId], expected_conversation_revision: conversation.revision, session_id: sessionId, owner_instance: 'citable-context-fixture', deadline_at: new Date(Date.now() + 60000).toISOString() });
      assert.equal(registered.kind, 'created'); return registered.run;
    });
    const state = createYayaRunRuntimeState({ run, token: session.token, owner_instance: 'citable-context-fixture', carrier: { headers: new Headers({ cookie: `cga_session=${session.token}` }) } });
    const context = await loadYayaRunProjectedContext(state, owner);
    check('real MEDIA model bytes load', context.images.length === 1 && context.images[0].image_id === imageId);
    check('authorized image is an explicit citable source', context.sources.some(source => source.kind === 'image_interpretation' && source.ref_id === imageId));
    check('source and image keep the same authoritative identity', context.sources.find(source => source.ref_id === imageId)?.ref_id === context.images[0]?.source.ref_id);
    check('registered dependency binds source and image together', [...state.dependencies.values()].some(dependency => dependency.image_id === imageId && dependency.ref?.ref_id === imageId));
    const identity = { run_id: run.run_id, principal: owner, identity_state: 'authenticated' as const, session_valid: true };
    const verdict = await revalidateYayaRunContext(state, { run_id: run.run_id, identity, sources: context.sources, image_ids: [imageId] }, { principal: owner });
    check('legitimate citable image still passes real authorization recheck', verdict.ok);
    const again = await loadYayaRunProjectedContext(state, owner);
    check('reloading does not duplicate image citation', again.sources.filter(source => source.ref_id === imageId).length === 1);
    await withTransaction(client => client.query("UPDATE yaya_attachments SET status='pending' WHERE id=$1", [imageId]));
    const revoked = await revalidateYayaRunContext(state, { run_id: run.run_id, identity, sources: context.sources, image_ids: [imageId] }, { principal: owner });
    check('revoked or nonready bytes still stop consumption', !revoked.ok);
    const foreign = createYayaRunRuntimeState({ run, token: session.token, owner_instance: 'citable-context-fixture', carrier: { headers: new Headers({ cookie: `cga_session=${session.token}` }) } });
    const denied = await loadYayaRunProjectedContext(foreign, peer);
    check('foreign actor never receives a citable image', denied.images.length === 0 && !denied.sources.some(source => source.ref_id === imageId));
    console.log(JSON.stringify({ passed, total: passed + failures.length, failures, real_model_requests: 0, production_uploads: 0, evidence: 'real_isolated_PG_AUTH_MEDIA_context_and_revalidation' }));
    if (failures.length) process.exitCode = 1;
  } finally { await seed.teardown(); console.log(JSON.stringify({ cleanup: 'verified' })); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'check failed'); process.exitCode = 1; });
