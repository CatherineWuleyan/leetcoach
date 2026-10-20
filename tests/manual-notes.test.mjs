import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createNoteWriter,noteStorageKey,openManualNotes} from '../src/manual-notes.js';
import {createNoteSynchronizer,manualNoteTarget,NOTE_SYNC_STATE} from '../src/note-sync.js';
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✅ '+name);}

await test('手记逐题存储，顺序写入保留最新输入；不覆盖设置和对话',async()=>{
  const store={settings:{apiKey:'KEEP'},sessions:{'LC 15':{stage:2}}};
  let release;
  const storage={set:async data=>{if(Object.values(data)[0].text==='first')await new Promise(resolve=>{release=resolve;});Object.assign(store,data);}};
  const save=createNoteWriter(storage);
  const first=save('LC 15',{title:'三数之和',text:'first'});
  const last=save('LC 15',{title:'三数之和',text:'latest'});
  const other=save('LC 3',{title:'子串',text:'另一题'});
  await new Promise(resolve=>setImmediate(resolve));await other;
  assert.equal(store['manual-note:LC 3'].text,'另一题');
  release();await Promise.all([first,last]);
  assert.equal(store['manual-note:LC 15'].text,'latest');
  assert.equal(store.settings.apiKey,'KEEP');assert.equal(store.sessions['LC 15'].stage,2);
});
await test('存储失败可重试，并允许清空已存手记',async()=>{
  const store={};let fail=true;
  const save=createNoteWriter({set:async data=>{if(fail)throw Error('quota');Object.assign(store,data);}});
  await assert.rejects(save('LC 15',{title:'三数之和',text:'原文'}),/quota/);
  fail=false;await save('LC 15',{title:'三数之和',text:'重试成功'});
  await save('LC 15',{title:'三数之和',text:''});assert.equal(store['manual-note:LC 15'].text,'');
  assert.throws(()=>noteStorageKey(''));
});
await test('重复打开同题聚焦已有窗口；换题创建独立窗口',async()=>{
  const api={runtime:{getURL:path=>'chrome-extension://test/'+path},windows:{
    getAll:async()=>[{id:9,tabs:[{url:'chrome-extension://test/src/notes.html?key=LC+15&title=旧标题'}]}],
    update:async(id,options)=>({id,...options}),create:async options=>options}};
  const existing=await openManualNotes(api,{number:'15',slug:'3sum',title:'15. 三数之和'});
  assert.deepEqual(existing,{id:9,focused:true});
  const created=await openManualNotes(api,{number:'3',slug:'longest-substring',title:'3. 无重复字符的最长子串'});
  assert.equal(created.type,'popup');
  assert.equal(new URL(created.url).searchParams.get('key'),'LC 3');
  assert.equal(new URL(created.url).searchParams.get('title'),'LC 3 · 无重复字符的最长子串');
});
await test('后台接收编辑器消息并在写入完成后确认；其他扩展不能写手记',async()=>{
  const worker=fs.readFileSync(new URL('../src/background.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
  const store={};let handler;
  const chrome={storage:{onChanged:{addListener(){}},local:{get:async()=>structuredClone(store),set:async data=>Object.assign(store,data)}},
    runtime:{id:'self',onMessage:{addListener(fn){handler=fn;}},onInstalled:{addListener(){}}},
    sidePanel:{setPanelBehavior:async()=>{}},onStartup:{addListener(){}},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener(){}}}};
  chrome.runtime.onStartup=chrome.onStartup;
  vm.runInNewContext(worker,{chrome,createNoteWriter,createNoteSynchronizer,console,setTimeout:()=>1,clearTimeout(){}});
  const message={type:'lc-coach:save-note',key:'LC 15',note:{title:'三数之和',text:'我写的'}};
  assert.equal(handler(message,{id:'other'},()=>{throw Error('不应确认');}),undefined);
  assert.equal(Object.keys(store).length,0);
  const response=await new Promise(resolve=>assert.equal(handler(message,{id:'self'},resolve),true));
  assert.equal(response.ok,true);assert.equal(store['manual-note:LC 15'].text,'我写的');
});

const source=fs.readFileSync(new URL('../src/notes.js',import.meta.url),'utf8')
  .replace(/^import .*;$/gm,'').replace(/init\(\)\.catch\([\s\S]*$/,'');
function editor(saved={}) {
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:true,events:{},classList:{toggle(){}},
    addEventListener(type,fn){this.events[type]=fn;}});return elements.get(id);};
  const store=structuredClone(saved),writes=[];
  const save=createNoteWriter({set:async data=>Object.assign(store,data)});
  const ctx=vm.createContext({noteStorageKey,manualNoteTarget,NOTE_SYNC_STATE,URLSearchParams,location:{search:'?key=LC+15&title=LC+15'},
    document:{getElementById:el,addEventListener(){}},navigator:{clipboard:{writeText:async()=>{}}},
    chrome:{storage:{onChanged:{addListener(){}},local:{get:async keys=>Object.fromEntries(keys.map(key=>[key,store[key]]))}},runtime:{sendMessage:async message=>{
      if(message.type==='lc-coach:sync-notes')return {ok:true};
      writes.push(message);const note=await save(message.key,message.note);return {ok:true,note};}}}});
  vm.runInContext(source,ctx);
  return {el,store,writes,ctx,run:code=>vm.runInContext(code,ctx)};
}
await test('桥不可用时仍保存本机，重开恢复；不冒称已写入文件',async()=>{
  const h=editor({'manual-note:LC 15':{text:'自己的推理'}});await h.run('init()');
  assert.equal(h.el('note-text').value,'自己的推理');assert.equal(h.el('note-text').disabled,false);
  h.el('note-text').value='自己的新推理';await h.run('save()');
  assert.equal(h.store['manual-note:LC 15'].text,'自己的新推理');
  assert.match(h.el('note-status').textContent,/已保存/);
  assert.match(h.el('note-status').textContent,/文件待同步/);
  const reopened=editor(h.store);await reopened.run('init()');assert.equal(reopened.el('note-text').value,'自己的新推理');
});
await test('失败保留编辑内容，保存按钮重试；旧请求不能覆盖新状态',async()=>{
  const h=editor();await h.run('init()');h.el('note-text').value='不能丢失';
  h.ctx.chrome.runtime.sendMessage=async()=>({ok:false,error:'quota'});await h.run('save()');
  assert.match(h.el('note-status').textContent,/未保存/);assert.equal(h.el('note-text').value,'不能丢失');
  let firstResolve;
  h.ctx.chrome.runtime.sendMessage=()=>new Promise(resolve=>{firstResolve=resolve;});
  const first=h.run('save()');
  h.ctx.chrome.runtime.sendMessage=async()=>({ok:true,note:{text:'不能丢失'}});await h.run('save()');
  firstResolve({ok:false,error:'old failure'});await first;assert.match(h.el('note-status').textContent,/已保存/);
});
console.log(`通过 ${passed} 项手记测试`);
