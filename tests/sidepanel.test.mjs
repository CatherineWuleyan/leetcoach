import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as config from '../src/config.js';
import * as prompts from '../src/prompts.js';
import * as archive from '../src/archive.js';
import {renderMarkdown} from '../src/markdown.js';
import {openManualNotes} from '../src/manual-notes.js';
const source=fs.readFileSync(new URL('../src/sidepanel.js',import.meta.url),'utf8')
  .replace(/^import\s+[\s\S]*?from\s+"[^"]+";/gm,'').replace(/init\(\)\.catch\([\s\S]*$/,'');
const problem={number:'1',slug:'two-sum',title:'1. 两数之和',description:'ORIGINAL_PROBLEM',language:'C++',topics:['数组','哈希表']};
const summary=`@@PROBLEM@@
### LC 1 · 两数之和
#数组 #哈希表
**题意**：在数组中找出和等于目标值的两个不同位置。
- **思路**：查询目标差值。
- **迁移**：改为有序数组。
@@SYNTAX@@`;
function setup(saved={}, hash="") {
  const elements=new Map();
  const el=id=>{
    if(!elements.has(id)) elements.set(id,{value:'',textContent:'',innerHTML:'',checked:false,
      classList:{toggle(){}},events:{},appendChild(){},addEventListener(type,fn){this.events[type]=fn;}});
    return elements.get(id);
  };
  const store=structuredClone(saved),listeners=[];
  const ctx=vm.createContext({...config,...prompts,...archive,renderMarkdown,openManualNotes,console,URL,AbortController,AbortSignal,structuredClone,
    setTimeout:()=>1,clearTimeout(){},location:{hash},navigator:{clipboard:{writeText:async()=>{}}},
    document:{getElementById:el,querySelectorAll:()=>[],createElement:()=>el(Symbol())},
    chrome:{storageChanged:[],permissions:{contains:async()=>true},storage:{onChanged:{addListener(){}},local:{
      get:async()=>structuredClone(store),set:async data=>Object.assign(store,structuredClone(data))}},
      scripting:{executeScript:async()=>[{result:{ok:true,code:'CURRENT_EDITOR_CODE'}}]},
      tabs:{onActivated:{addListener(){}},onUpdated:{addListener(){}},query:(_q,cb)=>cb([{id:7,url:'https://leetcode.cn/problems/two-sum/'}]),
        sendMessage:(_id,_m,cb)=>cb(structuredClone(problem))},
      runtime:{onMessage:{addListener(fn){listeners.push(fn);}}}},
    callModel:async()=>({text:'REPLY'}),listModels:async()=>[],PROBE_EDITOR(){}});
  vm.runInContext(source,ctx);
  const run=code=>vm.runInContext(code,ctx);
  ctx.testProblem=problem;
  run("state.problem=testProblem;state.currentTabId=7;ensureSession(testProblem);state.settings.apiKey='TEST';");
  return {ctx,el,run,store,listeners};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✅ '+name);}
await test('首次 hint、再次算法思路、第三层必须显式选择完整解法',async()=>{
  const h=setup(),calls=[];h.ctx.syncArchives=async()=>{};
  h.ctx.callModel=async cfg=>{calls.push(cfg);return {text:'REPLY'};};
  await h.run('runQuestion()');assert.equal(h.run('currentSession().stage'),1);
  assert.ok(calls[0].messages[0].content.includes('第 1 层'));
  await h.run('runQuestion()');assert.equal(h.run('currentSession().stage'),2);
  await h.run('runQuestion()');assert.equal(calls.length,2,'快捷发送不得默认授权完整代码');
  await h.run('runQuestion("ladder",{fullSolution:true})');
  assert.equal(h.run('currentSession().stage'),3);
  assert.ok(calls[2].messages[0].content.includes('明确选择完整解法'));
});
await test('问细节不推进层级，空问题不调用模型',async()=>{
  const h=setup();h.ctx.syncArchives=async()=>{};
  h.run('currentSession().stage=1');
  h.el('ask').value='为什么这里是 n-1？';
  await h.run('runQuestion("detail")');assert.equal(h.run('currentSession().stage'),1);
  assert.equal(h.run('currentSession().history[0].content'),'为什么这里是 n-1？');
  const count=h.run('currentSession().history.length');
  await h.run('runQuestion("detail")');assert.equal(h.run('currentSession().history.length'),count);
});
await test('可从首轮一键直达算法或代码，再选 Hint 只请求对应深度',async()=>{
  for (const [button,step] of [['btn-approach',2],['btn-code',3]]) {
    const h=setup(),calls=[];h.ctx.syncArchives=async()=>{};
    h.ctx.callModel=async cfg=>{calls.push(cfg);return {text:'REPLY'};};
    h.run('bindEvents()');
    await h.el(button).events.click();
    assert.equal(calls.length,1);assert.equal(h.run('currentSession().stage'),step);
    assert.ok(calls[0].messages[0].content.includes(`第 ${step} 层`));
    assert.equal(calls[0].messages[0].content.includes('明确选择完整解法'),step===3);
    await h.el('btn-hint').events.click();
    assert.equal(h.run('currentSession().stage'),1);
    assert.ok(calls[1].messages[0].content.includes('第 1 层'));
    assert.ok(!calls[1].messages[0].content.includes('明确选择完整解法'));
  }
  const h=setup();h.ctx.syncArchives=async()=>{};
  let calls=0;h.ctx.callModel=async()=>{calls++;return {text:'REPLY'};};
  await h.run('runQuestion("ladder",{ladderStep:3})');
  assert.equal(calls,0,'直达代码仍必须有本次明确授权');
});
await test('Shift Enter 发送问细节，不升级；普通回车和输入法确认不发送',async()=>{
  const h=setup(),calls=[];h.ctx.syncArchives=async()=>{};
  h.ctx.callModel=async cfg=>{calls.push(cfg);return {text:'REPLY'};};
  h.run('currentSession().stage=2;bindEvents()');
  h.el('ask').value='为什么要先查询？';
  let prevented=0;
  const keydown=overrides=>h.el('ask').events.keydown({key:'Enter',preventDefault(){prevented++;},...overrides});
  keydown({});
  keydown({shiftKey:true,isComposing:true});
  keydown({shiftKey:true,keyCode:229});
  assert.equal(prevented,0);assert.equal(calls.length,0);
  keydown({shiftKey:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prevented,1);assert.equal(calls.length,1);
  assert.equal(h.run('currentSession().stage'),2);
  assert.equal(h.run('currentSession().history[0].content'),'为什么要先查询？');
  assert.ok(calls[0].messages[0].content.includes('问细节'));
});
await test('Alt/Option 数字键直接选择深度，兼容 Mac 符号且不重复发送',async()=>{
  for (const [step,key] of [[1,'¡'],[2,'™'],[3,'£']]) {
    const h=setup(),calls=[];h.ctx.syncArchives=async()=>{};
    h.ctx.callModel=async cfg=>{calls.push(cfg);return {text:'REPLY'};};
    h.run('bindEvents()');
    let prevented=0;
    const keydown=overrides=>h.el('ask').events.keydown({code:`Digit${step}`,key,altKey:true,preventDefault(){prevented++;},...overrides});
    keydown({isComposing:true});keydown({ctrlKey:true});keydown({metaKey:true});keydown({shiftKey:true});
    assert.equal(prevented,0);assert.equal(calls.length,0);
    keydown({repeat:true});
    assert.equal(calls.length,0);
    keydown({});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(prevented,2);assert.equal(calls.length,1);
    assert.equal(h.run('currentSession().stage'),step);
    assert.ok(calls[0].messages[0].content.includes(`第 ${step} 层`));
    assert.equal(calls[0].messages[0].content.includes('明确选择完整解法'),step===3);
  }
  const h=setup();h.run('currentSession().stage=2;bindEvents()');
  let calls=0;h.ctx.callModel=async()=>{calls++;return {text:'REPLY'};};
  h.el('ask').events.keydown({key:'Enter',metaKey:true,preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0,'普通发送快捷键不能授权完整代码');
});
await test('失败不升级；已提问内容仍保存到待总结记录',async()=>{
  const h=setup();h.ctx.syncArchives=async()=>{};
  h.ctx.callModel=async()=>{throw Error('offline');};h.el('ask').value='我不会这一题';
  await h.run('runQuestion()');assert.equal(h.run('currentSession().stage'),0);
  assert.equal(h.store.sessions['LC 1'].history[0].content,'我不会这一题');
  assert.equal(h.run('pendingSessions().length'),1);
});
await test('离线保留队列，重新打开侧栏后恢复全部题目',async()=>{
  const h=setup();h.ctx.syncArchives=async()=>{};
  await h.run('runQuestion()');
  const restored=setup(h.store);await restored.run('loadStorage()');
  assert.equal(restored.run('pendingSessions().length'),1);
  assert.equal(restored.run('state.sessions["LC 1"].history.length'),2);
});
await test('换题期间的迟到回复保存在原题，不覆盖当前页面',async()=>{
  const h=setup();h.ctx.syncArchives=async()=>{};let finish;
  h.ctx.callModel=()=>new Promise(resolve=>{finish=resolve;});
  const pending=h.run('runQuestion()');await new Promise(r=>setImmediate(r));
  h.run("state.problem={number:'2',slug:'add-two-numbers',title:'两数相加'};ensureSession(state.problem)");
  h.el('output').innerHTML='NEW_PROBLEM';finish({text:'OLD_REPLY'});await pending;
  assert.equal(h.el('output').innerHTML,'NEW_PROBLEM');
  assert.equal(h.run('state.sessions["LC 1"].lastOutput'),'OLD_REPLY');
  assert.equal(h.run('pendingSessions().length'),1);
});
await test('桥离线时不花费总结调用；题目待同步状态不会丢失',async()=>{
  const h=setup();h.run("currentSession().revision=1;state.settings.bridge.token='local-token'");
  let calls=0;h.ctx.callModel=async()=>{calls++;return {text:summary};};
  h.ctx.bridgeFetch=async()=>{throw Error('Failed to fetch');};
  await h.run('syncArchives()');assert.equal(calls,0);assert.equal(h.run('pendingSessions().length'),1);
});
await test('成功总结写入文件之后才清除待同步状态',async()=>{
  const h=setup(),writes=[];
  h.run("currentSession().revision=2;currentSession().history=[{role:'user',content:'第一问'}];state.settings.bridge.token='local-token'");
  h.ctx.callModel=async()=>({text:summary});
  h.ctx.bridgeFetch=async(url,args)=>{if(args)writes.push(args.body);return {ok:true};};
  await h.run('syncArchives()');assert.equal(writes.length,1);
  assert.equal(writes[0].path,config.DEFAULT_SETTINGS.obsidian.path);
  assert.ok(writes[0].problem.markdown.includes('**思路**'));
  assert.ok(writes[0].problem.markdown.includes('#数组 #哈希表'));
  assert.ok(!writes[0].problem.markdown.includes('ORIGINAL_PROBLEM'));
  assert.equal(h.run('pendingSessions().length'),0);
});
await test('磁盘写入失败保留待归档记录，重试后才标记同步完成',async()=>{
  const h=setup();h.run("currentSession().revision=2;state.settings.bridge.token='local-token'");
  h.ctx.callModel=async()=>({text:summary});
  h.ctx.bridgeFetch=async(_url,args)=>{if(args)throw Error('EACCES');return {};};
  await h.run('syncArchives()');assert.equal(h.run('pendingSessions().length'),1);
  h.ctx.bridgeFetch=async()=>({});await h.run('syncArchives()');assert.equal(h.run('pendingSessions().length'),0);
});
await test('归档进行中出现新问题时，继续同步新修订，所有提问保留',async()=>{
  const h=setup();h.run("currentSession().revision=1;currentSession().history=[{role:'user',content:'第一问'}];state.settings.bridge.token='token'");
  let calls=0;h.ctx.callModel=async cfg=>{
    calls++;if(calls===1)h.run("currentSession().history.push({role:'user',content:'第二问'});currentSession().revision++");
    else assert.ok(cfg.messages.some(m=>m.content==='第二问'));
    return {text:summary};
  };
  h.ctx.bridgeFetch=async()=>({});await h.run('syncArchives()');
  assert.equal(calls,2);assert.equal(h.run('pendingSessions().length'),0);
});
await test('Prompt 迁移不会清空用户已保存的 DeepSeek Key',async()=>{
  const h=setup({settings:{provider:'deepseek',apiKey:'PRESERVE',coachPrompt:'OLD'}});
  await h.run('loadStorage()');assert.equal(h.run('state.settings.apiKey'),'PRESERVE');
  assert.ok(h.run('state.settings.coachPrompt').includes('quant research interviews'));
});
await test('不同标签页的事件不覆盖当前问题，切换服务商不复用旧 Key',async()=>{
  const h=setup();h.run('bindEvents()');
  h.listeners[0]({type:'lc-coach:event',event:{kind:'submitted',code:'OTHER'}},{tab:{id:8}});
  assert.equal(h.run('currentSession().code'),'');
  h.el('provider').events.change({target:{value:'anthropic'}});
  assert.equal(h.run('state.settings.apiKey'),'');
});
await test('界面不显示代码和旧模式，整体归档选项保留在设置中',()=>{
  const html=fs.readFileSync(new URL('../src/sidepanel.html',import.meta.url),'utf8');
  for(const id of ['id="code"','id="modes"','id="auto-note"','id="btn-save-note"'])assert.ok(!html.includes(id));
  for(const label of ['问细节','整体归档','归档到本地文件'])assert.ok(html.includes(label));
});
await test('单独的设置页不创建或覆盖学习会话、不启动归档任务',async()=>{
  const sessions={'LC 99':{history:[{role:'user',content:'保留原问题'}],revision:2}};
  const h=setup({settings:{uiVersion:2,apiKey:'KEEP'},sessions},'#settings');
  h.ctx.chrome.tabs.query=()=>{throw Error('设置页不应读取题目');};
  await h.run('init()');
  assert.deepEqual(h.store.sessions,sessions);
});
await test('总结生成时撤销整体归档，不得再写入完整题面和代码',async()=>{
  const h=setup();h.run("currentSession().revision=1;currentSession().fullArchive=true;state.settings.bridge.token='token'");
  let calls=0;const writes=[];
  h.ctx.callModel=async()=>{calls++;if(calls===1)h.run('currentSession().fullArchive=false;currentSession().revision++');return {text:summary};};
  h.ctx.bridgeFetch=async(_url,args)=>{if(args)writes.push(args.body);return {};};
  await h.run('syncArchives()');
  assert.equal(calls,2);assert.equal(writes.length,1);
  assert.ok(!writes[0].problem.markdown.includes('ORIGINAL_PROBLEM'));
});
await test('教练回答优先，思考中不启动后台归档',async()=>{
  const h=setup();let calls=0;
  h.run("currentSession().revision=1;state.busy=true;state.settings.bridge.token='token'");
  h.ctx.callModel=async()=>{calls++;return {text:summary};};
  h.ctx.bridgeFetch=async()=>({});await h.run('syncArchives()');
  assert.equal(calls,0);assert.equal(h.run('pendingSessions().length'),1);
});
await test('新提问取消旧归档，待归档记录保留且不会显示取消错误',async()=>{
  const h=setup();h.run("currentSession().revision=1;state.settings.bridge.token='token'");
  h.ctx.bridgeFetch=async()=>({});
  h.ctx.callModel=async request=>{
    if(request.signal)return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('cancelled'))));
    return {text:'NEW_REPLY'};
  };
  const sync=h.run('syncArchives()');await new Promise(resolve=>setImmediate(resolve));
  await h.run('runQuestion()');await sync;
  assert.equal(h.run('currentSession().lastOutput'),'NEW_REPLY');
  assert.equal(h.run('state.archiveError'),'');assert.equal(h.run('pendingSessions().length'),1);
});
await test('流式正文立即显示，并保存首字与总耗时诊断',async()=>{
  const h=setup();h.ctx.callModel=async request=>{request.onText('已开始');assert.ok(h.el('output').innerHTML.includes('已开始'));return {text:'完整回复'};};
  await h.run('runQuestion()');assert.ok(h.el('output').innerHTML.includes('完整回复'));
  assert.equal(h.run('currentSession().responseTiming.model'),'deepseek-flash');
  assert.equal(typeof h.run('currentSession().responseTiming.firstTextMs'),'number');
});
await test('新版英文 Prompt 只迁移一次，保留后续自定义 Prompt 与个人归档路径',async()=>{
  const h=setup({settings:{uiVersion:2,coachPromptVersion:1,apiKey:'KEEP',coachPrompt:'CUSTOM',obsidian:{path:'/personal/notes.md'}}});
  await h.run('loadStorage()');
  assert.equal(h.run('state.settings.coachPrompt'),'CUSTOM');
  assert.equal(h.run('state.settings.obsidian.path'),'/personal/notes.md');
});
await test('默认 Prompt 是用户指定规则的英文版',()=>{
  const prompt=prompts.DEFAULT_COACH_PROMPT;
  assert.ok(!/[\u4e00-\u9fff]/.test(prompt));
  for(const rule of ['quant trading / quant research','HRT, Jump Trading, and DRW','at most three sentences','Do not provide code or pseudocode','current task explicitly authorizes','minimal syntax snippet','operation counts','Respond in Chinese'])assert.ok(prompt.includes(rule),rule);
});
await test('升级后移除旧暂停状态、默认继续归档，保留 Key、自定义 Prompt 与手记',async()=>{
  const h=setup({settings:{uiVersion:2,coachPromptVersion:1,archivePaused:true,apiKey:'KEEP',coachPrompt:'CUSTOM'},
    'manual-note:LC 1':{text:'我的思路'}});
  await h.run('loadStorage()');
  assert.equal(h.run('"archivePaused" in state.settings'),false);
  assert.equal('archivePaused' in h.store.settings,false);
  assert.equal(h.store.settings.apiKey,'KEEP');assert.equal(h.store.settings.coachPrompt,'CUSTOM');
  h.run("ensureSession(testProblem);currentSession().revision=3;state.settings.bridge.token='test'");
  h.ctx.bridgeFetch=async()=>({ok:true});h.ctx.callModel=async()=>({text:summary});
  await h.run('syncArchives()');
  assert.equal(h.run('pendingSessions().length'),0);
  assert.equal(h.store['manual-note:LC 1'].text,'我的思路');
});
await test('缺少官方标签直接采用摘要中的通用标签，不增加模型请求',async()=>{
  const h=setup();let calls=0,writes=[];
  h.run("currentSession().revision=1;currentSession().problem.topics=[];state.settings.bridge.token='test'");
  h.ctx.bridgeFetch=async(_path,options)=>{if(options)writes.push(options.body);return {ok:true};};
  h.ctx.callModel=async request=>{calls++;assert.match(request.messages[0].content,/无需额外查询/);return {text:summary.replace('#数组 #哈希表','#数组 #HashMap')};};
  await h.run('syncArchives()');
  assert.equal(calls,1);assert.equal(writes.length,1);
  assert.ok(writes[0].problem.markdown.includes('#数组 #哈希表'));
  assert.equal(h.run('pendingSessions().length'),0);
});
await test('扩展重载后只补注入一次脚本并重连，不刷新题目页或改动编辑器',async()=>{
  const h=setup();let attempts=0;const injected=[];
  h.ctx.chrome.tabs.sendMessage=(_id,_message,cb)=>{
    if (++attempts===1) {h.ctx.chrome.runtime.lastError={message:'Could not establish connection. Receiving end does not exist.'};cb();delete h.ctx.chrome.runtime.lastError;}
    else cb(structuredClone(problem));
  };
  h.ctx.chrome.scripting.executeScript=async args=>{injected.push(args);};
  await h.run('refreshProblem()');
  assert.equal(attempts,2);assert.equal(injected.length,1);
  assert.equal(injected[0].files[0],'src/content.js');assert.equal(h.run('state.problem.slug'),'two-sum');
  h.ctx.chrome.tabs.sendMessage=(_id,_message,cb)=>{h.ctx.chrome.runtime.lastError={message:'Permission denied'};cb();delete h.ctx.chrome.runtime.lastError;};
  await h.run('refreshProblem()');assert.equal(injected.length,1,'其他错误不重复注入');
});
await test('重复补注入不会重复注册消息监听和提交拦截',()=>{
  let messages=0,relays=0,hooks=0;
  const context=vm.createContext({location:{hostname:'leetcode.cn'},console,
    document:{createElement:()=>({}),head:{appendChild(){hooks++;}}},
    window:{addEventListener(){relays++;}},chrome:{runtime:{getURL:path=>path,onMessage:{addListener(){messages++;}}}}});
  const script=fs.readFileSync(new URL('../src/content.js',import.meta.url),'utf8');
  vm.runInContext(script,context);vm.runInContext(script,context);
  assert.equal(messages,1);assert.equal(relays,1);assert.equal(hooks,1);
});
console.log(`通过 ${passed} 项侧栏流程测试`);
