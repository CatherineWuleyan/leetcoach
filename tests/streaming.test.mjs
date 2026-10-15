import assert from 'node:assert/strict';
import {callModel} from '../src/providers.js';
const cfg={kind:'openai',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',apiKey:'TEST',system:'S',messages:[{role:'user',content:'hint'}]};
const json=text=>new Response(JSON.stringify({choices:[{message:{content:text}}]}),{headers:{'Content-Type':'application/json'}});
const encoder=new TextEncoder();
const event=data=>'data: '+JSON.stringify(data)+'\r\n\r\n';
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✅ '+name);}
await test('教练 Flash 显式启用 high 深度思考，并为思考和正文留足输出预算',async()=>{
 let body;global.fetch=async(_u,init)=>{body=JSON.parse(init.body);return json('hint');};
 await callModel(cfg);assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'high');assert.ok(body.max_tokens>=8192);assert.equal(body.stream,undefined);
});
await test('不把 DeepSeek 特有参数传给其他厂商，也不擅自关闭 Pro 的思考',async()=>{
 const bodies=[];global.fetch=async(_u,init)=>{bodies.push(JSON.parse(init.body));return json('x');};
 await callModel({...cfg,baseUrl:'https://other.example/v1'});
 await callModel({...cfg,model:'deepseek-v4-pro'});
 assert.ok(bodies.every(body=>!body.thinking));
});
await test('逐字流式答复可在结束前显示，跨字节中文正确，不显示内部思考',async()=>{
 let controller,body;const parts=[];
 global.fetch=async(_u,init)=>{
  body=JSON.parse(init.body);
  return new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'Content-Type':'text/event-stream'}});
 };
 const pending=callModel({...cfg,onText:text=>parts.push(text)});
 await new Promise(resolve=>setImmediate(resolve));
 const first=event({choices:[{delta:{reasoning_content:'INTERNAL_REASONING'}}]})+event({choices:[{delta:{content:'方向'}}]});
 for(const byte of encoder.encode(first))controller.enqueue(new Uint8Array([byte]));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(parts.at(-1),'方向','HTTP 结束前应已有文本');
 controller.enqueue(encoder.encode(event({choices:[{delta:{content:'提示'}}]})+event({choices:[],usage:{completion_tokens:4}})+'data: [DONE]\r\n\r\n'));
 const out=await pending;
 assert.equal(body.stream,true);assert.equal(out.text,'方向提示');assert.equal(out.usage.completion_tokens,4);
 assert.ok(parts.every(part=>!part.includes('INTERNAL_REASONING')));
});
await test('服务商忽略流式参数返回普通 JSON 时仍能显示',async()=>{
 const parts=[];global.fetch=async()=>json('fallback');
 const out=await callModel({...cfg,onText:t=>parts.push(t)});
 assert.deepEqual(parts,['fallback']);assert.equal(out.text,'fallback');
});
await test('流中错误不会当作成功答案',async()=>{
 global.fetch=async()=>new Response(event({error:{message:'upstream failed'}}),{headers:{'Content-Type':'text/event-stream'}});
 await assert.rejects(()=>callModel({...cfg,onText(){}}),/upstream failed/);
});
await test('仅有思考内容不冒充最终答复',async()=>{
 global.fetch=async()=>new Response(event({choices:[{delta:{reasoning_content:'hidden'}}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 await assert.rejects(()=>callModel({...cfg,onText(){}}),/没有返回答复/);
});
await test('读取响应体期间仍有超时保护',async()=>{
 global.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){
  init.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')));
 }}),{headers:{'Content-Type':'text/event-stream'}});
 await assert.rejects(()=>callModel({...cfg,onText(){},timeoutMs:20}),/请求超时/);
});
await test('新问题可取消正在流中等待的后台总结请求',async()=>{
 const external=new AbortController();
 global.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){
  init.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')));
 }}),{headers:{'Content-Type':'text/event-stream'}});
 const pending=callModel({...cfg,onText(){},signal:external.signal});
 await new Promise(resolve=>setImmediate(resolve));external.abort();
 await assert.rejects(()=>pending,error=>error.name==='AbortError');
});
await test('非流式后台总结读取响应体期间同样受超时保护',async()=>{
 global.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){
  init.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')));
 }}),{headers:{'Content-Type':'application/json'}});
 await assert.rejects(()=>callModel({...cfg,timeoutMs:20}),/请求超时/);
});
await test('后台总结可单独关闭思考，不影响教练 high 模式',async()=>{
 let body;global.fetch=async(_u,init)=>{body=JSON.parse(init.body);return json('summary');};
 await callModel({...cfg,thinking:'disabled',maxTokens:2600});
 assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.reasoning_effort,undefined);assert.equal(body.max_tokens,2600);
});
console.log(`通过 ${passed} 项速度与流式回归测试`);
