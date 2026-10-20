// Start the file writer in the background; no API key is stored here.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const local=path.join(root,'.local');
fs.mkdirSync(local,{recursive:true,mode:0o700});
const configPath=path.join(local,'connection.json');
const cfg=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{
  url:'http://127.0.0.1:8788',token:crypto.randomBytes(24).toString('hex'),
  archivePath:path.join(local,'leetcode hot 100.md'),
};
async function connected(){
  try{return (await fetch(cfg.url+'/models',{headers:{'X-LC-Coach-Token':cfg.token},signal:AbortSignal.timeout(1000)})).ok;}
  catch{return false;}
}
if(await connected()){
  console.log('归档桥已运行：'+cfg.url);
  const info=await(await fetch(cfg.url+'/models',{headers:{'X-LC-Coach-Token':cfg.token},signal:AbortSignal.timeout(1000)})).json();
  if(!info.capabilities?.manualNotes)console.warn('此桥版本较旧；手记写入文件需先重启归档桥。');
}else{
  const fd=fs.openSync(path.join(local,'bridge.log'),'a',0o600);
  const child=spawn(process.execPath,[path.join(root,'bridge/server.mjs'),'--archive-only','--archive-path',cfg.archivePath,
    '--port',new URL(cfg.url).port,'--quiet'],{cwd:root,detached:true,
      env:{...process.env,LC_COACH_TOKEN:cfg.token},stdio:['ignore',fd,fd]});
  child.unref();fs.closeSync(fd);
  let ready=false;
  for(let i=0;i<20;i++){
    if(await connected()){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  if(!ready)throw new Error('归档桥启动失败，请检查 .local/bridge.log（可能端口被占用）。');
  fs.writeFileSync(configPath,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
  console.log('归档桥已启动：'+cfg.url+'（仅写入 leetcode hot 100.md）');
}

console.log("归档文件："+cfg.archivePath);
