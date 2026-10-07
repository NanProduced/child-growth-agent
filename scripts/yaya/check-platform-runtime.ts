/** Pure transport checks: actual AWS serializer + owned handler, no network. */
import assert from 'node:assert/strict';
import { createLlmYayaModelGateway } from '../../src/lib/yaya/agent/gateway';
import { invokeChatLlm, parseCozeModelWire } from '../../src/lib/llm';
import { platformWorkloadHeaders, configuredChatModelCallLimit } from '../../src/lib/coze-runtime';
import { S3MediaObjectStore } from '../../src/lib/media/object-store-s3';
import { loadMediaStorageConfig } from '../../src/lib/media/config';
import { sha256Hex } from '../../src/lib/media/object-store';
import { Readable } from 'node:stream';

const keys = ['YAYA_CHAT_MAX_MODEL_CALLS','YAYA_PLATFORM_AUTH','COZE_PROJECT_ID','COZE_PROJECT_ENV','COZE_WORKLOAD_IDENTITY_API_KEY','YAYA_CHAT_TEXT_PROVIDER','YAYA_CHAT_IMAGE_PROVIDER','YAYA_COZE_MODEL','STEPFUN_API_KEY','STEPFUN_BASE_URL','LLM_PROVIDER'];
const prior = new Map(keys.map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
let checks = 0;
const ok = (value: unknown) => { assert.ok(value); checks++; };
async function main() {
  try {
    delete process.env.YAYA_CHAT_MAX_MODEL_CALLS; ok(configuredChatModelCallLimit(8) === 8);
    process.env.YAYA_CHAT_MAX_MODEL_CALLS = '2'; ok(configuredChatModelCallLimit(8) === 2);
    for (const invalid of ['0', '9', '1.5', 'bad']) { process.env.YAYA_CHAT_MAX_MODEL_CALLS = invalid; assert.throws(() => configuredChatModelCallLimit(8)); checks++; }
    delete process.env.YAYA_CHAT_MAX_MODEL_CALLS;
    process.env.YAYA_PLATFORM_AUTH='workload'; process.env.COZE_PROJECT_ID='7690843235199139866'; process.env.COZE_PROJECT_ENV='DEV'; process.env.COZE_WORKLOAD_IDENTITY_API_KEY='offline-workload';
    const headers=platformWorkloadHeaders('model', {'x-run-mode':'test_run','authorization':'forged','cookie':'private'});
    ok(headers.Authorization==='Bearer offline-workload' && !('cookie' in headers) && !('x-run-mode' in headers));
    ok(platformWorkloadHeaders('storage')['x-storage-token']==='offline-workload');
    process.env.COZE_PROJECT_ID='another-project'; assert.throws(()=>platformWorkloadHeaders('model')); checks++; process.env.COZE_PROJECT_ID='7690843235199139866';
    ok(loadMediaStorageConfig({YAYA_PLATFORM_AUTH:'workload',COZE_PROJECT_ENV:'PROD',MEDIA_STORAGE_MODE:'local',MEDIA_LOCAL_ROOT:'fake'})===null);
    ok(loadMediaStorageConfig({YAYA_PLATFORM_AUTH:'workload',COZE_PROJECT_ENV:'PROD',COZE_BUCKET_NAME:'prod-bucket',COZE_BUCKET_ENDPOINT_URL:'https://integration.coze.cn/coze-coding-s3proxy/v1'})?.environment==='production');
    process.env.YAYA_CHAT_TEXT_PROVIDER='stepfun';process.env.YAYA_CHAT_IMAGE_PROVIDER='coze';process.env.YAYA_COZE_MODEL='doubao-seed-2-0-mini-260215';process.env.LLM_PROVIDER='stepfun';process.env.STEPFUN_API_KEY='offline-stepfun';
    const captured:Array<{url:string;body:Record<string,unknown>;headers:Headers}>=[];
    globalThis.fetch=(async(input,init)=>{captured.push({url:String(input),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});return new Response(JSON.stringify({choices:[{message:{content:'{"action":"answer","content":"合成回答","tool":"","params_json":"","source_refs":[]}'}}]}),{status:200});}) as typeof fetch;
    const gateway=createLlmYayaModelGateway({dateAnchor:'2026-10-07'});
    await gateway.generate({run_id:'owned-test',messages:[{role:'user',text:'今天记录'}],signal:new AbortController().signal});
    ok(JSON.stringify(captured[0]?.body.messages).includes('2026-10-07')); ok(JSON.stringify(captured[0]?.body.messages).includes('今天记录'));
    const image=await invokeChatLlm([{role:'user',content:'看图',images:[{media_type:'image/jpeg',data_base64:'YWJj'}]}]);
    ok(image.provider==='coze' && image.model==='doubao-seed-2-0-mini-260215');
    ok(captured[1]?.url==='https://integration.coze.cn/api/v3/chat/completions' && captured[1].headers.get('authorization')==='Bearer offline-workload');
    ok(JSON.stringify(captured[1]?.body.messages).includes('data:image/jpeg;base64,YWJj'));
    const stream='data: '+JSON.stringify({model:'mini',choices:[{delta:{content:'合成',reasoning_content:'must not emit'}}]})+'\n\ndata: '+JSON.stringify({model:'mini',choices:[{delta:{content:'回答'},finish_reason:'stop'}],usage:{total_tokens:2}})+'\n\ndata: [DONE]\n';
    ok(JSON.stringify(parseCozeModelWire(stream,'text/event-stream')).includes('合成回答'));
    ok(!JSON.stringify(parseCozeModelWire(stream,'text/event-stream')).includes('must not emit'));
    assert.throws(()=>parseCozeModelWire('<html>login</html>','text/html'));checks++;
    assert.throws(()=>parseCozeModelWire('data: '+JSON.stringify({choices:[{delta:{content:'unfinished'}}]}),'text/event-stream'));checks++;
    assert.throws(()=>parseCozeModelWire(stream+'\ndata: {}','text/event-stream'));checks++;
    const objects=new Map<string,{body:Buffer;checksum:string}>();const requests:Array<{method:string;path:string;headers:Record<string,string>}>=[];
    let denied=false;
    const store=new S3MediaObjectStore({bucket:'owned-bucket',endpoint:'https://integration.coze.cn/coze-coding-s3proxy/v1',region:'cn-beijing',requestHandler:{handle:async(request: {method:string;path:string;headers:Record<string,string>;body?:unknown})=>{
      requests.push({method:request.method,path:request.path,headers:request.headers});
      if(denied)return{response:{statusCode:403,headers:{},body:Readable.from(['<Error><Code>AccessDenied</Code></Error>'])}};
      const existing=objects.get(request.path);
      if(request.method==='PUT'){
        // Faithful proxy: conditional PUT is ignored, even if a caller adds it.
        objects.set(request.path,{body:Buffer.from(request.body as Uint8Array),checksum:request.headers['x-amz-meta-sha256']!});
        return{response:{statusCode:200,headers:{etag:'"owned"'},body:Readable.from([])}};
      }
      if(request.method==='DELETE'){objects.delete(request.path);return{response:{statusCode:204,headers:{},body:Readable.from([])}};}
      return existing?{response:{statusCode:200,headers:{'content-length':String(existing.body.length),'x-amz-meta-sha256':existing.checksum},body:Readable.from(request.method==='HEAD'?[]:[existing.body])}}:{response:{statusCode:404,headers:{},body:Readable.from(['<Error><Code>NoSuchKey</Code></Error>'])}};
    }}});
    const data=Buffer.from('owned synthesis');
    const key='media/dev/owned/attachment/original/'+sha256Hex(data);
    ok((await store.putOnce({key,content_type:'image/jpeg',body:data})).outcome==='created');
    const put=requests.find(r=>r.method==='PUT')!;
    ok(put.path.endsWith(key) && put.headers['x-storage-token']==='offline-workload' && !put.headers.authorization);
    ok(put.headers['x-amz-meta-sha256']===sha256Hex(data));
    ok((await store.putOnce({key,content_type:'image/jpeg',body:data})).outcome==='already_present');
    ok((await store.putOnce({key,content_type:'image/jpeg',body:Buffer.from('different')})).outcome==='conflict');
    ok(requests.filter(r=>r.method==='PUT').length===1);
    ok((await store.get(key))?.body.equals(data));
    denied=true;await assert.rejects(()=>store.get(key));checks++;ok(await store.delete(key)==='unknown');
    denied=false;ok(await store.delete(key)==='deleted');ok(await store.get(key)===null);
    const pair=await Promise.all([store.putOnce({key,content_type:'image/jpeg',body:data}),store.putOnce({key,content_type:'image/jpeg',body:data})]);
    ok(pair.every(p=>p.outcome==='created'||p.outcome==='already_present'));
    ok((await store.get(key))?.body.equals(data));
    ok((await store.putOnce({key,content_type:'image/jpeg',body:Buffer.from('late wrong content')})).outcome==='conflict');
    console.log(JSON.stringify({passed:checks,real_model_requests:0,real_storage_requests:0,aws_serializer:'real',transport:'in-process handler'}));
  } finally {globalThis.fetch=originalFetch;for(const[k,v]of prior){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
