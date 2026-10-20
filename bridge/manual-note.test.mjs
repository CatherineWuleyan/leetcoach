// Real loopback bridge test. Uses only its own temporary Markdown file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'.local'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.local/manual-note-test-'));
const target=path.join(directory,'notes.md');
fs.writeFileSync(target,'# 自己的笔记\n\n不能丢失的段落\n');
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const token=crypto.randomBytes(24).toString('hex');
const child=spawn(process.execPath,[path.join(root,'bridge/server.mjs'),'--port',String(port),'--archive-only','--archive-path',target,'--quiet'],
  {env:{...process.env,LC_COACH_TOKEN:token},stdio:'ignore'});
const exit=once(child,'exit');
const base=`http://127.0.0.1:${port}`;
const headers={'Content-Type':'application/json','X-LC-Coach-Token':token};
const note={key:'LC 15',title:'LC 15 · 三数之和',text:'**我自己的话**\n\n- 保留原格式'};
const post=(endpoint,body,extra={})=>fetch(base+endpoint,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
try {
  let ready=false;
  for(let i=0;i<80;i++) {
    try {if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(ready,'测试桥必须启动成功');
  assert.equal((await (await fetch(base+'/health')).json()).capabilities.manualNotes,true);
  assert.equal((await post('/obsidian/manual-note',{path:target,note},{'X-LC-Coach-Token':'wrong'})).status,401);
  assert.equal((await post('/obsidian/manual-note',{path:target,note},{Origin:'https://example.invalid'})).status,403);
  assert.equal((await post('/obsidian/manual-note',{path:target+'.other.md',note})).status,400);
  assert.equal((await post('/obsidian/manual-note',{path:target,note:{...note,key:'bad\nkey'}})).status,400);
  assert.equal(fs.readFileSync(target,'utf8'),'# 自己的笔记\n\n不能丢失的段落\n');
  assert.equal((await post('/obsidian/manual-note',{path:target,note})).status,200);
  assert.equal((await (await post('/obsidian/manual-note',{path:target,note})).json()).changed,false);
  await Promise.all([
    post('/obsidian/upsert',{path:target,problem:{key:'LC 15',markdown:'### LC 15\n自动摘要'},syntax:[]}),
    post('/obsidian/manual-note',{path:target,note:{...note,text:'修改后的手记'}}),
    post('/obsidian/manual-note',{path:target,note:{key:'LC 3',title:'LC 3',text:'另一题的手记'}}),
  ]);
  const document=fs.readFileSync(target,'utf8');
  for(const text of ['不能丢失的段落','自动摘要','修改后的手记','另一题的手记','## 三、手记'])assert.ok(document.includes(text),text);
  assert.equal((document.match(/<!-- lc-coach:manual:LC 15 -->/g)||[]).length,1);
  await post('/obsidian/manual-note',{path:target,note:{...note,text:''}});
  const cleared=fs.readFileSync(target,'utf8');assert.ok(!cleared.includes('修改后的手记'));
  assert.ok(cleared.includes('自动摘要'));assert.ok(cleared.includes('另一题的手记'));
  console.log('手记 HTTP 实测通过：鉴权、Origin、目标限制、参数校验、原文保存、幂等、并发归档互不覆盖及清空同步。');
} finally {
  child.kill('SIGTERM');await exit;
  fs.rmSync(directory,{recursive:true,force:true});
}
