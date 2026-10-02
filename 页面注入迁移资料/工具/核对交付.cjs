const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve('页面注入迁移资料');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'源码清单.json'),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let checked=0,fixtureChecked=0;
for(const item of manifest.files){
 const copy=path.join(root,'源码快照',item.path);
 if(hash(fs.readFileSync(copy))!==item.sha256||hash(fs.readFileSync(item.source))!==item.sha256)throw Error('Hash mismatch '+item.path);
 checked++;
 if(item.path.startsWith('src/')||item.path.startsWith('resources/')){
  const fixture=path.join(root,'工具','离线测试工程',item.path);
  if(hash(fs.readFileSync(fixture))!==item.sha256)throw Error('Test fixture mismatch '+item.path);
  fixtureChecked++;
 }
 if(item.category==='core'||item.category==='test'||item.category==='test-fixture'){
  const source=fs.readFileSync(copy,'utf8');
  for(const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)){
   const base=path.resolve(path.dirname(copy),match[1]);
   if(!['','.ts','.js','.json'].some(ext=>fs.existsSync(base+ext)))throw Error('Missing import '+item.path+' '+match[1]);
  }
 }
}
const docs=fs.readdirSync(root).filter(name=>name.endsWith('.md'));
for(const name of docs){
 const body=fs.readFileSync(path.join(root,name),'utf8');let fence=null;
 for(const line of body.split(/\r?\n/)){
  const m=line.match(/^(`{3,}|~{3,})/);if(!m)continue;
  if(!fence)fence=m[1];else if(m[1][0]===fence[0]&&m[1].length>=fence.length)fence=null;
 }
 if(fence)throw Error('Open Markdown fence '+name);
 for(const link of body.matchAll(/\]\(\.\/([^\)]+)\)/g))if(!fs.existsSync(path.join(root,link[1])))throw Error('Missing doc link '+link[1]);
}
const tests=JSON.parse(fs.readFileSync(path.join(root,'离线测试结果.json'),'utf8'));
if(!tests.success||tests.numPassedTests!==45||tests.numFailedTests!==0)throw Error('Test result mismatch');
console.log(JSON.stringify({sourceFilesHashVerified:checked,testFixtureHashVerified:fixtureChecked,relativeCoreImports:'complete',markdownValidated:docs.length,offlineTestsPassed:tests.numPassedTests},null,2));