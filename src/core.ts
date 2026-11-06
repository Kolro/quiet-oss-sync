import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';

export const hash = (b: Uint8Array | string) => bytesToHex(sha256(b));
export const CONFLICT_DIR = '_云同步副本';
export const MAX_BYTES = 50 * 1024 * 1024;
export interface Revision {v:1; id:string; path:string; parents:string[]; hash:string|null; size:number; time:number}
export interface Base {hash:string|null; heads:string[]}
export interface State {v:1; target:string; bases:Record<string, Base>}
export interface Snapshot {data?:Uint8Array; hash:string; time:number; size?:number}
export interface Local {
  paths():Promise<string[]>;
  read(path:string,withData?:boolean):Promise<Snapshot|null>;
  apply(path:string, data:Uint8Array|null, expected:string|null):Promise<boolean>;
  archive(path:string, id:string, data:Uint8Array):Promise<void>;
}
export interface Remote {
  revisions():Promise<Revision[]>;
  content(digest:string):Promise<Uint8Array>;
  publish(rev:Revision, data:Uint8Array|null):Promise<void>;
}
export function safePath(path:string):boolean {
  if (!path || path.length>800 || path.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(path)) return false;
  return path.split('/').every(p=>p.length>0 && !p.startsWith('.') && !p.endsWith(' ') && !p.endsWith('.') && p!==CONFLICT_DIR && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p));
}
export function validateRevision(r:Revision):void {
  if (r?.v!==1 || !/^[a-f0-9]{32}$/.test(r.id) || !safePath(r.path) || !Array.isArray(r.parents) || r.parents.length>1000 || r.parents.some(p=>!(/^[a-f0-9]{32}$/).test(p)||p===r.id) || !(r.hash===null||/^[a-f0-9]{64}$/.test(r.hash)) || !Number.isSafeInteger(r.size) || r.size<0 || r.size>MAX_BYTES || !Number.isFinite(r.time)) throw new Error('云端同步记录格式异常，已停止以保护本地文件。');
}
export function heads(revs:Revision[]):Revision[] {
  const superseded=new Set(revs.flatMap(r=>r.parents));
  return revs.filter(r=>!superseded.has(r.id)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
const sameHeads=(a:string[],b:string[])=>a.slice().sort().join(',')===b.slice().sort().join(',');
export interface Report {uploaded:number; downloaded:number; deleted:number; conflicts:number; pending:number}

// Immutable revisions form a per-file causal graph. Concurrent writers cannot
// overwrite each other's commits; parent IDs, not device clocks, establish order.
export class Engine {
  constructor(public local:Local,public remote:Remote,public state:State,public save:()=>Promise<void>,public id:()=>string,public alive:()=>boolean=()=>true){}
  async sync():Promise<Report> {
    const out:Report={uploaded:0,downloaded:0,deleted:0,conflicts:0,pending:0};
    const all=await this.remote.revisions();
    const byPath=new Map<string,Revision[]>(), byId=new Map<string,Revision>();
    for(const r of all){validateRevision(r);if(byId.has(r.id))throw new Error('云端出现重复记录。');byId.set(r.id,r);const a=byPath.get(r.path)||[];a.push(r);byPath.set(r.path,a);}
    for(const r of all)for(const p of r.parents)if(!byId.has(p)||byId.get(p)!.path!==r.path)throw new Error('云端历史不完整，请勿清理同步目录；本次未继续同步。');
    // A missing historical commit must never be interpreted as a remote deletion.
    for(const b of Object.values(this.state.bases))for(const h of b.heads)if(!byId.has(h))throw new Error('云端记录缺失，已暂停。请检查是否更换或清空了存储目录。');
    const paths=[...new Set([...await this.local.paths(),...byPath.keys(),...Object.keys(this.state.bases)])].sort();
    const folded=new Map<string,string>();
    for(const p of paths){const key=p.normalize('NFC').toLowerCase();if(folded.has(key)&&folded.get(key)!==p)throw new Error(`文件名仅大小写或 Unicode 形式不同，无法安全跨端同步：${p}`);folded.set(key,p);}
    const visiting=new Set<string>(),visited=new Set<string>();
    for(const root of all){
      if(visited.has(root.id))continue;
      const stack:{revision:Revision;nextParent:number}[]=[{revision:root,nextParent:0}];
      visiting.add(root.id);
      while(stack.length){
        const frame=stack[stack.length-1];
        if(frame.nextParent===frame.revision.parents.length){visiting.delete(frame.revision.id);visited.add(frame.revision.id);stack.pop();continue;}
        const parent=frame.revision.parents[frame.nextParent++];
        if(visiting.has(parent))throw new Error('云端历史存在循环，已停止。');
        if(!visited.has(parent)){visiting.add(parent);stack.push({revision:byId.get(parent)!,nextParent:0});}
      }
    }
    for(const path of paths){
      if(!this.alive())break;
      if(!safePath(path))continue;
      let snapshot=await this.local.read(path), base=this.state.bases[path];
      const revs=byPath.get(path)||[];
      let localHash=snapshot?.hash??null;
      const changed=base ? localHash!==base.hash : snapshot!==null;
      const initialHeads=heads(revs);
      if(changed){
        // A first-device copy identical to the cloud does not create a new revision.
        const identical=!base && initialHeads.length>0 && initialHeads.every(r=>r.hash===localHash);
        if(!identical){
          if(snapshot&&!snapshot.data){snapshot=await this.local.read(path,true);localHash=snapshot?.hash??null;}
          if(snapshot&&!snapshot.data)throw new Error('无法读取待上传内容。');
          const r:Revision={v:1,id:this.id(),path,parents:base?.heads||[],hash:localHash,size:snapshot?.data?.length||0,time:snapshot?.time||Date.now()};
          await this.remote.publish(r,snapshot?.data??null);
          revs.push(r);out.uploaded++;
          // Save the exact uploaded snapshot, even if a user edited during upload.
          base={hash:localHash,heads:[r.id]};this.state.bases[path]=base;await this.save();
        }
      }
      const current=heads(revs);
      if(!current.length){if(revs.length)throw new Error('云端历史存在循环，已停止。');continue;}
      const ids=current.map(r=>r.id);
      // Prefer a live version over concurrent deletion; differing live versions
      // are retained locally before any replacement is attempted.
      const live=current.filter(r=>r.hash!==null);
      const winner=live[live.length-1]||current[current.length-1];
      const values=new Set(current.map(r=>r.hash));
      const newConflict=values.size>1 && (!base||!sameHeads(base.heads,ids));
      if(newConflict){
        for(const r of live){const data=await this.remote.content(r.hash!);if(hash(data)!==r.hash)throw new Error('下载内容校验失败。');await this.local.archive(path,r.id,data);}
        out.conflicts++;
      }
      if(winner.hash!==localHash){
        let bytes:Uint8Array|null=null;
        if(winner.hash){bytes=await this.remote.content(winner.hash);if(hash(bytes)!==winner.hash||bytes.length!==winner.size)throw new Error('下载内容校验失败。');}
        if(!this.alive())break;
        if(!await this.local.apply(path,bytes,localHash)){out.pending++;continue;}
        if(bytes)out.downloaded++;else out.deleted++;
      }else{
        // Do not acknowledge unseen edits made while a network operation ran.
        if((await this.local.read(path))?.hash!==snapshot?.hash){out.pending++;continue;}
      }
      if(!base||base.hash!==winner.hash||!sameHeads(base.heads,ids)){this.state.bases[path]={hash:winner.hash,heads:ids};await this.save();}
    }
    return out;
  }
}
