import {canonical,validateDoc,blankDoc} from './shared-model.js';
import {fingerprint,MAX_BYTES} from './shared-crypto.js';

export const rootFormat='rakkat-root';
export const byteLength=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const entityId=key=>{
  const [kind,id]=key.split('/');
  return kind==='setting'?'settings':kind==='event'?`event/${id}`:`entry/${id}`;
};
export const validEntity=id=>id==='settings'||/^(entry|event)\/[a-zA-Z0-9-]{1,64}$/.test(id);
export const validBucket=bucket=>/^(settings|undated|\d{4}-(0[1-9]|1[0-2]))$/.test(bucket);
export const entityPath=id=>{
  if(!validEntity(id))throw new Error('记录索引格式不正确。');
  if(id==='settings')return 'journal/v2/settings.json';
  const [kind,value]=id.split('/');return `journal/v2/${kind}/${value.slice(0,2)}/${value}.json`;
};
export const monthPath=bucket=>{
  if(!validBucket(bucket))throw new Error('月份索引格式不正确。');
  return `journal/v2/months/${bucket}.json`;
};
export function entityBucket(entity) {
  if(entity.id==='settings')return 'settings';
  const primary=entity.records[entity.id];
  const value=primary?.slice().sort((a,b)=>`${a.dot.actor}:${a.dot.seq}`.localeCompare(`${b.dot.actor}:${b.dot.seq}`))[0]?.value;
  return (entity.id.startsWith('event/')?value?.start:value?.date)?.slice(0,7)||'undated';
}
export async function partitionDoc(doc) {
  validateDoc(doc,doc.space);
  const entities=new Map();
  for(const [key,versions] of Object.entries(doc.records)) {
    const id=entityId(key);
    if(!entities.has(id))entities.set(id,{format:'rakkat-record',version:2,space:doc.space,id,records:{}});
    entities.get(id).records[key]=versions;
  }
  const result=new Map();
  await Promise.all([...entities].map(async([id,payload])=>{
    const size=byteLength(payload);if(size>MAX_BYTES)throw new Error('单篇日记及留言过多，请先导出完整备份。');
    result.set(id,{payload,hash:await fingerprint(canonical(payload)),bucket:entityBucket(payload),plainBytes:size});
  }));
  return result;
}
export function assembleDoc(space,clock,entities) {
  const doc=blankDoc(space);doc.clock=clock;
  for(const entity of entities) {
    if(entity?.format!=='rakkat-record'||entity.version!==2||entity.space!==space||!validEntity(entity.id)||!entity.records||Array.isArray(entity.records))throw new Error('记录文件格式不正确。');
    for(const [key,versions] of Object.entries(entity.records)) {
      if(entityId(key)!==entity.id||Object.hasOwn(doc.records,key))throw new Error('记录索引重复或不匹配。');
      doc.records[key]=versions;
    }
  }
  return validateDoc(doc,space);
}
export function validDescriptor(value) {
  return value && /^[A-Za-z0-9+/]{43}=$/.test(value.hash) && Number.isSafeInteger(value.bytes) && value.bytes>0 && value.bytes<MAX_BYTES*1.5+4096;
}
export function validateRoot(root,space) {
  if(root?.format!==rootFormat||root.version!==2||root.space!==space||!root.clock||typeof root.clock!=='object'||Array.isArray(root.clock)||!root.months||Array.isArray(root.months)||Object.keys(root.months).length>5000)throw new Error('空间索引格式不正确。');
  for(const [bucket,descriptor] of Object.entries(root.months))if(!validBucket(bucket)||!validDescriptor(descriptor))throw new Error('月份索引格式不正确。');
  return root;
}
export function validateMonth(index,bucket,space) {
  if(index?.format!=='rakkat-month'||index.version!==2||index.space!==space||index.bucket!==bucket||!index.entities||Array.isArray(index.entities)||Object.keys(index.entities).length>50000)throw new Error('月份记录格式不正确。');
  for(const [id,descriptor] of Object.entries(index.entities))if(!validEntity(id)||!validDescriptor(descriptor))throw new Error('记录索引格式不正确。');
  return index;
}
