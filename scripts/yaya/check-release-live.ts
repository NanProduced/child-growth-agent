/** Explicitly authorized production synthetic smoke. No .env or secret output. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import sharp from 'sharp';
import { parseYayaRunWireLine, validateYayaRunEventStream, yayaOperationReceiptSchema } from '../../src/lib/yaya/api-contract';
import { receiptProvesSuccess } from '../../src/lib/yaya/types';

const BASE='https://childgrowth.coze.site';
const ROOT=path.resolve('logs/release/release-0cd3dab1');
const STATE=path.join(ROOT,'live-smoke.json');
const LEDGER=path.resolve('logs/yaya-provider-smoke-20/requests.jsonl');
const MODE=process.argv[2];
type State={run:string;class_id?:string;teacher_id?:string;username?:string;password?:string;child_id?:string;attachment_id?:string;observation_id?:string;conversations:string[];checks:string[]};
type Auth={cookie:string;csrf:string};
const state:State=fs.existsSync(STATE)?JSON.parse(fs.readFileSync(STATE,'utf8')) as State:{run:'live-'+randomUUID().slice(0,8),conversations:[],checks:[]};
const save=()=>fs.writeFileSync(STATE,JSON.stringify(state,null,2),{mode:0o600});
const record=(name:string,condition:unknown)=>{assert.ok(condition,name);state.checks.push(name);save();};
const json=(value:unknown)=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const str=(value:unknown)=>{assert.equal(typeof value,'string');return value as string;};
async function login(username:string,password:string):Promise<Auth>{
  const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{origin:BASE,'content-type':'application/json','x-cga-auth-request':'1'},body:JSON.stringify({username,password}),signal:AbortSignal.timeout(20000)});
  assert.equal(r.status,200,'authorized login HTTP');
  const cookies=r.headers.getSetCookie();const cookie=cookies.find(c=>c.startsWith('cga_session='));assert.ok(cookie);
  record('HttpOnly Secure SameSite session',/HttpOnly/i.test(cookie)&&/Secure/i.test(cookie)&&/SameSite=Lax/i.test(cookie));
  const body=json(await r.json()); return{cookie:cookie.split(';')[0]!,csrf:str(json(body.csrf).token)};
}
async function request(auth:Auth,url:string,method='GET',body?:unknown){
  const r=await fetch(BASE+url,{method,headers:{cookie:auth.cookie,origin:BASE,'content-type':'application/json',...(method==='GET'?{}:{'x-csrf-token':auth.csrf})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const value:unknown=await r.json(); if(!r.ok)console.log(JSON.stringify({path:url,http:r.status,code:json(value).error??null})); return{r,body:json(value)};
}
async function db(){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','coze code env list -p 7690843235199139866 --env prod --format json'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0);
  const rows:unknown=JSON.parse(result.stdout);assert.ok(Array.isArray(rows));const row=json(rows.find(x=>json(x).secret_key==='DATABASE_URL'));const url=str(row.secret_val);const u=new URL(url);
  assert.equal(createHash('sha256').update(u.hostname+u.pathname).digest('hex').slice(0,16),'fb9bdaade52916a4');
  const c=new Client({connectionString:url,connectionTimeoutMillis:15000});await c.connect();await c.query("SET timezone='UTC'");return c;
}
async function preserved(){
  const c=await db();try{
    const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json'),'utf8')) as{baseline:Array<{table:string;columns:string[];count:number;digest:string}>};
    for(const fact of manifest.baseline.filter(x=>x.table!=='health_check')){
      const excluded=fact.table==='classes'?state.class_id:fact.table==='children'?state.child_id:fact.table==='observations'?state.observation_id:state.child_id;
      const key=fact.table==='child_class_enrollments'?'child_id':'id';
      const rows=(await c.query('SELECT to_jsonb(t) AS data FROM (SELECT '+fact.columns.map(x=>'"'+x+'"').join(',')+' FROM "'+fact.table+'"'+(excluded?' WHERE "'+key+'" <> $1':'')+' ORDER BY id) t',excluded?[excluded]:[])).rows;
      record('old '+fact.table+' byte-identical',rows.length===fact.count&&createHash('sha256').update(JSON.stringify(rows.map(x=>x.data))).digest('hex')===fact.digest);
    }
  }finally{await c.end();}
}
async function run(auth:Auth,text:string,images:string[],provider:string){
  const entries=fs.readFileSync(LEDGER,'utf8').trim().split('\n');assert.ok(entries.length+2<=20,'remaining approved real model budget');
  for(let i=0;i<2;i++)fs.appendFileSync(LEDGER,JSON.stringify({number:entries.length+i+1,provider,run:state.run,mode:MODE,reserved_at:new Date().toISOString(),server_run_cap:2})+'\n');
  const created=await request(auth,'/api/yaya/conversations','POST',{title:'合成上线验收 '+state.run+' '+MODE});assert.equal(created.r.status,201);const conv=json(created.body.conversation);const cid=str(conv.conversation_id);state.conversations.push(cid);save();
  const msg=await request(auth,'/api/yaya/conversations/'+cid+'/messages','POST',{client_message_id:randomUUID(),role:'user',message_kind:images.length?'mixed':'text',execution_state:'none',fragments:[{fragment_id:randomUUID(),text,sources:[],independently_readable:true,provenance:{kind:'raw_input',ref_id:null,label:null,derived_from:null}}],attachment_ids:images,expected_conversation_revision:conv.revision});assert.equal(msg.r.status,201);
  const body={conversation_id:cid,client_request_id:json(msg.body.message).message_id,user_text:text,attachment_ids:images,expected_conversation_revision:json(msg.body.conversation).revision};
  const r=await fetch(BASE+'/api/yaya/conversations/'+cid+'/runs',{method:'POST',headers:{cookie:auth.cookie,origin:BASE,'content-type':'application/json','x-csrf-token':auth.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
  const wire=await r.text();fs.writeFileSync(path.join(ROOT,MODE+'-wire.ndjson'),wire);assert.equal(r.status,200);
  const events=wire.trim().split('\n').map(line=>{const p=parseYayaRunWireLine(line);assert.ok(p.ok);return p.value;});const verdict=validateYayaRunEventStream(events);assert.ok(verdict.ok);
  fs.writeFileSync(path.join(ROOT,MODE+'-result.json'),JSON.stringify({outcome:verdict.outcome,model_attempts:events.filter(e=>e.type==='model_attempted').length,request:body},null,2));
  record(MODE+' valid real NDJSON',true);
  const lookup=await request(auth,'/api/yaya/conversations/'+cid+'/runs?client_request_id='+encodeURIComponent(str(body.client_request_id)));record(MODE+' original run query',lookup.r.status===200);
  console.log(JSON.stringify({stage:MODE,outcome:verdict.outcome.kind,model_attempts:events.filter(e=>e.type==='model_attempted').length}));
  return verdict.outcome;
}
async function main(){
  assert.ok(['setup','upload','image','write','verify-ui','disable-test','preserve'].includes(MODE??''),'explicit authorized smoke stage required');
  const credentials=json(JSON.parse(fs.readFileSync(path.join(ROOT,'admin-credentials.json'),'utf8')));const admin=await login(str(credentials.username),str(credentials.password));
  if(MODE==='disable-test'){
    assert.ok(state.teacher_id);const changed=await request(admin,'/api/admin/teachers/'+state.teacher_id,'PATCH',{account_id:state.teacher_id,status:'disabled'});record('synthetic teacher disabled with session revocation',changed.r.status===200&&json(changed.body.teacher).status==='disabled');
  }else if(MODE==='setup'){
    assert.ok(!state.class_id,'setup cannot be repeated');
    record('anonymous private lists denied',(await fetch(BASE+'/api/children')).status===401);
    const klass=await request(admin,'/api/classes','POST',{name:'合成验收班 '+state.run,stage:'small',school_year:'2026-2027'});assert.equal(klass.r.status,201);state.class_id=str(json(klass.body.class).id);save();
    state.username='qa_'+randomUUID().slice(0,8);state.password=randomBytes(24).toString('base64url');save();
    const teacher=await request(admin,'/api/admin/teachers','POST',{username:state.username,display_name:'合成验收教师',initial_password:state.password,class_ids:[state.class_id]});assert.equal(teacher.r.status,201);const t=json(teacher.body.teacher);state.teacher_id=str(t.account_id);save();
    const child=await request(admin,'/api/children','POST',{name:'合成验收幼儿',gender:'其他',birth_date:'2022-03-01',class_id:state.class_id,note:'本轮上线合成测试，无真实幼儿信息'});assert.equal(child.r.status,201);state.child_id=str(json(child.body.child).id);save();
    const auth=await login(state.username,state.password);const list=await request(auth,'/api/children');assert.ok(Array.isArray(list.body.children));record('teacher sees only synthetic child',list.body.children.length===1&&json(list.body.children[0]).id===state.child_id);
    const forbidden=await request(admin,'/api/observations','POST',{child_id:state.child_id,observed_at:'2026-10-07',raw_text:'合成测试：在积木区把三块积木叠起来，倒塌后又重新尝试。'});record('admin teaching write forbidden',forbidden.r.status===403);
  }else{
    assert.ok(state.username&&state.password&&state.child_id);const auth=await login(state.username,state.password);
    if(MODE==='upload'){
      const image=await sharp({create:{width:128,height:128,channels:3,background:'#ff0000'}}).composite([{input:await sharp({create:{width:64,height:128,channels:3,background:'#0000ff'}}).png().toBuffer(),left:64,top:0}]).png().toBuffer();fs.writeFileSync(path.join(ROOT,'synthetic-red-blue.png'),image);
      const send=async()=>{const form=new FormData();form.append('client_batch_id',state.run);form.append('files',new Blob([new Uint8Array(image)],{type:'image/png'}),'synthetic-red-blue.png');const r=await fetch(BASE+'/api/yaya/uploads',{method:'POST',headers:{cookie:auth.cookie,origin:BASE,'x-csrf-token':auth.csrf},body:form,signal:AbortSignal.timeout(45000)});return{r,body:json(await r.json())};};
      const first=await send();assert.equal(first.r.status,200);assert.ok(Array.isArray(first.body.uploads));const file=json(first.body.uploads[0]);fs.writeFileSync(path.join(ROOT,'upload-result.json'),JSON.stringify(first.body,null,2));assert.equal(file.ok,true);state.attachment_id=str(json(file.attachment).attachment_id);save();
      const again=await send();assert.ok(Array.isArray(again.body.uploads));record('stable multipart upload identity',json(json(again.body.uploads[0]).attachment).attachment_id===state.attachment_id);
      for(const variant of ['original','thumbnail','model']){const r=await fetch(BASE+'/api/yaya/uploads/'+state.attachment_id+'/content?variant='+variant,{headers:{cookie:auth.cookie}});record('real object '+variant+' readable',r.status===200&&(await r.arrayBuffer()).byteLength>0);}
      const c=await db();try{const attachment=(await c.query('SELECT object_key,thumbnail_key,model_key,status FROM yaya_attachments WHERE id=$1 AND uploader_account_id=$2',[state.attachment_id,state.teacher_id])).rows[0];record('production content-addressed object metadata',attachment.status==='ready'&&[attachment.object_key,attachment.thumbnail_key,attachment.model_key].every((k:unknown)=>typeof k==='string'&&k.startsWith('media/prod/')&&/\/[a-f0-9]{64}$/.test(k)));}finally{await c.end();}
      const denied=await fetch(BASE+'/api/yaya/uploads/'+state.attachment_id+'/content?variant=model',{headers:{cookie:admin.cookie}});record('other owner cannot read image',denied.status===404||denied.status===403);
    }else if(MODE==='image'){
      assert.ok(state.attachment_id);const outcome=await run(auth,'这是不含人物的合成色块图片，用于幼儿颜色教学素材测试。只描述图片左右两半的颜色，不调用工具，不生成观察记录。',[state.attachment_id],'coze');record('real multimodal answer',outcome.kind==='answered');
    }else if(MODE==='write'){
      const raw='合成测试：在积木区，幼儿把三块积木叠起来，倒塌后拿起积木重新尝试，搭好后说“搭好了”。';
      const outcome=await run(auth,'请准备新增一条观察，目标幼儿ID '+state.child_id+'，日期2026-10-07，情境积木区。原文必须逐字保留：'+raw+'。目标已经明确，请直接准备 create_observation 提案，等待我核对批准，不需要先查询、不生成整理稿。',[],'stepfun');
      assert.equal(outcome.kind,'proposed');if(outcome.kind==='proposed'){
        const p=await request(auth,'/api/yaya/proposals?proposal_id='+encodeURIComponent(outcome.proposals[0]!.proposal_id));const proposal=json(p.body.proposal);assert.ok(Array.isArray(proposal.items));assert.equal(proposal.items.length,1);const item=json(proposal.items[0]);const payload=json(item.payload);record('proposal raw/target/date exact',payload.raw_text===raw&&payload.child_id===state.child_id&&payload.observed_at==='2026-10-07');
        const c=await db();try{record('unapproved has zero business write',Number((await c.query('SELECT count(*) AS n FROM observations WHERE child_id=$1',[state.child_id])).rows[0].n)===0);}finally{await c.end();}
        const approval=await request(auth,'/api/yaya/proposals/'+str(proposal.proposal_id)+'/approval','POST',{action:'approve',operation_ids:[item.operation_id]});assert.equal(approval.r.status,201);
        const executed=await request(auth,'/api/yaya/operations','POST',{approval_id:json(approval.body.approval).approval_id,operation_ids:[item.operation_id]});assert.equal(executed.r.status,200);assert.ok(Array.isArray(executed.body.receipts));const receipt=yayaOperationReceiptSchema.parse(executed.body.receipts[0]);record('verified committed receipt',receiptProvesSuccess(receipt));state.observation_id=str(receipt.business_object_id);save();
        const check=await db();try{const obs=(await check.query('SELECT raw_text,status,child_id FROM observations WHERE id=$1',[state.observation_id])).rows[0];record('real original observation unchanged',obs.raw_text===raw&&obs.child_id===state.child_id&&obs.status==='draft');}finally{await check.end();}
      }
    }else if(MODE==='verify-ui'){
      const original=json(JSON.parse(fs.readFileSync(path.join(ROOT,'write-result.json'),'utf8')));const outcome=json(original.outcome);assert.ok(Array.isArray(outcome.proposals));const proposal=json(outcome.proposals[0]);assert.ok(Array.isArray(proposal.items));const payload=json(json(proposal.items[0]).payload);
      const c=await db();try{
        const operations=(await c.query('SELECT * FROM yaya_operations WHERE proposal_id=$1 AND actor_account_id=$2',[proposal.proposal_id,state.teacher_id])).rows;assert.equal(operations.length,1);const op=operations[0];record('browser approval same original operation committed',op.status==='saved'&&op.effect==='committed'&&op.target_id===state.child_id&&typeof op.business_object_id==='string');state.observation_id=op.business_object_id as string;save();
        const obs=(await c.query('SELECT raw_text,status,child_id FROM observations WHERE id=$1',[state.observation_id])).rows[0];record('stored raw exactly browser-approved card',obs.raw_text===payload.raw_text&&obs.child_id===state.child_id&&obs.status==='draft');record('exactly one synthetic observation',Number((await c.query('SELECT count(*) AS n FROM observations WHERE child_id=$1',[state.child_id])).rows[0].n)===1);
        const receipt=await request(auth,'/api/yaya/operations?operation_id='+encodeURIComponent(str(op.operation_id)));record('original receipt read only HTTP',receipt.r.status===200);
      }finally{await c.end();}
    }else assert.equal(MODE,'preserve');
  }
  await preserved();console.log(JSON.stringify({stage:MODE,checks:state.checks.length,old_data:'byte-identical',real_model_requests:['write','image'].includes(MODE)?'see original event ledger':0}));
}
void main().catch(()=>{save();console.error(JSON.stringify({stage:MODE,result:'FAIL',details:'Protected artifacts retained; no automatic retry'}));process.exitCode=1;});
