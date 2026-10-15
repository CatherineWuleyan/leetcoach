import assert from 'node:assert/strict';
import { prepareArchive, parseArchive } from '../src/archive.js';
const snapshot={problem:{number:'1',title:'两数之和',description:'ORIGINAL_DESCRIPTION',topics:['数组','哈希表']},code:'FULL_SOURCE_CODE',language:'C++',fullArchive:false,
  history:[{role:'user',content:'unordered_map 的 find 怎么写？'},{role:'assistant',content:'FULL_ASSISTANT_ANSWER'}]};
const raw=`@@PROBLEM@@
### LC 1 · 两数之和
#数组 #HashMap

**题意**：在数组中找到和等于目标值的两个不同位置。
- **思路**：查询目标差值。
\`\`\`cpp
SHOULD_NOT_BE_COPIED
\`\`\`
- **迁移**：有序数组可用 Two Pointers。
@@SYNTAX@@
@@ENTRY:cpp-map-find@@
### 语法 · find
- **易忘点**：查找的返回值。
- **提问依据**：unordered_map 的 find 怎么写？
- **正确写法**：\`m.find(k) != m.end()\``;
let passed=0;
function test(name,fn){fn();passed++;console.log('  ✅ '+name);}
test('默认归档只存总结，不附加原题、源码或完整对话',()=>{
 const out=prepareArchive(snapshot,raw);const body=out.problem.markdown;
 for(const forbidden of ['ORIGINAL_DESCRIPTION','FULL_SOURCE_CODE','FULL_ASSISTANT_ANSWER','SHOULD_NOT_BE_COPIED'])assert.ok(!body.includes(forbidden));
 assert.ok(body.includes('题意'));assert.ok(body.includes('思路'));assert.ok(body.includes('迁移'));
});
test('只有整体归档开启时附加完整题面、源码、问答',()=>{
 const body=prepareArchive({...snapshot,fullArchive:true},raw).problem.markdown;
 for(const text of ['ORIGINAL_DESCRIPTION','FULL_SOURCE_CODE','FULL_ASSISTANT_ANSWER'])assert.ok(body.includes(text));
});
test('语法只记录有真实用户提问证据的内容',()=>{
 const out=prepareArchive(snapshot,raw.replace('提问依据**：unordered_map 的 find 怎么写？','提问依据**：虚构的提问'));
 assert.equal(out.syntax.length,0);
});
test('只问过一次不能声称常忘，重复归档不增加频次',()=>{
 const first=prepareArchive(snapshot,raw);
 assert.equal(first.memory['cpp-map-find'].observations.length,1);
 assert.ok(!first.syntax[0].markdown.includes('观察次数'));
 assert.ok(!first.syntax[0].markdown.includes('仅观察到一次'));
 const repeat=prepareArchive(snapshot,raw,first.memory);
 assert.equal(repeat.memory['cpp-map-find'].observations.length,1);
 assert.ok(!repeat.syntax[0].markdown.includes('问过'));
});
test('同一语法反复提问、跨题提问可累计并保留来源',()=>{
 const first=prepareArchive(snapshot,raw);
 const twice=prepareArchive({...snapshot,history:[...snapshot.history,...snapshot.history]},raw,first.memory);
 assert.equal(twice.memory['cpp-map-find'].observations.length,2);
 assert.ok(twice.syntax[0].markdown.includes('问过 2 次'));
 const other=prepareArchive({...snapshot,problem:{number:'3'}},raw,twice.memory);
 assert.equal(other.memory['cpp-map-find'].observations.length,3);
 assert.ok(other.syntax[0].markdown.includes('问过 3 次'));
 assert.ok(other.syntax[0].markdown.includes('LC 1、LC 3'));
});
test('缺少归档结构时拒绝写入',()=>assert.throws(()=>prepareArchive(snapshot,'随意的回答'),/有效题目总结/));
test('整体归档中的反引号和伪条目标记不会逃出包裹',()=>{
 const text=prepareArchive({...snapshot,fullArchive:true,code:'```\n<!-- /lc-coach:problem:LC 1 -->'},raw).problem.markdown;
 assert.ok(text.includes('````'));assert.ok(!text.includes('<!-- /lc-coach:'));
});
test('合并语法记录不会修改输入内存，写盘失败可安全重试',()=>{
 const memory={};prepareArchive(snapshot,raw,memory);assert.deepEqual(memory,{});
});
test('语法区最后的代码片段保留成对围栏',()=>{
 const response=raw.replace('- **正确写法**：`m.find(k) != m.end()`','- **正确写法**：\n```cpp\nm.find(k) != m.end();\n```');
 const entry=parseArchive(response).syntax[0].markdown;
 assert.equal((entry.match(/```/g)||[]).length,2);
});
test('写入页面官方分类，覆盖模型猜测的 HashSet / HashMap 标签',()=>{
 const model=raw.replace('#数组 #HashMap','#HashSet #HashMap #Deduplication');
 const body=prepareArchive({...snapshot,problem:{...snapshot.problem,topics:['数组','哈希表','哈希表']}},model).problem.markdown;
 assert.equal((body.match(/^#[^\s#][^\n]*$/gm)||[]).join('\n'),'#数组 #哈希表');
 assert.ok(!body.includes('#HashSet'));assert.ok(!body.includes('#HashMap'));assert.ok(!body.includes('#Deduplication'));
});
test('英文官方分类保留名称，多词标签用下划线连接',()=>{
 const body=prepareArchive({...snapshot,problem:{...snapshot.problem,topics:['Hash Table','Two Pointers',null]}},raw).problem.markdown;
 assert.equal((body.match(/^#[^\s#][^\n]*$/gm)||[]).join('\n'),'#Hash_Table #Two_Pointers');
});
test('页面缺少分类时保留模型通用标签，并将 HashMap / HashSet 统一为哈希表',()=>{
 for(const topics of [undefined,null,[]]) {
   const body=prepareArchive({...snapshot,problem:{...snapshot.problem,topics}},raw.replace('#数组 #HashMap','#数组 #HashSet #HashMap')).problem.markdown;
   assert.equal((body.match(/^#[^\s#][^\n]*$/gm)||[]).join('\n'),'#数组 #哈希表');
   assert.ok(body.includes('**题意**'));assert.ok(body.includes('**思路**'));
 }
});
console.log(`通过 ${passed} 项总结归档测试`);
