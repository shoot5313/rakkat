import {sealCompressed,unseal,fingerprint,MAX_DOCUMENT_BYTES} from './shared-crypto.js';
import {canonical,validateDoc} from './shared-model.js';

const PURPOSE='little-days/device/v1';
const recordPurpose=key=>`${PURPOSE}/record/${key}`;
const manifest=rows=>[...rows].sort(([a],[b])=>a.localeCompare(b)).map(([key,row])=>[key,row.envelope.iv]);
export class DeviceStore {
  constructor({idb=globalThis.indexedDB,locks=globalThis.navigator?.locks,name='little-days-shared-v1'}={}) {
    this.idb=idb;this.locks=locks;this.name=name;this.rows=new Map();this.cached=null;
  }
  async open() {
    if(!this.locks?.request)throw new Error('请使用较新版本的 iPhone Safari，以支持安全的本机多页面保存。');
    // Keep the database version/store so an open old tab cannot block an upgrade.
    const request=this.idb.open(this.name,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('data');
    this.db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    this.db.onversionchange=()=>this.db.close();return this;
  }
  async read() {
    const {packed,rows}=await new Promise((resolve,reject)=>{
      const tx=this.db.transaction('data'),store=tx.objectStore('data'),get=store.get('device');let packed,rows;
      get.onsuccess=()=>{
        packed=get.result;
        if(packed && packed.envelope.iv!==this.cached?.iv && packed.envelope.version===2){const all=store.getAll();all.onsuccess=()=>{rows=all.result.filter(row=>row?.kind==='rakkat-local-record');};}
      };
      tx.oncomplete=()=>resolve({packed,rows});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('本机读取中断。'));
    });
    if(!packed){this.cached=null;this.rows.clear();return null;}
    if(this.cached?.iv===packed.envelope.iv)return {key:packed.key,data:structuredClone(this.cached.data)};
    const decoded=await unseal(packed.envelope,packed.key,PURPOSE,{maxBytes:MAX_DOCUMENT_BYTES});
    let data;
    if(packed.envelope.version===1){data=decoded;this.rows.clear();}
    else {
      if(decoded?.format!=='rakkat-device'||decoded.version!==2||!decoded.doc||!Array.isArray(rows))throw new Error('本机记录格式不正确。');
      const next=new Map();
      for(const row of rows){if(typeof row.recordKey!=='string'||next.has(row.recordKey))throw new Error('本机记录索引重复。');next.set(row.recordKey,row);}
      if(await fingerprint(canonical(manifest(next)))!==decoded.recordManifest)throw new Error('本机记录不完整，请先保留现有数据并重新打开。');
      const records={};
      for(const [recordKey,row] of next) {
        const previous=this.rows.get(recordKey);
        row.versions=previous?.envelope.iv===row.envelope.iv?previous.versions:(await unseal(row.envelope,packed.key,recordPurpose(recordKey))).versions;
        records[recordKey]=row.versions;
      }
      const {format,version,recordManifest,...rest}=decoded;
      data={...rest,doc:validateDoc({...decoded.doc,records},decoded.doc.space)};this.rows=next;
    }
    this.cached={iv:packed.envelope.iv,data:structuredClone(data)};
    return {key:packed.key,data};
  }
  async save(key,data) {
    validateDoc(data.doc,data.doc.space);
    const next=new Map(),changed=[];
    for(const [recordKey,versions] of Object.entries(data.doc.records)) {
      let row=this.rows.get(recordKey);
      if(!row||canonical(row.versions)!==canonical(versions)) {
        const envelope=await sealCompressed({versions},key,recordPurpose(recordKey));
        row={kind:'rakkat-local-record',recordKey,envelope,versions:structuredClone(versions)};changed.push(row);
      }
      next.set(recordKey,row);
    }
    const {records,...header}=data.doc;
    const meta={...data,format:'rakkat-device',version:2,doc:header,recordManifest:await fingerprint(canonical(manifest(next)))};
    const envelope=await sealCompressed(meta,key,PURPOSE,{maxBytes:MAX_DOCUMENT_BYTES});
    await new Promise((resolve,reject)=>{
      const tx=this.db.transaction('data','readwrite'),store=tx.objectStore('data');
      const before=store.get('device');
      before.onsuccess=()=>{if(before.result?.envelope.version===1)store.put(before.result,'legacy-device-backup');};
      for(const row of changed){const {versions,...encrypted}=row;store.put(encrypted,'record/'+row.recordKey);}
      for(const recordKey of this.rows.keys())if(!next.has(recordKey))store.delete('record/'+recordKey);
      store.put({key,envelope},'device');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('本机保存中断。'));
    });
    this.rows=next;this.cached={iv:envelope.iv,data:structuredClone(data)};
  }
  async edit(callback) {
    return this.locks.request(`${this.name}/storage`,async()=>{
      const packed=await this.read();if(!packed)throw new Error('本机授权已清除，请重新加入空间。');
      const output=await callback(packed.data);await this.save(packed.key,packed.data);return output;
    });
  }
  async initialize(data) {
    return this.locks.request(`${this.name}/storage`,async()=>{
      if(await this.read())throw new Error('此设备已加入空间，请先退出后再操作。');
      const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await this.save(key,data);
    });
  }
  async clear() {
    return this.locks.request(`${this.name}/storage`,async()=>{
      await new Promise((resolve,reject)=>{const tx=this.db.transaction('data','readwrite');tx.objectStore('data').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
      this.rows.clear();this.cached=null;
    });
  }
}
