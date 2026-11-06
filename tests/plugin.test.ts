import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

for(const debounceFiresWhileBusy of [true,false])test(`edit during sync queues another pass when debounce fires ${debounceFiresWhileBusy?'before':'after'} completion`,async()=>{
  const timers=new Map<number,()=>void>();let timerId=0;
  const windowMock={setTimeout:(callback:()=>void)=>{timers.set(++timerId,callback);return timerId;},clearTimeout:(id:number)=>{timers.delete(id);}};
  const module={exports:{} as any};
  new Function('require','module','exports','window','document','navigator','crypto',readFileSync('main.js','utf8'))(
    ()=>({Plugin:class{async saveData(){}},PluginSettingTab:class{},Notice:class{}}),module,module.exports,windowMock,{hidden:false},{onLine:true},{randomUUID});
  const p=new module.exports.default();
  p.config={bucket:'test-bucket',region:'cn-hangzhou',space:'notes',accessKeyId:'test',secret:'test-secret',automatic:true};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let passes=0;
  p.remote={revisions:async()=>{passes++;if(passes===1)await gate;return [];}};
  p.local={paths:async()=>[]};
  const runTimer=()=>{const [id,callback]=[...timers][0];timers.delete(id);callback();};
  const running=p.sync(false);
  p.schedule();
  if(debounceFiresWhileBusy)runTimer();
  release();await running;
  assert.equal(timers.size,1,'an edit must retain one debounced follow-up');
  runTimer();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(passes,2,'follow-up must not be blocked by the idle 60-second due time');
  assert.equal(p.busy,false);
  assert.equal(timers.size,0,'a completed idle follow-up must not self-schedule forever');
});

// Load the shipped CommonJS bundle against a small Obsidian API simulator.
// This checks host wiring and vault writes, not just the pure sync planner.
test('compiled plugin configures, uploads, downloads, and archives an overwritten Markdown note',async()=>{
  const cloud=new Map<string,Uint8Array>(), notices:string[]=[];
  class TFile{stat={mtime:1,ctime:1,size:0};extension:string;constructor(public path:string,public data:Uint8Array){this.extension=path.split('.').pop()!;this.stat.size=data.length;}}
  class MarkdownView{}
  const element=()=>({setText(){},setAttribute(){},addEventListener(){}});
  class Plugin{
    app:any;saved:any;
    async loadData(){return this.saved;}async saveData(d:any){this.saved=structuredClone(d);}
    addStatusBarItem(){return element();}addRibbonIcon(){return element();}addCommand(){}addSettingTab(){}registerEvent(){}registerDomEvent(){}registerInterval(){}
  }
  const transport=async(o:any)=>{
    const u=new URL(o.url),key=decodeURIComponent(u.pathname.slice(1));let status=200;let data:Uint8Array=new Uint8Array();
    if(o.method==='PUT'){
      if(cloud.has(key)&&o.headers['x-oss-forbid-overwrite']==='true')status=409;else cloud.set(key,new Uint8Array(o.body));
    }else if(u.searchParams.has('list-type')){
      const list=[...cloud.entries()].filter(([k])=>k.startsWith(u.searchParams.get('prefix')!)).map(([k,b])=>`<Contents><Key>${k}</Key><ETag>fixed</ETag><Size>${b.length}</Size></Contents>`).join('');
      data=new TextEncoder().encode(`<ListBucketResult>${list}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }else if(cloud.has(key))data=cloud.get(key)!;else status=404;
    return {status,headers:{},arrayBuffer:data.slice().buffer,text:new TextDecoder().decode(data)};
  };
  const module={exports:{} as any};
  const load=new Function('require','module','exports','window','document','navigator','crypto',readFileSync('main.js','utf8'));
  load((name:string)=>{assert.equal(name,'obsidian');return {Plugin,TFile,MarkdownView,PluginSettingTab:class{},Setting:class{},Notice:class{constructor(m:string){notices.push(m);}},requestUrl:transport};},module,module.exports,{setTimeout:()=>1,clearTimeout(){},setInterval:()=>1},{hidden:false},{onLine:true},{randomUUID});
  const PluginClass=module.exports.default;
  const device=async()=>{
    const files=new Map<string,TFile|{path:string}>();
    const app={workspace:{onLayoutReady(){},iterateAllLeaves(){}},vault:{
      getFiles:()=>[...files.values()].filter(f=>f instanceof TFile),getAbstractFileByPath:(p:string)=>files.get(p)||null,
      readBinary:async(f:TFile)=>f.data.slice().buffer,
      createFolder:async(p:string)=>{files.set(p,{path:p});},
      createBinary:async(p:string,b:ArrayBuffer)=>{if(files.has(p))throw new Error('exists');const f=new TFile(p,new Uint8Array(b));files.set(p,f);return f;},
      modifyBinary:async(f:TFile,b:ArrayBuffer)=>{f.data=new Uint8Array(b);f.stat.mtime++;f.stat.size=b.byteLength;},
      process:async(f:TFile,fn:(s:string)=>string)=>{const t=fn(new TextDecoder('utf8',{ignoreBOM:true}).decode(f.data));f.data=new TextEncoder().encode(t);f.stat.mtime++;f.stat.size=f.data.length;},
      trash:async(f:TFile)=>{files.delete(f.path);}
    }};
    const p=new PluginClass();p.app=app;await p.onload();
    await p.configure({bucket:'test-bucket',region:'cn-hangzhou',space:'notes',accessKeyId:'test',secret:'test-secret',automatic:true});
    return {p,files,app};
  };
  const a=await device(),b=await device();
  a.files.set('hello.md',new TFile('hello.md',new TextEncoder().encode('first')));
  await a.p.sync(true);await b.p.sync(true);
  assert.equal(new TextDecoder().decode((b.files.get('hello.md') as TFile).data),'first');
  await a.app.vault.modifyBinary(a.files.get('hello.md') as TFile,new TextEncoder().encode('second').buffer);
  await a.p.sync(true);await b.p.sync(true);
  assert.equal(new TextDecoder().decode((b.files.get('hello.md') as TFile).data),'second');
  assert.ok([...b.files.keys()].some(k=>k.startsWith('_云同步副本/hello~before-')));
  assert.ok(cloud.size>=5);
  assert.equal(a.p.saved.config.secret,'test-secret');
  assert.equal(a.p.summary().startsWith('已同步'),true);
  assert.equal(notices.some(n=>n.startsWith('云同步：')),false,notices.join('\n'));
  a.p.onunload();b.p.onunload();
});
