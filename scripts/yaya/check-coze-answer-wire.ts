import assert from 'node:assert/strict';
import { z } from 'zod';
import { createLlmYayaModelGateway } from '../../src/lib/yaya/agent/gateway';
import { invokeLlm } from '../../src/lib/llm';
import { yayaAgentActionSchema, zodToolParams, type YayaToolCatalog } from '../../src/lib/yaya/agent/types';

const originalFetch = globalThis.fetch;
const keys = ['YAYA_PLATFORM_AUTH','COZE_PROJECT_ID','COZE_PROJECT_ENV','COZE_WORKLOAD_IDENTITY_API_KEY','YAYA_CHAT_TEXT_PROVIDER','YAYA_COZE_MODEL','STEPFUN_API_KEY'];
const original = new Map(keys.map(key => [key, process.env[key]]));
let modelOutput = '', responseWire: string | null = null, responseContentType = 'application/json', calls = 0, passed = 0;
const failures: string[] = [];

async function main() {
  Object.assign(process.env, { YAYA_PLATFORM_AUTH:'workload', COZE_PROJECT_ID:'7690843235199139866', COZE_PROJECT_ENV:'DEV',
    COZE_WORKLOAD_IDENTITY_API_KEY:'fixture-not-a-real-token', YAYA_CHAT_TEXT_PROVIDER:'coze', YAYA_COZE_MODEL:'fixture-coze' });
  const capturedBodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    calls++;
    capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (responseWire !== null) {
      return new Response(responseWire, { headers: { 'content-type': responseContentType } });
    }
    return new Response(JSON.stringify({ model:'fixture-coze',choices:[{message:{content:modelOutput}}] }),{headers:{'content-type':'application/json'}});
  };
  const tools: YayaToolCatalog = {
    read_tools: [{
      tool: 'list_children',
      description: '按姓名匹配当前授权范围内的幼儿',
      scope_policy: 'business_scope',
      params: zodToolParams(z.object({ name: z.string().optional() }).strict()),
    }],
    write_tools: [],
  };
  const gateway = createLlmYayaModelGateway({ tools });
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
  const checkAsync = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      passed++;
    } catch {
      failures.push(name);
    }
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
  await check('Coze plain text is normalized to a safe answer', '这是普通文本',true);
  await checkAsync('Coze workload uses Prompt/Zod for action output', async () => {
    const format = capturedBodies.at(-1)?.response_format as Record<string, unknown> | undefined;
    assert.equal(format, undefined);
  });
  await checkAsync('legacy Coze structured calls use Prompt/Zod instead of strict schema', async () => {
    modelOutput = '{"decision":"proceed","question":"","reason":""}';
    await invokeLlm([{ role: 'user', content: '判断是否需要追问' }], { responseType: 'follow_up_decision' });
    assert.equal('response_format' in (capturedBodies.at(-1) ?? {}), false);
  });
  await checkAsync('native Coze tool call becomes a bounded read action', async () => {
    responseWire = JSON.stringify({ model: 'fixture-coze', choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_children', arguments: '{"name":"罗子墨"}' } }] } }] });
    responseContentType = 'application/json';
    const response = await gateway.generate({ run_id:'fixture',messages:[{role:'user',text:'请记录罗子墨今天的观察'}],signal:new AbortController().signal });
    const value = JSON.parse(response.content) as Record<string, unknown>;
    assert.equal(value.action, 'read');
    assert.equal(value.tool, 'list_children');
    assert.equal(value.params_json, '{"name":"罗子墨"}');
    const bodyTools = capturedBodies.at(-1)?.tools as Array<Record<string, unknown>> | undefined;
    assert.equal(bodyTools?.[0]?.type, 'function');
    assert.equal((bodyTools?.[0]?.function as Record<string, unknown>)?.name, 'list_children');
  });
  await checkAsync('native Coze SSE tool fragments are assembled', async () => {
    responseWire = [
      `data: ${JSON.stringify({ model: 'fixture-coze', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', function: { name: 'list_children', arguments: '{"name":"' } }] } }] })}`,
      `data: ${JSON.stringify({ model: 'fixture-coze', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '周米朵"}' } }] }, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    responseContentType = 'text/event-stream';
    const response = await gateway.generate({ run_id:'fixture',messages:[{role:'user',text:'匹配周米朵'}],signal:new AbortController().signal });
    assert.equal((JSON.parse(response.content) as Record<string, unknown>).params_json, '{"name":"周米朵"}');
    responseWire = null;
    responseContentType = 'application/json';
  });
  await checkAsync('unknown native tool is rejected', async () => {
    responseWire = JSON.stringify({ model: 'fixture-coze', choices: [{ message: { content: '', tool_calls: [{ id: 'call-3', type: 'function', function: { name: 'not_registered', arguments: '{}' } }] } }] });
    await assert.rejects(() => gateway.generate({ run_id:'fixture',messages:[{role:'user',text:'执行未知工具'}],signal:new AbortController().signal }));
    responseWire = null;
  });
  await checkAsync('multiple native tool calls are rejected', async () => {
    responseWire = JSON.stringify({ model: 'fixture-coze', choices: [{ message: { content: '', tool_calls: [
      { id: 'call-4', type: 'function', function: { name: 'list_children', arguments: '{}' } },
      { id: 'call-5', type: 'function', function: { name: 'list_children', arguments: '{}' } },
    ] } }] });
    await assert.rejects(() => gateway.generate({ run_id:'fixture',messages:[{role:'user',text:'执行两个工具'}],signal:new AbortController().signal }));
    responseWire = null;
  });
  process.env.YAYA_CHAT_TEXT_PROVIDER='stepfun'; process.env.STEPFUN_API_KEY='fixture-not-a-real-key';
  await check('StepFun strict schema response is not repaired', {action:'answer',content:'图形'},false);
  console.log(JSON.stringify({passed,total:passed + failures.length,failures,fixture_fetches:calls,real_model_requests:0}));
  if(failures.length) process.exitCode=1;
}
void main().finally(()=>{
  globalThis.fetch=originalFetch;
  for(const [key,value] of original) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
});
