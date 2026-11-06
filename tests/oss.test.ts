import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Config,OssRemote,Response,sign,validateConfig} from '../src/oss';
import {hash,Revision} from '../src/core';
import {createHmac,createHash} from 'node:crypto';
const c:Config={bucket:'examplebucket',region:'cn-hangzhou',space:'test',accessKeyId:'test-id',secret:'test-secret',automatic:true};
const response=(text:string,status=200):Response=>({status,text,headers:{},arrayBuffer:new TextEncoder().encode(text).buffer});
test('OSS V4 signer matches independent Node crypto calculation',()=>{
  const r=sign(c,'GET','quiet-sync/中文.md',{'prefix':'a/b +','list-type':'2'},{},new Date('2026-11-06T01:02:03Z'));
  assert.equal(r.url,'https://examplebucket.oss-cn-hangzhou.aliyuncs.com/quiet-sync/%E4%B8%AD%E6%96%87.md?list-type=2&prefix=a%2Fb%20%2B');
  const canonical='GET\n/examplebucket/quiet-sync/%E4%B8%AD%E6%96%87.md\nlist-type=2&prefix=a%2Fb%20%2B\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20261106T010203Z\n\n\nUNSIGNED-PAYLOAD';
  assert.equal(r.canonical,canonical);
  let key:Buffer=Buffer.from('aliyun_v4test-secret');for(const p of ['20261106','cn-hangzhou','oss','aliyun_v4_request'])key=createHmac('sha256',key).update(p).digest();
  const expected=createHmac('sha256',key).update('OSS4-HMAC-SHA256\n20261106T010203Z\n20261106/cn-hangzhou/oss/aliyun_v4_request\n'+createHash('sha256').update(canonical).digest('hex')).digest('hex');
  assert.ok(r.headers.Authorization.endsWith('Signature='+expected));
});
test('official OSS canonical request example hashes to published digest',()=>{
  const canonical='PUT\n/examplebucket/exampleobject\n\ncontent-disposition:attachment\ncontent-length:3\ncontent-md5:ICy5YqxZB1uWSwcVLSNLcA==\ncontent-type:text/plain\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20250411T064124Z\n\ncontent-disposition;content-length\nUNSIGNED-PAYLOAD';
  assert.equal(hash(canonical),'c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca');
});
test('list pagination handles escaped tokens, caches immutable revision bodies',async()=>{
  const rev:Revision={v:1,id:'a'.repeat(32),path:'n.md',parents:[],hash:null,size:0,time:1};let fetches=0,pages=0;
  const remote=new OssRemote(c,async o=>{const u=new URL(o.url);if(u.pathname.endsWith('.json')){fetches++;return response(JSON.stringify(rev));}pages++;if(!u.searchParams.has('continuation-token'))return response(`<ListBucketResult><Contents><Key>quiet-sync/v1/test/revisions/${rev.id}.json</Key><ETag>e</ETag><Size>200</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken></ListBucketResult>`);assert.equal(u.searchParams.get('continuation-token'),'a&b');return response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');});
  assert.equal((await remote.revisions()).length,1);await remote.revisions();assert.equal(fetches,1);assert.equal(pages,4);
});
test('malformed listing and repeated page token fail closed',async()=>{
  await assert.rejects(new OssRemote(c,async()=>response('<oops>')).revisions(),/格式异常/);
  await assert.rejects(new OssRemote(c,async()=>response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>')).revisions(),/分页异常/);
});
test('HTTP failures return actionable messages without reflecting secrets',async()=>{
  const remote=new OssRemote(c,async()=>response('<Error><Code>AccessDenied</Code><Secret>test-secret</Secret></Error>',403));
  await assert.rejects(remote.revisions(),e=>e instanceof Error&&e.message.includes('AccessDenied')&&!e.message.includes('test-secret'));
});
test('invalid targets never reach network',()=>{assert.throws(()=>validateConfig({...c,region:'https://evil.com'}));assert.throws(()=>validateConfig({...c,bucket:'a.evil.com'}));assert.throws(()=>validateConfig({...c,space:'../other'}));});
test('publication writes blob before immutable revision',async()=>{const calls:string[]=[];const remote=new OssRemote(c,async o=>{calls.push(new URL(o.url).pathname);assert.equal(o.headers['x-oss-forbid-overwrite'],'true');return response('');});const d=new TextEncoder().encode('data');await remote.publish({v:1,id:'b'.repeat(32),path:'n.md',parents:[],hash:hash(d),size:d.length,time:1},d);assert.ok(calls[0].includes('/blobs/'));assert.ok(calls[1].includes('/revisions/'));});
