import assert from 'node:assert/strict';
import { createLlmYayaModelGateway } from '../../src/lib/yaya/agent/gateway';
import { yayaAgentActionSchema } from '../../src/lib/yaya/agent/types';

const originalFetch = globalThis.fetch;
const keys = ['YAYA_PLATFORM_AUTH','COZE_PROJECT_ID','COZE_PROJECT_ENV','COZE_WORKLOAD_IDENTITY_API_KEY','YAYA_CHAT_TEXT_PROVIDER','YAYA_COZE_MODEL','STEPFUN_API_KEY'];
const original = new Map(keys.map(key => [key, process.env[key]]));
let modelOutput = '', calls = 0, passed = 0;
const failures: string[] = [];

async function main() {
  Object.assign(process.env, { YAYA_PLATFORM_AUTH:'workload', COZE_PROJECT_ID:'7690843235199139866', COZE_PROJECT_ENV:'DEV',
    COZE_WORKLOAD_IDENTITY_API_KEY:'fixture-not-a-real-token', YAYA_CHAT_TEXT_PROVIDER:'coze', YAYA_COZE_MODEL:'fixture-coze' });
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ model:'fixture-coze',choices:[{message:{content:modelOutput}}] }),{headers:{'content-type':'application/json'}});
  };
  const gateway = createLlmYayaModelGateway();
  const check = async (name: string, output: unknown, expectedValid: boolean) => {
    modelOutput = typeof output === 'string' ? output : JSON.stringify(output);
    const response = await gateway.generate({run_id:'fixture',messages:[{role:'user',text:'描述图形'}],signal:new AbortController().signal});
    let value: unknown; try { value = JSON.parse(response.content) as unknown; } catch { value = null; }
    const result = yayaAgentActionSchema.safeParse(value);
    try {
      assert.equal(result.success,expectedValid);
      if(result.success && typeof output==='object' && output!==null) {
        assert.equal(result.data.content,(output as {content:string}).content);
        if('source_refs' in output) assert.deepEqual(result.data.source_refs,output.source_refs);
      }
      passed++;
    }
    catch { failures.push(name); }
  };
  await check('Coze answer with omitted no-op fields', {action:'answer',content:'绿色三角形、黄色圆形。'},true);
  await check('Coze clarification with omitted no-op fields', {action:'clarify',content:'想了解图里的哪一部分？'},true);
  await check('complete answer stays valid', {action:'answer',content:'图形',tool:'',params_json:'',source_refs:[]},true);
  await check('explicit source refs are preserved', {action:'answer',content:'图形',source_refs:['image:1']},true);
  await check('explicit null is not defaulted', {action:'answer',content:'图形',tool:null},false);
  await check('answer cannot smuggle a tool', {action:'answer',content:'图形',tool:'create_child'},false);
  await check('answer cannot smuggle tool parameters', {action:'answer',content:'图形',params_json:'{}'},false);
  await check('unknown authority fields rejected', {action:'answer',content:'图形',approved:true},false);
  await check('missing content is not fabricated', {action:'answer'},false);
  await check('empty content is not a successful reply', {action:'answer',content:''},false);
  await check('read parameters are never repaired', {action:'read',tool:'list_children'},false);
  await check('write parameters are never repaired', {action:'propose_write',tool:'create_child'},false);
  await check('non-JSON is never promoted to an answer', '这是普通文本',false);
  process.env.YAYA_CHAT_TEXT_PROVIDER='stepfun'; process.env.STEPFUN_API_KEY='fixture-not-a-real-key';
  await check('StepFun strict schema response is not repaired', {action:'answer',content:'图形'},false);
  console.log(JSON.stringify({passed,total:14,failures,fixture_fetches:calls,real_model_requests:0}));
  if(failures.length) process.exitCode=1;
}
void main().finally(()=>{
  globalThis.fetch=originalFetch;
  for(const [key,value] of original) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
});
