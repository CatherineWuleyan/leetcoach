import assert from 'node:assert/strict';
import {createNoteWriter,noteStorageKey} from '../src/manual-notes.js';
import {createNoteSynchronizer,manualNoteTarget} from '../src/note-sync.js';
import {upsertArchive,upsertManualNote} from '../bridge/obsidian.mjs';

const settings={bridge:{url:'http://127.0.0.1:8788',token:'test'},obsidian:{path:'/notes/leetcode hot 100.md'}};
function memory(saved={}) {
  const data=structuredClone(saved);
  return {data,get:async keys=>structuredClone(keys===null?data:Object.fromEntries(keys.map(key=>[key,data[key]]))),
    set:async values=>Object.assign(data,structuredClone(values))};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✅ '+name);}
await test('已有本机手记自动迁移到文件，原文保留且不产生重复条目',async()=>{
  const storage=memory({settings,'manual-note:LC 15':{title:'LC 15 · 三数之和',text:'自己写的 **推理**\n\n- 先检查条件'}});
  const writer=createNoteWriter(storage);let document='# 我的笔记\n\n保留原文\n',requests=0;
  const sync=createNoteSynchronizer(storage,writer,async(_url,options)=>{
    requests++;document=upsertManualNote(document,JSON.parse(options.body).note);return {ok:true,json:async()=>({ok:true})};
  });
  assert.equal((await sync()).pending,0);await sync();assert.equal(requests,1);
  assert.ok(document.includes('## 三、手记'));assert.ok(document.includes('自己写的 **推理**\n\n- 先检查条件'));
  assert.ok(document.includes('保留原文'));assert.equal((document.match(/<!-- lc-coach:manual:LC 15 -->/g)||[]).length,1);
});
await test('桥离线保留本机编辑，恢复后重试成功才标记文件已同步',async()=>{
  const storage=memory({settings}),writer=createNoteWriter(storage);let offline=true;
  await writer('LC 3',{title:'LC 3',text:'不能丢失'});
  const sync=createNoteSynchronizer(storage,writer,async()=>{
    if(offline)throw Error('offline');return {ok:true,json:async()=>({ok:true})};
  });
  const failed=await sync();assert.equal(failed.pending,1);assert.equal(failed.error,'offline');
  assert.equal(storage.data['manual-note:LC 3'].text,'不能丢失');assert.equal(storage.data['manual-note:LC 3'].syncedRevision,undefined);
  offline=false;assert.equal((await sync()).pending,0);
  const note=storage.data['manual-note:LC 3'];assert.equal(note.syncedRevision,note.revision);
});
await test('同步过程中继续编辑，旧响应不能把新内容误标为已写入或覆盖新文本',async()=>{
  const storage=memory({settings}),writer=createNoteWriter(storage);let release,document='';
  await writer('LC 15',{title:'LC 15',text:'旧内容'});
  const sync=createNoteSynchronizer(storage,writer,async(_url,options)=>{
    const note=JSON.parse(options.body).note;
    if(note.text==='旧内容')await new Promise(resolve=>{release=resolve;});
    document=upsertManualNote(document,note);return {ok:true,json:async()=>({ok:true})};
  });
  const first=sync();await new Promise(resolve=>setImmediate(resolve));
  await writer('LC 15',{title:'LC 15',text:'最新内容'});release();
  assert.equal((await first).pending,1);assert.equal(storage.data['manual-note:LC 15'].text,'最新内容');
  assert.equal((await sync()).pending,0);assert.ok(document.includes('最新内容'));assert.ok(!document.includes('旧内容'));
});
await test('自动总结更新、特殊标记和二级标题不会破坏手记或其他题目',()=>{
  let doc=upsertArchive('',{problem:{key:'LC 15',markdown:'### LC 15\n自动摘要'}});
  const note={key:'LC 15',title:'LC 15 · 三数之和',text:'## 我的说明\n<!-- /lc-coach:problem:LC 15 -->\n我的原话'};
  doc=upsertManualNote(doc,note);
  doc=upsertArchive(doc,{problem:{key:'LC 15',markdown:'### LC 15\n新摘要'},syntax:[{key:'python-dict',markdown:'语法保留'}]});
  assert.ok(doc.includes('新摘要'));assert.ok(doc.includes('我的原话'));assert.ok(doc.includes('语法保留'));
  assert.ok(doc.includes('&lt;!-- /lc-coach:problem:LC 15 -->'));
  assert.equal((doc.match(/<!-- \/lc-coach:problem:LC 15 -->/g)||[]).length,1);
  assert.equal(upsertManualNote(doc,note),doc);
  const cleared=upsertManualNote(doc,{...note,text:''});assert.ok(!cleared.includes('我的原话'));
  assert.ok(cleared.includes('新摘要'));assert.ok(cleared.includes('语法保留'));
  assert.throws(()=>upsertManualNote(doc,{...note,key:'LC 15\n破坏标记'}));
  assert.throws(()=>noteStorageKey('LC 15\n破坏标记'));
});
await test('归档路径变化后会重新写入新目标，旧桥或文件写入失败不冒称成功',async()=>{
  const storage=memory({settings}),writer=createNoteWriter(storage);const paths=[];let mode='ok';
  await writer('LC 5',{title:'LC 5',text:'原文'});
  const sync=createNoteSynchronizer(storage,writer,async(_url,options)=>{
    paths.push(JSON.parse(options.body).path);
    return mode==='old'?{status:404}:mode==='error'?{ok:false,status:500,json:async()=>({error:'disk full'})}:{ok:true,json:async()=>({ok:true})};
  });
  await sync();storage.data.settings.obsidian.path='/notes/new.md';mode='old';
  assert.match((await sync()).error,/需更新/);
  assert.notEqual(storage.data['manual-note:LC 5'].syncedTarget,manualNoteTarget(storage.data.settings));
  mode='error';assert.equal((await sync()).pending,1);
  mode='ok';assert.equal((await sync()).pending,0);assert.equal(paths.at(-1),'/notes/new.md');
});
console.log(`通过 ${passed} 项手记文件同步测试`);
