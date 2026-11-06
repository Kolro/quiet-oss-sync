import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,hash,Local,Remote,Revision,Snapshot,State,safePath,validateRevision} from '../src/core';

const bytes=(s:string)=>new TextEncoder().encode(s);
let counter=0;const id=()=> (++counter).toString(16).padStart(32,'0');
class MemoryLocal implements Local {
  files=new Map<string,Uint8Array>();backups=new Map<string,Uint8Array>();block=false;
  set(p:string,s:string){this.files.set(p,bytes(s));}
  text(p:string){return this.files.has(p)?new TextDecoder().decode(this.files.get(p)):null;}
  async paths(){return [...this.files.keys()];}
  async read(p:string):Promise<Snapshot|null>{const d=this.files.get(p);return d?{data:d.slice(),hash:hash(d),time:1}:null;}
  async apply(p:string,d:Uint8Array|null,expected:string|null){if(this.block||(this.files.has(p)?hash(this.files.get(p)!):null)!==expected)return false;if(d)this.files.set(p,d.slice());else this.files.delete(p);return true;}
  async archive(p:string,i:string,d:Uint8Array){this.backups.set(p+i,d.slice());}
}
class MemoryRemote implements Remote {
  records:Revision[]=[];blobs=new Map<string,Uint8Array>();fail=false;afterPublish?:()=>void;
  async revisions(){return structuredClone(this.records);}
  async content(h:string){if(!this.blobs.has(h))throw new Error('missing blob');return this.blobs.get(h)!.slice();}
  async publish(r:Revision,d:Uint8Array|null){if(this.fail)throw new Error('offline');if(d)this.blobs.set(r.hash!,d.slice());this.records.push(structuredClone(r));this.afterPublish?.();}
}
function device(remote:Remote){const local=new MemoryLocal();const state:State={v:1,target:'test',bases:Object.create(null)};let saves=0;const engine=new Engine(local,remote,state,async()=>{saves++;},id);return {local,state,engine,get saves(){return saves;}};}
test('initial upload, another device downloads, and idle sync sends nothing',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('笔记/你好.md','你好');assert.equal((await a.engine.sync()).uploaded,1);assert.equal((await b.engine.sync()).downloaded,1);assert.equal(b.local.text('笔记/你好.md'),'你好');assert.deepEqual(await a.engine.sync(),{uploaded:0,downloaded:0,deleted:0,conflicts:0,pending:0});});
test('offline edits survive failure and are uploaded on retry',async()=>{const r=new MemoryRemote(),a=device(r);a.local.set('n.md','v1');r.fail=true;await assert.rejects(a.engine.sync(),/offline/);assert.equal(a.local.text('n.md'),'v1');assert.equal(a.state.bases['n.md'],undefined);r.fail=false;await a.engine.sync();assert.equal(r.records.length,1);});
test('concurrent offline edits preserve both versions and converge',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('n.md','base');await a.engine.sync();await b.engine.sync();a.local.set('n.md','A');b.local.set('n.md','B');await a.engine.sync();assert.equal((await b.engine.sync()).conflicts,1);await a.engine.sync();assert.equal(a.local.text('n.md'),b.local.text('n.md'));assert.deepEqual(new Set([...b.local.backups.values()].map(d=>new TextDecoder().decode(d))),new Set(['A','B']));b.local.set('n.md','merged');await b.engine.sync();await a.engine.sync();assert.equal(a.local.text('n.md'),'merged');});
test('concurrent creation with identical path never silently overwrites',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('n.md','A');b.local.set('n.md','B');await a.engine.sync();assert.equal((await b.engine.sync()).conflicts,1);assert.equal(b.local.backups.size,2);});
test('first join with identical files does not upload duplicate revision',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('n.md','A');b.local.set('n.md','A');await a.engine.sync();assert.equal((await b.engine.sync()).uploaded,0);assert.equal(r.records.length,1);});
test('deletion propagates only from an established baseline',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r),fresh=device(r);a.local.set('n.md','base');await a.engine.sync();await b.engine.sync();await fresh.engine.sync();assert.equal(fresh.local.text('n.md'),'base');a.local.files.delete('n.md');await a.engine.sync();assert.equal((await b.engine.sync()).deleted,1);assert.equal(b.local.text('n.md'),null);});
test('edit versus concurrent delete keeps live edited content',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('n.md','base');await a.engine.sync();await b.engine.sync();a.local.files.delete('n.md');b.local.set('n.md','important');await a.engine.sync();assert.equal((await b.engine.sync()).conflicts,1);await a.engine.sync();assert.equal(a.local.text('n.md'),'important');});
test('rename is an addition plus causal deletion',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('old.md','base');await a.engine.sync();await b.engine.sync();a.local.files.delete('old.md');a.local.set('new.md','base');await a.engine.sync();await b.engine.sync();assert.equal(b.local.text('old.md'),null);assert.equal(b.local.text('new.md'),'base');});
test('edits during upload are not incorrectly acknowledged',async()=>{const r=new MemoryRemote(),a=device(r);a.local.set('n.md','first');r.afterPublish=()=>{a.local.set('n.md','second');r.afterPublish=undefined;};assert.equal((await a.engine.sync()).pending,1);assert.equal(a.state.bases['n.md'].hash,hash('first'));await a.engine.sync();const b=device(r);await b.engine.sync();assert.equal(b.local.text('n.md'),'second');});
test('dirty editor defers remote overwrite until safely saved',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('n.md','old');await a.engine.sync();await b.engine.sync();a.local.set('n.md','remote');await a.engine.sync();b.local.block=true;assert.equal((await b.engine.sync()).pending,1);assert.equal(b.local.text('n.md'),'old');b.local.block=false;await b.engine.sync();assert.equal(b.local.text('n.md'),'remote');});
test('missing remote history pauses without erasing local data',async()=>{const r=new MemoryRemote(),a=device(r);a.local.set('n.md','keep');await a.engine.sync();r.records=[];await assert.rejects(a.engine.sync(),/记录缺失/);assert.equal(a.local.text('n.md'),'keep');});
test('corrupted downloaded blob does not overwrite local file',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('n.md','good');await a.engine.sync();r.blobs.set(hash('good'),bytes('bad'));await assert.rejects(b.engine.sync(),/校验失败/);assert.equal(b.local.text('n.md'),null);});
test('path traversal, hidden files, platform reserved names rejected',()=>{for(const p of ['../x','/x','a//b','.obsidian/data.json','a\\b','a/../b','CON.md','a.','a:b','_云同步副本/a.md'])assert.equal(safePath(p),false,p);assert.equal(safePath('学习/中文.md'),true);});
test('case-only conflicts stop before applying changes',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.set('Note.md','A');await a.engine.sync();b.local.set('note.md','B');await assert.rejects(b.engine.sync(),/大小写/);assert.equal(r.records.length,1);});
test('causal graph cycles and missing parents are rejected',async()=>{const r=new MemoryRemote(),a=device(r);const x=id(),y=id();r.records=[{v:1,id:x,path:'n.md',parents:[y],hash:null,size:0,time:1},{v:1,id:y,path:'n.md',parents:[x],hash:null,size:0,time:1}];await assert.rejects(a.engine.sync(),/循环/);r.records.pop();await assert.rejects(a.engine.sync(),/历史不完整/);});
test('a failed state persistence after upload does not lose the commit',async()=>{const r=new MemoryRemote(),a=device(r);a.local.set('n.md','safe');a.engine.save=async()=>{throw new Error('disk full');};await assert.rejects(a.engine.sync(),/disk full/);const recovered=device(r);recovered.local.set('n.md','safe');await recovered.engine.sync();assert.equal(r.records.length,1);assert.equal(recovered.local.text('n.md'),'safe');});
test('binary attachments and empty files round trip',async()=>{const r=new MemoryRemote(),a=device(r),b=device(r);a.local.files.set('image.png',new Uint8Array([0,255,128,1]));a.local.set('empty.md','');await a.engine.sync();await b.engine.sync();assert.deepEqual(b.local.files.get('image.png'),new Uint8Array([0,255,128,1]));assert.equal(b.local.text('empty.md'),'');});
test('oversize records are rejected',()=>{assert.throws(()=>validateRevision({v:1,id:id(),path:'x.pdf',parents:[],hash:hash('x'),size:51*1024*1024,time:1}));});
test('long history traverses newest-first without exhausting the call stack',async()=>{
  const remote=new MemoryRemote(),a=device(remote);let previous:string|undefined;
  for(let i=0;i<20000;i++){const next=id();remote.records.push({v:1,id:next,path:'long.md',parents:previous?[previous]:[],hash:null,size:0,time:i});previous=next;}
  remote.records.reverse();
  await a.engine.sync();
  assert.deepEqual(a.state.bases['long.md'].heads,[previous]);
  assert.equal(a.state.bases['long.md'].hash,null);
});
