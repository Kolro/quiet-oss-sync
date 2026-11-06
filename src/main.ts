import {App,MarkdownView,Notice,Plugin,PluginSettingTab,Setting,TFile,requestUrl} from 'obsidian';
import {CONFLICT_DIR,Engine,hash,Local,MAX_BYTES,safePath,Snapshot,State} from './core';
import {Config,OssRemote,validateConfig} from './oss';

const defaults:Config={bucket:'',region:'cn-hangzhou',space:'my-notes',accessKeyId:'',secret:'',automatic:true};
const target=(c:Config)=>`${c.bucket}/${c.region}/${c.space}`;
const uuid=()=>crypto.randomUUID().replace(/-/g,'');
const buffer=(b:Uint8Array)=>b.slice().buffer as ArrayBuffer;

class VaultLocal implements Local {
  private cache=new Map<string,{mtime:number;ctime:number;size:number;hash:string}>();
  constructor(private app:App,private alive:()=>boolean){}
  invalidate(path:string){this.cache.delete(path);}
  private allowed(path:string){const config=this.app.vault.configDir||'.obsidian';return safePath(path)&&path!==config&&!path.startsWith(config+'/');}
  async paths(){return this.app.vault.getFiles().map(f=>f.path).filter(p=>this.allowed(p));}
  async read(path:string,withData=false):Promise<Snapshot|null>{
    if(!this.allowed(path))throw new Error('同步路径涉及配置或保留目录，已停止。');
    const f=this.app.vault.getAbstractFileByPath(path);
    if(!f){this.cache.delete(path);return null;}
    if(!(f instanceof TFile))throw new Error(`同名文件夹阻止同步：${path}`);
    if(f.stat.size>MAX_BYTES)throw new Error(`附件超过 50 MB，暂未同步：${path}`);
    const cached=this.cache.get(path);
    if(!withData&&cached&&cached.mtime===f.stat.mtime&&cached.ctime===f.stat.ctime&&cached.size===f.stat.size)return {hash:cached.hash,time:cached.mtime,size:cached.size};
    const stat={...f.stat};const data=new Uint8Array(await this.app.vault.readBinary(f));const digest=hash(data);
    if(stat.mtime===f.stat.mtime&&stat.size===f.stat.size)this.cache.set(path,{...stat,hash:digest});
    return {data,hash:digest,time:stat.mtime,size:data.length};
  }
  private async folders(path:string){
    const segments=path.split('/');segments.pop();let dir='';
    for(const part of segments){dir=dir?dir+'/'+part:part;const existing=this.app.vault.getAbstractFileByPath(dir);if(existing instanceof TFile)throw new Error(`文件与文件夹重名：${dir}`);if(!existing)await this.app.vault.createFolder(dir);}
  }
  async archive(path:string,id:string,data:Uint8Array){
    const dot=path.lastIndexOf('.'),slash=path.lastIndexOf('/');
    const stem=dot>slash?path.slice(0,dot):path,ext=dot>slash?path.slice(dot):'';
    let dest=`${CONFLICT_DIR}/${stem}~${id}${ext}`;
    const existing=this.app.vault.getAbstractFileByPath(dest);
    if(existing instanceof TFile){if(hash(new Uint8Array(await this.app.vault.readBinary(existing)))===hash(data))return;dest=`${CONFLICT_DIR}/${stem}~${id}-${uuid()}${ext}`;}
    await this.folders(dest);await this.app.vault.createBinary(dest,buffer(data));
  }
  private unsaved(path:string,expected:string|null){
    let dirty=false;
    this.app.workspace.iterateAllLeaves(leaf=>{if(leaf.view instanceof MarkdownView&&leaf.view.file?.path===path&&hash(leaf.view.editor.getValue())!==expected)dirty=true;});
    return dirty;
  }
  async apply(path:string,data:Uint8Array|null,expected:string|null):Promise<boolean>{
    if(!this.alive())return false;
    let current=await this.read(path,true);
    if((current?.hash??null)!==expected||this.unsaved(path,expected))return false;
    if(current?.data)await this.archive(path,'before-'+current.hash.slice(0,20),current.data);
    if(!this.alive())return false;
    current=await this.read(path,true);
    if((current?.hash??null)!==expected||this.unsaved(path,expected))return false;
    const f=this.app.vault.getAbstractFileByPath(path);
    if(data===null){if(f instanceof TFile)await this.app.vault.trash(f,false);return true;}
    if(!f){await this.folders(path);if(!this.alive()||this.app.vault.getAbstractFileByPath(path))return false;await this.app.vault.createBinary(path,buffer(data));return true;}
    if(!(f instanceof TFile))throw new Error(`存在同名文件夹：${path}`);
    if(f.extension==='md'){
      let applied=false;const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
      // Obsidian's atomic process API prevents stale downloads replacing a newer edit.
      await this.app.vault.process(f,old=>{if(this.alive()&&hash(old)===expected&&!this.unsaved(path,expected)){applied=true;return text;}return old;});
      return applied;
    }
    // Binary replacement is preceded by a recoverable copy and a fresh comparison.
    await this.app.vault.modifyBinary(f,buffer(data));return true;
  }
}

