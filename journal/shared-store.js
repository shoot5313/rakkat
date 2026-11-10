import {sealCompressed,unseal,parseRecovery,cloudPurpose,fingerprint,MAX_DOCUMENT_BYTES} from './shared-crypto.js';
import {seedDoc,blankState,validateDoc,changeState,mergeDocs,viewDoc,canonical,setRecord} from './shared-model.js';
import {VaultApi} from './shared-api.js';

export {DeviceStore} from './shared-device.js';
import {readCloud,prepareCloud} from './shared-cloud.js';
import {byteLength} from './shared-layout.js';

export class SharedJournal {
  constructor(store,{apiFactory=token=>new VaultApi(token),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
    this.store=store;this.apiFactory=apiFactory;this.wait=wait;this.blockedUntil=0;this.authFailed=false;
  }
  async snapshot() {
    const saved=(await this.store.read())?.data;
    if(!saved) return null;
    return {...viewDoc(saved.doc),storage:{textBytes:byteLength(saved.doc),cloudBytes:saved.cloudBytes||null,repositoryBytes:saved.repositoryBytes??null},active:saved.active,pending:await fingerprint(canonical(saved.doc))!==saved.ack,lastSync:saved.lastSync};
  }
  async setup({token,recovery,active,create=false,backup=null}) {
    if(![0,1].includes(active)) throw new Error('请选择自己的称呼。');
    const {space,key}=await parseRecovery(recovery),api=this.apiFactory(token);
    await api.verifyPrivate();const remote=await api.read();
    const actor=crypto.randomUUID();let doc,loaded=null;
    const restored=backup?validateDoc(await unseal(backup,key,cloudPurpose(space),{maxBytes:MAX_DOCUMENT_BYTES}),space):null;
    if(create) {
      if(remote) throw new Error('这个空间已经有记录。请选择「加入 / 恢复空间」，填写原来的恢复码。');
      doc=seedDoc(space,blankState(),actor);
    } else if(remote) {loaded=await readCloud(api,remote,key,space,{candidate:restored});doc=restored?mergeDocs(restored,loaded.doc):loaded.doc;}
    else if(restored) doc=restored;
    else throw new Error('云端还没有日记文件。若要从独立备份恢复，请选择备份文件后重试。');
    // Persist locally before any cloud write. Interrupted setup can resume safely.
    await this.store.initialize({id:crypto.randomUUID(),actor,token,recovery:recovery.trim(),active,doc,cloudCache:loaded?.cache||null,cloudBytes:loaded?.bytes||null,repositoryBytes:api.repositoryBytes??null,drafts:{},ack:loaded?await fingerprint(canonical(loaded.doc)):'',lastSync:remote?Date.now():0,allowCreate:!remote});
    return this.snapshot();
  }
  async mutate(update) {
    await this.store.edit(data=>{
      const before=viewDoc(data.doc).state,after=structuredClone(before);update(after);
      data.doc=changeState(data.doc,before,after,data.actor);
    });
    return this.snapshot();
  }
  async draft(key,next) {
    if(arguments.length===1) return (await this.store.read())?.data.drafts[key];
    await this.store.edit(data=>{data.drafts[key]=next;});
  }
  async setActive(active) {if(![0,1].includes(active)) throw new Error('身份不正确');await this.store.edit(data=>{data.active=active;});}
  async replaceToken(token) {
    await this.apiFactory(token).verifyPrivate();await this.store.edit(data=>{data.token=token;});this.blockedUntil=0;this.authFailed=false;
  }
  async recovery() {return (await this.store.read())?.data.recovery;}
  async exportBackup() {
    const data=(await this.store.read())?.data;if(!data) throw new Error('请先加入空间。');
    const {key,space}=await parseRecovery(data.recovery);return sealCompressed(data.doc,key,cloudPurpose(space),{maxBytes:MAX_DOCUMENT_BYTES});
  }
  async importBackup(envelope) {
    await this.store.edit(async data=>{
      const {key,space}=await parseRecovery(data.recovery);
      const incoming=validateDoc(await unseal(envelope,key,cloudPurpose(space),{maxBytes:MAX_DOCUMENT_BYTES}),space);
      data.doc=mergeDocs(data.doc,incoming);
    });return this.snapshot();
  }
  async resolve(key,expected,versionIndex) {
    await this.store.edit(data=>{
      const conflict=viewDoc(data.doc).conflicts.find(item=>item.key===key);
      if(!conflict || canonical(conflict.versions)!==expected || !conflict.versions[versionIndex]) throw new Error('版本已变化，请重新查看后选择。');
      setRecord(data.doc,key,conflict.versions[versionIndex].value,data.actor);
    });return this.snapshot();
  }
  async sync() {
    if(this.running) return this.running;
    if(this.authFailed) throw new Error('请先更新已失效的访问授权。');
    if(Date.now()<this.blockedUntil) throw new Error(`连接已暂停，请在 ${new Date(this.blockedUntil).toLocaleTimeString('zh-CN')} 后再试。`);
    this.running=this.store.locks.request(`${this.store.name}/network`,async()=>{
      for(let attempt=0;attempt<3;attempt++) {
        const saved=(await this.store.read())?.data;if(!saved) throw new Error('请先加入空间。');
        const api=this.apiFactory(saved.token),{space,key}=await parseRecovery(saved.recovery);
        await api.verifyPrivate();const remote=await api.read();
        if(!remote && !saved.allowCreate) throw new Error('云端日记文件已不存在，已暂停自动写入。请先导出本机备份，再检查仓库。');
        const loaded=await readCloud(api,remote,key,space,{candidate:saved.doc,cache:saved.cloudCache});
        const cloud=loaded?.doc||null;
        const merged=cloud?mergeDocs(saved.doc,cloud):saved.doc;
        const uploaded=canonical(merged);
        let cloudCache=loaded?.cache||null,cloudBytes=loaded?.bytes||null;
        if(!cloud || loaded.legacy || uploaded!==canonical(cloud)) {
          const prepared=await prepareCloud(merged,key,loaded,remote);
          try {await api.writeFiles(prepared.changes,remote);cloudCache=prepared.cache;cloudBytes=prepared.bytes;}
          catch(error) {if([409,422].includes(error.status) && attempt<2) {await this.wait(1200);continue;}throw error;}
        }
        const ack=await fingerprint(uploaded);
        await this.store.edit(data=>{
          if(data.id!==saved.id) throw new Error('设备授权已经变化，忽略之前的同步结果。');
          data.doc=mergeDocs(data.doc,merged);data.ack=ack;data.lastSync=Date.now();data.allowCreate=false;data.cloudCache=cloudCache;data.cloudBytes=cloudBytes;data.repositoryBytes=api.repositoryBytes??data.repositoryBytes??null;
        });return this.snapshot();
      }
    }).catch(error=>{
      if(error.retryAt) this.blockedUntil=error.retryAt;
      else if(error.status===401) this.authFailed=true;
      else this.blockedUntil=Date.now()+30000;
      throw error;
    }).finally(()=>{this.running=null;});
    return this.running;
  }
}
