import {hmac} from '@noble/hashes/hmac';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex,utf8ToBytes} from '@noble/hashes/utils';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {hash,MAX_BYTES,Remote,Revision,validateRevision} from './core';

export interface Config {bucket:string;region:string;space:string;accessKeyId:string;secret:string;automatic:boolean}
export interface Response {status:number;headers:Record<string,string>;arrayBuffer:ArrayBuffer;text:string}
export type Transport=(o:{url:string;method:string;headers:Record<string,string>;body?:ArrayBuffer;throw:false})=>Promise<Response>;
const enc=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function sign(c:Config,method:string,key:string,query:Record<string,string>,extra:Record<string,string>,date=new Date()){
  const stamp=date.toISOString().replace(/[:-]|\.\d{3}/g,'');
  const headers:Record<string,string>={...extra,'x-oss-date':stamp,'x-oss-content-sha256':'UNSIGNED-PAYLOAD'};
  const canonicalHeaders=Object.keys(headers).sort().map(k=>`${k.toLowerCase()}:${headers[k].trim()}\n`).join('');
  const qs=Object.keys(query).map(k=>[enc(k),enc(query[k])]).sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>`${k}=${v}`).join('&');
  const uri=('/'+c.bucket+'/'+key).split('/').map(enc).join('/');
  const canonical=[method,uri,qs,canonicalHeaders,'','UNSIGNED-PAYLOAD'].join('\n');
  const scope=`${stamp.slice(0,8)}/${c.region}/oss/aliyun_v4_request`;
  let signingKey:Uint8Array=utf8ToBytes('aliyun_v4'+c.secret);
  for(const value of [stamp.slice(0,8),c.region,'oss','aliyun_v4_request'])signingKey=hmac(sha256,signingKey,value);
  const signature=bytesToHex(hmac(sha256,signingKey,`OSS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`));
  headers.Authorization=`OSS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, Signature=${signature}`;
  return {headers,url:`https://${c.bucket}.oss-${c.region}.aliyuncs.com/${key.split('/').map(enc).join('/')}${qs?'?'+qs:''}`,canonical};
}
export function validateConfig(c:Config){
  if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket))throw new Error('请填写正确的 Bucket 名称。');
  if(!/^[a-z]{2}-[a-z0-9-]+$/.test(c.region)||c.region.startsWith('oss-'))throw new Error('地域请填 cn-hangzhou 这样的格式，不要加 oss-。');
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(c.space))throw new Error('同步空间名仅支持字母、数字、下划线和短横线。');
  if(!c.accessKeyId.trim()||!c.secret.trim())throw new Error('请填写 RAM 用户的 AccessKey ID 和 Secret。');
}
export class OssRemote implements Remote {
  readonly prefix:string;
  private cache=new Map<string,{etag:string;rev:Revision}>();
  constructor(public config:Config,private transport:Transport){validateConfig(config);this.prefix=`quiet-sync/v1/${config.space}/`;}
  private async request(method:string,key:string,query:Record<string,string>={},data?:Uint8Array,immutable=false){
    const extra:Record<string,string>={};
    if(data)extra['content-type']='application/octet-stream';
    if(immutable)extra['x-oss-forbid-overwrite']='true';
    const s=sign(this.config,method,key,query,extra);
    let r:Response;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{r=await Promise.race([this.transport({url:s.url,method,headers:s.headers,body:data?data.slice().buffer as ArrayBuffer:undefined,throw:false}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),30000);})]);}
    catch{throw new Error('连接中断，修改已保存在本地，稍后会重试。');}
    finally{if(timer)clearTimeout(timer);}
    if(r.status<200||r.status>=300){
      if(immutable&&r.status===409)return r;
      const code=/<Code>([A-Za-z0-9]+)<\/Code>/.exec(r.text)?.[1]||'';
      const tips=r.status===403?'请检查密钥、RAM 权限和设备时间。':r.status===404?'请检查 Bucket、地域及云端记录是否完整。':r.status===429||r.status>=500?'服务暂时不可用，稍后重试。':'请检查网络和 OSS 配置。';
      throw new Error(`OSS ${r.status}${code?' · '+code:''}：${tips}`);
    }
    return r;
  }
  async revisions():Promise<Revision[]>{
    const parser=new XMLParser({ignoreAttributes:true,parseTagValue:false,processEntities:true,isArray:(name)=>name==='Contents'});
    const entries:{key:string;etag:string}[]=[];
    let token='';const tokens=new Set<string>();
    do{
      const q:Record<string,string>={'list-type':'2',prefix:this.prefix+'revisions/','max-keys':'1000'};
      if(token)q['continuation-token']=token;
      const r=await this.request('GET','',q);
      if(r.text.includes('<!DOCTYPE')||XMLValidator.validate(r.text)!==true)throw new Error('云端文件列表格式异常。');
      const list=parser.parse(r.text).ListBucketResult;
      if(!list)throw new Error('云端返回了无效文件列表。');
      for(const e of list.Contents||[]){
        if(!new RegExp('^'+this.prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'revisions/[a-f0-9]{32}\\.json$').test(e.Key))throw new Error('同步目录含未知文件，请使用独立同步空间。');
        if(Number(e.Size)>1024*1024)throw new Error('云端记录过大。');
        entries.push({key:e.Key,etag:e.ETag});
      }
      token=list.IsTruncated==='true'?list.NextContinuationToken:'';
      if(list.IsTruncated==='true'&&(!token||tokens.has(token)))throw new Error('云端列表分页异常。');
      if(token)tokens.add(token);
    }while(token);
    const revs:Revision[]=[];
    for(const e of entries){
      const cached=this.cache.get(e.key);
      if(cached&&cached.etag!==e.etag)throw new Error('云端历史被修改，已停止同步。');
      if(cached){revs.push(cached.rev);continue;}
      const r=await this.request('GET',e.key);
      if(r.arrayBuffer.byteLength>1024*1024)throw new Error('云端记录过大。');
      const rev=JSON.parse(r.text) as Revision;validateRevision(rev);
      if(!e.key.endsWith('/'+rev.id+'.json'))throw new Error('云端记录标识不匹配。');
      this.cache.set(e.key,{etag:e.etag,rev});revs.push(rev);
    }
    return revs;
  }
  async content(digest:string){
    if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('无效内容标识。');
    const r=await this.request('GET',this.prefix+'blobs/'+digest);
    if(r.arrayBuffer.byteLength>MAX_BYTES)throw new Error('单个附件超过 50 MB。');
    const b=new Uint8Array(r.arrayBuffer);if(hash(b)!==digest)throw new Error('云端内容校验失败。');return b;
  }
  async publish(rev:Revision,data:Uint8Array|null){
    validateRevision(rev);
    if(data){if(hash(data)!==rev.hash||data.length!==rev.size)throw new Error('上传内容校验失败。');const r=await this.request('PUT',this.prefix+'blobs/'+rev.hash,{},data,true);if(r.status===409)await this.content(rev.hash!);}
    const bytes=utf8ToBytes(JSON.stringify(rev));
    const key=this.prefix+'revisions/'+rev.id+'.json';
    const r=await this.request('PUT',key,{},bytes,true);
    if(r.status===409){const existing=await this.request('GET',key);if(existing.text!==JSON.stringify(rev))throw new Error('同步记录标识冲突。');}
  }
  async check(){
    await this.revisions();
    // A fixed zero-byte probe validates write permission without touching notes.
    await this.request('PUT',this.prefix+'connection-check',{},new Uint8Array());
    await this.request('GET',this.prefix+'connection-check');
  }
}