export default class QuietSync extends Plugin {
  config:Config={...defaults};
  state:State={v:1,target:'',bases:Object.create(null)};
  private remote?:OssRemote;
  private local!:VaultLocal;
  private busy=false;
  private rerun=false;
  private rerunManual=false;
  private stopped=false;
  private debounce?:number;
  private due=0;
  private errors=0;
  private lastNotice=0;
  private storage:Promise<unknown>=Promise.resolve();
  private status!:HTMLElement;
  private ribbon!:HTMLElement;
  private label='尚未配置';
  private detail='在设置中连接阿里云 OSS';

  async onload(){
    this.local=new VaultLocal(this.app,()=>!this.stopped);
    const saved=await this.loadData();
    if(saved?.config)this.config={...defaults,...saved.config};
    if(saved?.state){
      if(saved.state.v!==1||typeof saved.state.bases!=='object')throw new Error('同步状态格式异常，请保留 data.json 后检查。');
      this.state={...saved.state,bases:Object.assign(Object.create(null),saved.state.bases)};
    }
    this.status=this.addStatusBarItem();
    this.ribbon=this.addRibbonIcon('cloud-upload','立即同步',()=>this.schedule(true));
    this.status.addEventListener('click',()=>this.schedule(true));
    this.addCommand({id:'sync-now',name:'立即同步',callback:()=>this.schedule(true)});
    this.addCommand({id:'toggle-auto',name:'暂停 / 恢复自动同步',callback:async()=>{this.config.automatic=!this.config.automatic;await this.persist();this.paint(this.config.automatic?'等待同步':'已暂停');if(this.config.automatic)this.schedule();}});
    this.addSettingTab(new SyncSettings(this.app,this));
    this.paint(this.config.bucket?(this.config.automatic?'等待同步':'已暂停'):'尚未配置');
    this.app.workspace.onLayoutReady(()=>{
      if(this.stopped)return;
      for(const event of ['create','modify','delete','rename'] as const){
        this.registerEvent(this.app.vault.on(event as 'create',file=>{this.local.invalidate(file.path);if(safePath(file.path))this.schedule();}));
      }
      this.registerEvent(this.app.workspace.on('file-open',()=>this.schedule()));
      this.registerDomEvent(window,'focus',()=>this.schedule());
      this.registerDomEvent(window,'online',()=>{this.due=0;this.schedule();});
      this.registerDomEvent(document,'visibilitychange',()=>{if(!document.hidden)this.schedule();});
      this.registerInterval(window.setInterval(()=>{if(this.config.automatic&&!document.hidden&&Date.now()>=this.due)void this.sync(false);},15000));
      this.schedule();
    });
  }
  onunload(){this.stopped=true;if(this.debounce)window.clearTimeout(this.debounce);}
  persist(){
    const value=JSON.parse(JSON.stringify({config:this.config,state:this.state}));
    const next=this.storage.catch(()=>{}).then(()=>this.saveData(value));this.storage=next;return next;
  }
  paint(label:string,detail=''){
    this.label=label;this.detail=detail;
    this.status?.setText('☁ '+label);this.status?.setAttribute('title',detail||label);
    this.ribbon?.setAttribute('aria-label',`静默云同步：${label}。点击立即同步`);
  }
  summary(){return this.label+(this.detail?' · '+this.detail:'');}
  schedule(manual=false){
    if(this.stopped||(!manual&&!this.config.automatic))return;
    if(this.busy){this.rerun=true;this.rerunManual ||= manual;}
    if(!this.errors)this.due=0;
    if(this.debounce)window.clearTimeout(this.debounce);
    // Give Obsidian's own auto-save a moment to commit editor changes.
    this.debounce=window.setTimeout(()=>{this.debounce=undefined;void this.sync(manual,true);},manual?1200:4000);
  }
  private client(){
    if(!this.remote)this.remote=new OssRemote({...this.config},async o=>requestUrl(o));return this.remote;
  }
  async configure(c:Config){
    if(this.busy)throw new Error('正在同步，请完成后再修改设置。');
    validateConfig(c);
    if(Object.keys(this.state.bases).length&&this.state.target!==target(c))throw new Error('此仓库已绑定同步空间。为避免混合数据，请保持 Bucket、地域和空间名不变。');
    const remote=new OssRemote(c,async o=>requestUrl(o));
    this.busy=true;
    try{await remote.check();this.config={...c};this.remote=remote;this.state.target=target(c);await this.persist();this.due=0;this.paint(c.automatic?'已连接，等待同步':'已连接，自动同步暂停');}
    finally{this.busy=false;}
    this.schedule();
  }
  async sync(manual:boolean,requested=false){
    if(this.stopped||(!manual&&!this.config.automatic))return;
    if(this.busy){if(manual||requested){this.rerun=true;this.rerunManual ||= manual;}if(manual)new Notice('正在同步，请稍候。');return;}
    if(!this.config.bucket||!this.config.accessKeyId||!this.config.secret){if(manual)new Notice('请先在“静默云同步”设置中连接阿里云 OSS。');return;}
    if(!manual&&(document.hidden||Date.now()<this.due))return;
    if(!navigator.onLine){this.paint('离线，等待联网');if(manual)new Notice('当前离线，修改已保存在本地。');return;}
    this.rerun=false;this.rerunManual=false;
    this.busy=true;this.paint('同步中…');
    try{
      if(this.state.target&&this.state.target!==target(this.config))throw new Error('配置与本地同步状态不匹配。');
      this.state.target=target(this.config);
      const engine=new Engine(this.local,this.client(),this.state,()=>this.persist(),uuid,()=>!this.stopped);
      const r=await engine.sync();
      if(this.stopped)return;
      this.errors=0;this.due=Date.now()+60000;
      const description=`上传 ${r.uploaded}，下载 ${r.downloaded}，删除 ${r.deleted}，冲突 ${r.conflicts}`;
      this.paint(r.pending?'待本地编辑保存后同步':r.conflicts?'已同步，有冲突副本':'已同步',new Date().toLocaleTimeString()+' · '+description);
      if(r.conflicts)new Notice(`有 ${r.conflicts} 个文件同时被修改，所有版本已保存到“${CONFLICT_DIR}”。`,10000);
      else if(manual)new Notice(r.pending?'部分笔记正在编辑，将在保存后继续同步。':'同步完成 · '+description);
    }catch(error){
      this.errors++;this.due=Date.now()+Math.min(15*60000,15000*2**Math.min(this.errors,6));
      const message=error instanceof Error?error.message:'同步暂未完成，请检查设置。';
      this.paint('待重试',message);
      if(manual||Date.now()-this.lastNotice>5*60000){new Notice('云同步：'+message,10000);this.lastNotice=Date.now();}
    }finally{
      this.busy=false;
      if(this.rerun){const queuedManual=this.rerunManual;this.rerun=false;this.rerunManual=false;this.schedule(queuedManual);}
    }
  }
}

