import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceSeed } from './acceptance/seed';
import { resolvePrincipalById } from '../../src/lib/accounts/repository';
import { withTransaction } from '../../src/storage/database/pg-client';
import { yayaDataRepository } from '../../src/lib/yaya/data';
import { registerYayaRun } from '../../src/lib/yaya/agent/runtime/store';
import { persistRunTerminalMessage } from '../../src/lib/yaya/agent/runtime/terminal-message';
import { projectMessageRow, projectConversationView } from '../../src/lib/yaya/data/projection';
import { evaluateFragmentSources } from '../../src/lib/yaya/data/access-facts';
import type { YayaMessageRow } from '../../src/lib/yaya/data/rows';

let passed=0;const failures:string[]=[];
function check(name:string,condition:unknown){if(condition)passed++;else failures.push(name);}
async function main(){
  const seed=await createAcceptanceSeed();
  try {
    const owner=await resolvePrincipalById(seed.manifest.accounts.admin.account_id,seed.manifest.school_id);
    const peer=await resolvePrincipalById(seed.manifest.accounts.teacher_b.account_id,seed.manifest.school_id);
    assert.ok(owner&&peer);const image=randomUUID(),text='PRIVATE_IMAGE_CAPTION';
    await withTransaction(async client=>{
      await client.query(`INSERT INTO yaya_attachments(id,uploader_account_id,object_key,media_type,byte_size,checksum_sha256,source_kind,status)
        VALUES($1,$2,$3,'image/png',10,$4,'image_interpretation','ready')`,[image,owner.account_id,'fixture/'+image,'a'.repeat(64)]);
      const conversation=await yayaDataRepository.createConversation(client,{owner_account_id:owner.account_id,title:null});
      const registered=await registerYayaRun(client,{run_id:randomUUID(),owner_account_id:owner.account_id,conversation_id:conversation.conversation_id,
        client_request_id:randomUUID(),user_text:'描述图形',attachment_ids:[image],expected_conversation_revision:conversation.revision,
        session_id:randomUUID(),owner_instance:'image-history-fixture',deadline_at:new Date(Date.now()+60000).toISOString()});
      assert.equal(registered.kind,'created');
      const run={...registered.run,state:'terminal' as const,outcome:{kind:'answered',content:text,sources:[]},dependencies:[{ref:null,tool:null,image_id:image,message_id:null,fragment_id:null,projection:'any' as const}]};
      await persistRunTerminalMessage(client,owner,seed.manifest.school_id,run);
      const stored=(await client.query<YayaMessageRow>('SELECT * FROM yaya_messages WHERE run_id=$1',[run.run_id])).rows[0];assert.ok(stored);
      const full=await projectMessageRow(client,owner,seed.manifest.school_id,stored);
      check('authorized picture answer is bound not unknown',stored.binding_state==='bound');
      check('picture answer has explicit non-public source',full.fragments[0]?.independently_readable===false && JSON.stringify(stored.fragments).includes('"kind":"image"'));
      check('current owner reads picture answer',full.fragments[0]?.text===text && full.projection.visibility==='full');
      check('answer retains source attachment',full.attachment_ids.includes(image));
      check('answer reference protects source image',Number((await client.query<{count:string}>("SELECT count(*) FROM yaya_attachment_refs WHERE attachment_id=$1 AND record_id=$2 AND record_kind='message'",[image,stored.id])).rows[0]?.count)===1);
      const denied=await projectMessageRow(client,peer,seed.manifest.school_id,stored);
      check('different actor cannot read private answer',!JSON.stringify(denied).includes(text));
      await client.query('UPDATE yaya_conversations SET title=$1,title_source_fragments=$2::jsonb WHERE id=$3',[text,JSON.stringify([run.run_id+':f0']),conversation.conversation_id]);
      const title=await projectConversationView(client,owner,seed.manifest.school_id,{...conversation,title:text,title_source_fragments:[run.run_id+':f0']});
      check('authorized picture-derived title is readable',title.projected_title===text&&!title.title_restricted);
      const imageSource={fragment_id:'source',sources:[{kind:'image',image_id:image}]};
      check('image source uses current media authorization',(await evaluateFragmentSources(client,owner,seed.manifest.school_id,[imageSource]))[0]?.access==='full');
      for(const status of ['pending','deleting','deleted']){
        await client.query('UPDATE yaya_attachments SET status=$1 WHERE id=$2',[status,image]);
        const restricted=await projectMessageRow(client,owner,seed.manifest.school_id,stored);
        check(status+' picture answer hidden',!JSON.stringify(restricted).includes(text));
        const restrictedTitle=await projectConversationView(client,owner,seed.manifest.school_id,{...conversation,title:text,title_source_fragments:[run.run_id+':f0']});
        check(status+' picture-derived title hidden',restrictedTitle.title_restricted&&!JSON.stringify(restrictedTitle).includes(text));
      }
      const missing=await evaluateFragmentSources(client,owner,seed.manifest.school_id,[{fragment_id:'missing',sources:[{kind:'image',image_id:randomUUID()}]}]);
      check('missing picture source is not full',missing[0]?.access!=='full');
      const corrupt=await evaluateFragmentSources(client,owner,seed.manifest.school_id,[{fragment_id:'bad',sources:[{kind:'image',image_id:null}]}]);
      check('malformed picture source stays broken',corrupt[0]?.access==='broken');
    });
    console.log(JSON.stringify({passed,total:16,failures,real_model_requests:0,production_uploads:0,evidence:'isolated_PG+actual_principals+terminal_message+projection'}));
    if(failures.length)process.exitCode=1;
  } finally {await seed.teardown();console.log(JSON.stringify({cleanup:'verified'}));}
}
void main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'check failed');process.exitCode=1;});
