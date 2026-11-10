import {validateBackup} from './backup.js';
import {validateEvents} from './dates.js';
import {uuid,MAX_BYTES} from './shared-crypto.js';

export function canonical(value) {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const DEFAULT_PEOPLE = ['小獭','猫猫'];
export const displayPeople = people => people[0] === '我' && people[1] === '你' ? [...DEFAULT_PEOPLE] : people;
export const blankState = () => ({version:2,title:'两个人的小日子',people:[...DEFAULT_PEOPLE],anniversary:'',entries:[],events:[]});
export const blankDoc = space => ({format:'little-days-sync',version:1,space,clock:{},records:{}});
const dotId = dot => `${dot.actor}:${dot.seq}`;
const seen = (clock,dot) => (clock[dot.actor] || 0) >= dot.seq;
const id = '[a-zA-Z0-9-]{1,64}';
const validKey = new RegExp(`^(setting/(title|person0|person1|anniversary)|entry/${id}|event/${id}|comment/${id}/${id}|like/${id}/[01])$`);
function flatten(state) {
  const values = {'setting/title':state.title,'setting/person0':state.people[0],'setting/person1':state.people[1],'setting/anniversary':state.anniversary};
  for(const entry of state.entries) {
    const {comments,likes,updated,...content} = entry;
    // A comment/like does not count as an edit to the diary body.
    values[`entry/${entry.id}`] = content;
    for(const comment of comments) values[`comment/${entry.id}/${comment.id}`] = comment;
    for(const person of [0,1]) values[`like/${entry.id}/${person}`] = likes.includes(person);
  }
  for(const event of state.events) values[`event/${event.id}`] = event;
  return values;
}
function validateValue(key,value) {
  if(value === null) return;
  const [kind,recordId,extra] = key.split('/');
  const base = {...blankState(),format:'little-days-backup'};
  if(kind === 'entry') {
    if(value.id !== recordId || value.photos?.length) throw new Error('共享空间只接受文字日记。');
    validateBackup({...base,entries:[{...value,updated:value.created,comments:[],likes:[]}]});
  } else if(kind === 'event') {
    if(value.id !== recordId) throw new Error('日期标识不匹配。');
    validateEvents([value]);
  } else if(kind === 'comment') {
    if(value.id !== extra || ![0,1].includes(value.author) || typeof value.body !== 'string' || value.body.length > 2000 || !Number.isFinite(value.created) || value.created < 0) throw new Error('留言格式不正确。');
  } else if(kind === 'like') {
    if(typeof value !== 'boolean') throw new Error('喜欢标记格式不正确。');
  } else if(kind === 'setting') {
    const field = recordId;
    if(field.startsWith('person')) base.people[Number(field.at(-1))] = value;
    else base[field] = value;
    validateBackup(base);
  }
}
export function validateDoc(doc,space) {
  if(!doc || doc.format !== 'little-days-sync' || doc.version !== 1 || doc.space !== space || !uuid(space) || !doc.clock || !doc.records || Array.isArray(doc.clock) || Array.isArray(doc.records)) throw new Error('空间数据格式或恢复码不匹配。');
  const clock = Object.entries(doc.clock), records = Object.entries(doc.records);
  if(clock.length > 256 || records.length > 50000 || new TextEncoder().encode(JSON.stringify(doc)).length > MAX_BYTES) throw new Error('空间容量超出当前版本限制。');
  for(const [actor,seq] of clock) if(!uuid(actor) || !Number.isSafeInteger(seq) || seq < 1) throw new Error('版本时钟不正确。');
  const dots = new Set();
  for(const [key,versions] of records) {
    if(!validKey.test(key) || !Array.isArray(versions) || !versions.length || versions.length > 256) throw new Error('记录版本格式不正确。');
    for(const version of versions) {
      if(!version?.dot || !uuid(version.dot.actor) || !Number.isSafeInteger(version.dot.seq) || version.dot.seq < 1 || !seen(doc.clock,version.dot) || dots.has(dotId(version.dot))) throw new Error('记录版本标识不正确。');
      dots.add(dotId(version.dot)); validateValue(key,version.value);
    }
  }
  return doc;
}
export function setRecord(doc,key,value,actor) {
  if(!uuid(actor) || !validKey.test(key)) throw new Error('设备或记录标识不正确。');
  validateValue(key,value);
  const seq = (doc.clock[actor] || 0) + 1;
  if(!Number.isSafeInteger(seq)) throw new Error('设备版本计数超出限制。');
  doc.clock[actor] = seq;
  doc.records[key] = [{dot:{actor,seq},value:structuredClone(value)}];
}
export function changeState(doc,before,after,actor) {
  const previous = flatten(before), next = flatten(after), changed = structuredClone(doc);
  for(const key of new Set([...Object.keys(previous),...Object.keys(next)])) {
    const value = next[key] ?? null;
    if(canonical(previous[key] ?? null) === canonical(value)) continue;
    if((doc.records[key]?.length || 0) > 1) throw new Error('这条记录有并行修改，请先在「我们的空间」选择要保留的版本。');
    setRecord(changed,key,value,actor);
  }
  return validateDoc(changed,doc.space);
}
export function seedDoc(space,state,actor) {
  const doc = blankDoc(space);
  for(const [key,value] of Object.entries(flatten(state))) setRecord(doc,key,value,actor);
  return validateDoc(doc,space);
}
export function mergeDocs(left,right) {
  validateDoc(left,left.space); validateDoc(right,left.space);
  const merged = blankDoc(left.space);
  for(const actor of new Set([...Object.keys(left.clock),...Object.keys(right.clock)])) merged.clock[actor] = Math.max(left.clock[actor] || 0,right.clock[actor] || 0);
  for(const key of new Set([...Object.keys(left.records),...Object.keys(right.records)])) {
    const a = new Map((left.records[key] || []).map(v=>[dotId(v.dot),v]));
    const b = new Map((right.records[key] || []).map(v=>[dotId(v.dot),v]));
    const values = [];
    for(const [id,v] of a) {
      if(b.has(id)) {if(canonical(v) !== canonical(b.get(id))) throw new Error('相同版本包含不同内容，已停止同步。'); values.push(v);}
      else if(!seen(right.clock,v.dot)) values.push(v);
    }
    for(const [id,v] of b) if(!a.has(id) && !seen(left.clock,v.dot)) values.push(v);
    if(values.length) merged.records[key] = values.sort((a,b)=>dotId(a.dot).localeCompare(dotId(b.dot)));
  }
  return validateDoc(merged,left.space);
}
export function viewDoc(doc) {
  const state = blankState(), selected = {}, conflicts = [];
  for(const [key,versions] of Object.entries(doc.records)) {
    const sorted = [...versions].sort((a,b)=>dotId(a.dot).localeCompare(dotId(b.dot)));
    selected[key] = sorted[0].value;
    if(sorted.length > 1) conflicts.push({key,versions:sorted});
  }
  for(const [field,target] of [['title','title'],['anniversary','anniversary']]) if(selected[`setting/${field}`] != null) state[target] = selected[`setting/${field}`];
  for(const person of [0,1]) if(selected[`setting/person${person}`] != null) state.people[person] = selected[`setting/person${person}`];
  state.people = displayPeople(state.people);
  for(const [key,value] of Object.entries(selected)) {
    if(value === null) continue;
    if(key.startsWith('entry/')) {
      const entry = {...value,updated:value.created,comments:[],likes:[]};
      if(!entry.deleted) {
        entry.comments = Object.entries(selected).filter(([k,v])=>k.startsWith(`comment/${entry.id}/`) && v).map(([,v])=>v).sort((a,b)=>a.created-b.created || a.id.localeCompare(b.id));
        entry.likes = [0,1].filter(person=>selected[`like/${entry.id}/${person}`] === true);
      }
      state.entries.push(entry);
    } else if(key.startsWith('event/')) state.events.push(value);
  }
  return {state,conflicts};
}