class SyncSettings extends PluginSettingTab {
  constructor(app:App,private plugin:QuietSync){super(app,plugin);}
  display(){
    const {containerEl}=this;containerEl.empty();containerEl.addClass('quiet-sync-settings');
    containerEl.createEl('h2',{text:'静默云同步'});
    containerEl.createEl('p',{text:'连接一次，之后自动同步。停笔约 4 秒上传；应用在前台时约每分钟检查另一台设备的修改。'});
    containerEl.createEl('p',{text:this.plugin.summary(),cls:'quiet-sync-status'});
    const draft={...this.plugin.config};
    const field=(key:'bucket'|'region'|'space'|'accessKeyId'|'secret',name:string,desc:string,placeholder:string)=>{
      new Setting(containerEl).setName(name).setDesc(desc).addText(t=>{t.setPlaceholder(placeholder).setValue(draft[key]).onChange(v=>{draft[key]=v.trim();});if(key==='secret')t.inputEl.type='password';t.inputEl.autocomplete='off';t.inputEl.spellcheck=false;});
    };
    field('bucket','Bucket 名称','使用专门的私有 Bucket。','my-obsidian-notes');
    field('region','所在地域','杭州填 cn-hangzhou；北京填 cn-beijing。无需填写网址。','cn-hangzhou');
    field('space','同步空间名','所有设备填相同名称；不同笔记仓库用不同名称。','my-notes');
    field('accessKeyId','AccessKey ID','使用仅有这个 Bucket 访问权限的 RAM 用户。','LTAI…');
    field('secret','AccessKey Secret','密钥仅存于本机插件 data.json；本版本未加密本地密钥，请勿分享此文件。','输入密钥');
    new Setting(containerEl).setName('自动同步').setDesc('关闭后仍可点击云朵按钮手动同步。').addToggle(t=>t.setValue(draft.automatic).onChange(v=>{draft.automatic=v;}));
    new Setting(containerEl).addButton(b=>b.setButtonText('连接并保存').setCta().onClick(async()=>{
      b.setDisabled(true).setButtonText('检查连接…');
      try{await this.plugin.configure(draft);new Notice('连接成功，配置已保存。');this.display();}
      catch(e){new Notice(e instanceof Error?e.message:'连接失败。',10000);b.setDisabled(false).setButtonText('连接并保存');}
    })).addButton(b=>b.setButtonText('立即同步').onClick(()=>this.plugin.schedule(true)));
    containerEl.createEl('h3',{text:'第一次使用'});
    const ol=containerEl.createEl('ol');
    for(const text of ['先备份现有仓库，暂停其他同步插件。','先在有完整笔记的设备连接，等第一次上传完成。','在另一台设备创建空仓库，安装本插件，填入相同的连接信息。'])ol.createEl('li',{text});
    containerEl.createEl('p',{text:'自动同步笔记、图片、PDF、Canvas 等普通文件；不上传隐藏目录、.obsidian 设置和“_云同步副本”。单个文件上限 50 MB。'});
    containerEl.createEl('p',{text:'并发修改会保留副本；远端删除会移入本地回收站。云端保留不可变历史，因此占用可能超过当前仓库大小；不要对同步目录配置过期删除规则。'});
    containerEl.createEl('p',{text:'手机应用退出或被系统暂停后不能继续同步，重新打开会补同步。使用 HTTPS 和私有 OSS 存储；本版本不含端到端加密。'});
  }
}
