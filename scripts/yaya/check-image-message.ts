import assert from 'node:assert/strict';
import { fromThreadMessageLike, type CompleteAttachment, type ThreadMessage, type ThreadMessageLike } from '@assistant-ui/react';
import { collectMessageImages, collectUserFacts, persistShape, projectedToThreadMessageLike } from '../../src/components/yaya/client/mapping';
import { yayaAttachmentContentUrl } from '../../src/components/yaya/client/api';
import type { ProjectedMessage } from '../../src/components/yaya/client/schemas';

let passed = 0, failed = 0;
function check(name: string, work: () => void) { try { work(); passed++; console.log('PASS '+name); } catch { failed++; console.error('FAIL '+name); } }
const attachment: CompleteAttachment = { id: 'client-upload-1', type: 'image', name: '图.png', contentType: 'image/png', status: { type: 'complete' },
  content: [{ type: 'image', id: 'server-1', image: yayaAttachmentContentUrl('server-1'), filename: '图.png' }] };
const message = (input: ThreadMessageLike, id: string) => fromThreadMessageLike(input, id, { type: 'complete', reason: 'stop' });
const only = message({ role: 'user', content: [], attachments: [attachment] }, 'only');
const mixed = message({ role: 'user', content: [{ type: 'text', text: '请描述图片' }], attachments: [attachment] }, 'mixed');
check('SDK image-only message sends the server attachment', () => assert.deepEqual(collectUserFacts(only), { text: '', attachmentIds: ['server-1'] }));
check('client upload identity is never sent as server identity', () => assert.ok(!collectUserFacts(only).attachmentIds.includes('client-upload-1')));
check('image-only message is persisted not dropped', () => { const shape=persistShape(only); assert.equal(shape?.messageKind,'image'); assert.deepEqual(shape?.attachmentIds,['server-1']); });
check('image+text keeps original text and uploaded image', () => assert.deepEqual(collectUserFacts(mixed), { text: '请描述图片', attachmentIds: ['server-1'] }));
check('image+text history is mixed with raw original input', () => { const shape=persistShape(mixed); assert.equal(shape?.messageKind,'mixed'); assert.equal(shape?.fragments[0]?.text,'请描述图片'); assert.deepEqual(shape?.attachmentIds,['server-1']); });
check('sent gallery uses server identity and filename', () => assert.deepEqual(collectMessageImages(only).map(({id,filename})=>({id,filename})),[{id:'server-1',filename:'图.png'}]));
// Malformed runtime input must not turn an unfinished upload into a trusted image.
const pending = { ...only, attachments: [{...attachment,status:{type:'incomplete',reason:'error'}}] } as unknown as ThreadMessage;
check('failed upload cannot become model input or history image', () => { assert.deepEqual(collectUserFacts(pending).attachmentIds,[]); assert.equal(persistShape(pending),null); });
const duplicate = message({ role: 'user', content: attachment.content, attachments: [attachment,attachment] }, 'duplicate');
check('content+attachment duplicate image is sent once', () => assert.deepEqual(collectUserFacts(duplicate).attachmentIds,['server-1']));
check('duplicate image is stored once', () => assert.deepEqual(persistShape(duplicate)?.attachmentIds,['server-1']));
const foreign = message({ role: 'user', content: [], attachments: [{ ...attachment,content:[{ type:'image',image:'https://foreign.invalid/photo.png' }] }] }, 'foreign');
check('foreign URL is not treated as an uploaded attachment', () => assert.deepEqual(collectUserFacts(foreign).attachmentIds,[]));
const view: ProjectedMessage = { message_id:'history',conversation_id:'conversation',owner_account_id:'owner',role:'user',message_kind:'image',execution_state:'none',revision:1,created_at:'2026-10-10T00:00:00Z',
  projection:{ visibility:'full',fragments:[],attachments:[{attachment_id:'server-1',readable:true,metadata_only:false,reason:'owner'}],metadata:null,execution_allowed:false },fragments:[],attachment_ids:['server-1'],metadata:null };
check('history image roundtrip keeps authorized server identity', () => { const restored=projectedToThreadMessageLike(view); assert.ok(restored); assert.deepEqual(collectUserFacts(message(restored,'history')).attachmentIds,['server-1']); });
check('revoked history image is not resubmitted', () => { const restored=projectedToThreadMessageLike({ ...view,projection:{...view.projection,attachments:[{attachment_id:'server-1',readable:false,metadata_only:true,reason:'historical'}]} }); assert.ok(restored); assert.deepEqual(collectUserFacts(message(restored,'history')).attachmentIds,[]); });
console.log(JSON.stringify({passed,failed,real_model_requests:0,uploads:0}));if(failed)process.exitCode=1;
