import {canonical,validateDoc} from './shared-model.js';
import {sealCompressed,unseal,cloudPurpose,fingerprint} from './shared-crypto.js';
import {rootFormat,byteLength,entityPath,monthPath,entityBucket,partitionDoc,assembleDoc,validateRoot,validateMonth} from './shared-layout.js';
import {DATA_PATH} from './shared-api.js';

const purpose=(space,part)=>`${cloudPurpose(space)}/${part}`;
async function mapLimited(items,run) {
  let next=0,failure;const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
    while(!failure && next<items.length){const index=next++;try{results[index]=await run(items[index]);}catch(error){failure=error;}}
  }));
  if(failure)throw failure;return results;
}
export async function readCloud(api,remote,key,space,{candidate=null,cache=null}={}) {
  if(!remote)return null;
  const decoded=await unseal(remote.envelope,key,cloudPurpose(space));
  if(decoded?.format==='little-days-sync')return {doc:validateDoc(decoded,space),legacy:true,cache:null,bytes:byteLength(remote.envelope)};
  const root=validateRoot(decoded,space),indices={},entities=[],seen=new Set();
  const local=candidate?await partitionDoc(candidate):new Map();
  let storedBytes=byteLength(remote.envelope);
  const months=await mapLimited(Object.entries(root.months),async([bucket,descriptor])=>{
    let index=cache?.indices?.[bucket];
    if(!index || await fingerprint(canonical(index))!==descriptor.hash) {
      const file=await api.readFile(monthPath(bucket),remote.head);
      index=await unseal(file.envelope,key,purpose(space,`month/${bucket}`));
      if(await fingerprint(canonical(index))!==descriptor.hash)throw new Error('月份索引校验失败，已停止同步。');
    }
    validateMonth(index,bucket,space);return {bucket,index,descriptor};
  });
  const jobs=[];
  for(const {bucket,index,descriptor} of months) {
    indices[bucket]=index;storedBytes+=descriptor.bytes;
    for(const [id,record] of Object.entries(index.entities)){
      if(seen.has(id)||seen.size>=200000)throw new Error('记录索引重复或过大，已停止同步。');seen.add(id);
      jobs.push({bucket,id,record});storedBytes+=record.bytes;
    }
  }
  const loadedEntities=await mapLimited(jobs,async({bucket,id,record})=>{
      const match=local.get(id);let entity=match?.hash===record.hash?match.payload:null;
      if(!entity) {
        const file=await api.readFile(entityPath(id),remote.head);
        entity=await unseal(file.envelope,key,purpose(space,`record/${id}`));
        if(await fingerprint(canonical(entity))!==record.hash)throw new Error('记录校验失败，已保留本机内容。');
      }
      if(entity.id!==id||entityBucket(entity)!==bucket)throw new Error('记录与月份不匹配。');
      return entity;
  });
  for(const entity of loadedEntities)entities.push(entity);
  const doc=assembleDoc(space,root.clock,entities);
  return {doc,legacy:false,cache:{indices},indexBytes:Object.fromEntries(Object.entries(root.months).map(([bucket,value])=>[bucket,value.bytes])),bytes:storedBytes};
}
export async function prepareCloud(doc,key,previous,remote) {
  const entities=await partitionDoc(doc),changes=[],indices={},previousEntities=new Map();
  for(const index of Object.values(previous?.cache?.indices||{}))for(const [id,descriptor] of Object.entries(index.entities))previousEntities.set(id,descriptor);
  let storedBytes=0;
  for(const [id,entity] of [...entities].sort(([a],[b])=>a.localeCompare(b))) {
    let descriptor=previousEntities.get(id);
    if(descriptor?.hash!==entity.hash) {
      const envelope=await sealCompressed(entity.payload,key,purpose(doc.space,`record/${id}`));
      descriptor={hash:entity.hash,bytes:byteLength(envelope)};changes.push({path:entityPath(id),envelope});
    }
    indices[entity.bucket]??={format:'rakkat-month',version:2,space:doc.space,bucket:entity.bucket,entities:{}};
    indices[entity.bucket].entities[id]=descriptor;storedBytes+=descriptor.bytes;
  }
  const root={format:rootFormat,version:2,space:doc.space,clock:doc.clock,months:{}};
  for(const [bucket,index] of Object.entries(indices)) {
    const hash=await fingerprint(canonical(index)),old=previous?.cache?.indices?.[bucket];
    let bytes;
    if(old && canonical(old)===canonical(index)) {
      // Index size is deterministic for its already stored envelope, available on read.
      bytes=previous.indexBytes?.[bucket];
    }
    if(!bytes) {
      const envelope=await sealCompressed(index,key,purpose(doc.space,`month/${bucket}`));
      bytes=byteLength(envelope);changes.push({path:monthPath(bucket),envelope});
    }
    root.months[bucket]={hash,bytes};storedBytes+=bytes;
  }
  for(const bucket of Object.keys(previous?.cache?.indices||{}))if(!indices[bucket])changes.push({path:monthPath(bucket),envelope:null});
  if(previous?.legacy && remote)changes.push({path:`journal/migrations/v1-${remote.sha}.json`,envelope:remote.envelope});
  const envelope=await sealCompressed(root,key,cloudPurpose(doc.space));
  changes.push({path:DATA_PATH,envelope});storedBytes+=byteLength(envelope);
  return {changes,cache:{indices},bytes:storedBytes};
}
