// Read-only/no-change live checks against the locally configured archive bridge.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const cfg=JSON.parse(fs.readFileSync(new URL('../.local/connection.json',import.meta.url),'utf8'));
const headers={'Content-Type':'application/json','X-LC-Coach-Token':cfg.token};
const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(cfg.archivePath)).digest('hex');
const before=digest();
assert.equal((await fetch(cfg.url+'/models')).status,401);
assert.equal((await fetch(cfg.url+'/models',{headers})).status,200);
assert.equal((await fetch(cfg.url+'/models',{headers:{...headers,Origin:'https://example.invalid'}})).status,403);
assert.equal((await fetch(cfg.url+'/chat',{method:'POST',headers,body:'{}'})).status,403);
assert.equal((await fetch(cfg.url+'/obsidian/upsert',{method:'POST',headers,body:JSON.stringify({path:cfg.archivePath+'.other.md'})})).status,400);
const status=await (await fetch(cfg.url+'/obsidian/status?path='+encodeURIComponent(cfg.archivePath),{headers})).json();
assert.equal(status.writable,true);
const result=await (await fetch(cfg.url+'/obsidian/upsert',{method:'POST',headers,body:JSON.stringify({path:cfg.archivePath,problem:null,syntax:[]})})).json();
assert.equal(result.changed,false);
assert.equal(digest(),before);
console.log('8 项本地桥实测通过：鉴权、Origin、归档专用模式、目标文件限制、可写性及原内容保留。');
