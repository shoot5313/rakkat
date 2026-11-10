const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
export const MAX_BYTES = 6 * 1024 * 1024;
export function base64(bytes) {
  let text = '';
  for(let offset=0;offset<bytes.length;offset+=8192) text += String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(text);
}
export function unbase64(value) {
  if(typeof value !== 'string' || value.length > MAX_BYTES * 2) throw new Error('文件过大或格式不正确。');
  return Uint8Array.from(atob(value.replace(/\s/g,'')),char=>char.charCodeAt(0));
}
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export async function importKey(raw) {
  if(raw.length !== 32) throw new Error('恢复码中的密钥长度不正确。');
  return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
export function newRecovery() {
  return `LD1.${crypto.randomUUID()}.${base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
export async function parseRecovery(code) {
  const parts = code.trim().split('.');
  if(parts.length !== 3 || parts[0] !== 'LD1' || !uuid(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw new Error('恢复码不完整，请复制完整的 LD1. 开头内容。');
  return {space:parts[1],key:await importKey(unbase64(parts[2].replace(/-/g,'+').replace(/_/g,'/')+'='))};
}
export async function seal(value,key,purpose) {
  const bytes = encoder.encode(JSON.stringify(value));
  if(bytes.length > MAX_BYTES) throw new Error('当前版本的单个空间上限为 6 MB，请先导出备份；本次内容没有上传。');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(purpose),tagLength:128},key,bytes);
  return {format:'little-days-encrypted',version:1,iv:base64(iv),ciphertext:base64(new Uint8Array(encrypted))};
}
export async function unseal(envelope,key,purpose) {
  try {
    if(envelope?.format !== 'little-days-encrypted' || envelope.version !== 1) throw new Error();
    const iv = unbase64(envelope.iv); if(iv.length !== 12) throw new Error();
    const value = await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(purpose),tagLength:128},key,unbase64(envelope.ciphertext));
    if(value.byteLength > MAX_BYTES) throw new Error();
    return JSON.parse(decoder.decode(value));
  } catch { throw new Error('无法解密或内容校验失败。请核对恢复码；没有覆盖现有记录。'); }
}
export const cloudPurpose = space => `little-days/journal/v1/${space}`;
export async function fingerprint(text) {return base64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))));}
