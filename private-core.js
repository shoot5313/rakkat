export const vault='shoot5313/little-days-vault';
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const aad=encoder.encode('little-days/private-connection-check/v1');
export function encode64(bytes) {return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));}
export function decode64(text) {
  if(typeof text!=='string' || text.length>32000) throw new Error('测试响应大小异常');
  return Uint8Array.from(atob(text.replace(/\s/g,'')),char=>char.charCodeAt(0));
}
export async function encryptSample(text,key,cryptoApi=globalThis.crypto) {
  const iv=cryptoApi.getRandomValues(new Uint8Array(12));
  const ciphertext=await cryptoApi.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,encoder.encode(text));
  return {version:1,algorithm:'AES-256-GCM',iv:encode64(iv),ciphertext:encode64(new Uint8Array(ciphertext))};
}
export async function decryptSample(envelope,key,cryptoApi=globalThis.crypto) {
  if(envelope?.version!==1 || envelope.algorithm!=='AES-256-GCM') throw new Error('测试密文格式不匹配');
  const iv=decode64(envelope.iv);
  if(iv.length!==12) throw new Error('测试密文参数不匹配');
  return decoder.decode(await cryptoApi.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,decode64(envelope.ciphertext)));
}
class ProbeError extends Error {constructor(message,limited=false){super(message);this.limited=limited;}}

export async function privateCheck(token,{fetchFn=globalThis.fetch,cryptoApi=globalThis.crypto,onProgress=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=12000}={}) {
  if(!/^github_pat_[A-Za-z0-9_]{20,255}$/.test(token)) return {ok:false,message:'请输入只授权 little-days-vault 的 Fine-grained token（以 github_pat_ 开头），不要输入密码或其他类型令牌。',cleanup:'未写入'};
  let uploadedSha=null,path=null,verified=false,problem=null,cleaned=false;
  async function request(method,suffix,body) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchFn(`https://api.github.com/repos/${vault}${suffix}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
      if(!response.ok) {
        if(response.status===429 || (response.status===403 && (response.headers.get('x-ratelimit-remaining')==='0' || response.headers.get('retry-after')))) throw new ProbeError('已收到 GitHub 限流响应，请停止测试，等待额度恢复后再试。',true);
        if(response.status===401) throw new ProbeError('令牌未被接受，可能填写错误、已失效或过期。');
        if(response.status===403 || response.status===404) throw new ProbeError('接口已连接，但没有此仓库的所需权限。请核对只选择 little-days-vault，并给予 Contents 读写权限。');
        throw new ProbeError(`GitHub 返回 HTTP ${response.status}，本次检查未完成。`);
      }
      return response.status===204?null:await response.json();
    } catch(error) {
      if(error instanceof ProbeError) throw error;
      if(controller.signal.aborted) throw new ProbeError('连接超时，本次检查未完成。');
      throw new ProbeError('网络请求或响应处理失败，本次检查未完成。');
    } finally {clearTimeout(timer);}
  }
  try {
    onProgress('privacy','正在确认私有权限…');
    const repository=await request('GET','');
    if(repository?.private!==true || repository.full_name?.toLowerCase()!==vault) throw new ProbeError('仓库不是预期的私有仓库，已停止，未上传测试数据。');
    onProgress('privacy','通过：私有仓库权限已确认');
    const id=cryptoApi.randomUUID();
    path=`.connectivity-checks/${id}.json`;
    const key=await cryptoApi.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const plaintext=JSON.stringify({kind:'fictional-connection-test',nonce:id,message:'这是一条虚构的连接测试文字。'});
    const envelope=await encryptSample(plaintext,key,cryptoApi);
    onProgress('write','正在写入虚构测试数据的密文…');
    const created=await request('PUT',`/contents/${path}`,{message:'Encrypted connection check',content:encode64(encoder.encode(JSON.stringify(envelope)))});
    const sha=created?.content?.sha;
    if(!/^[a-f0-9]{40,64}$/i.test(sha||'')) throw new ProbeError('写入响应缺少有效校验值，无法确认完成或安全清理。');
    uploadedSha=sha;onProgress('write','通过：已上传密文');
    onProgress('read','正在读回并解密校验…');
    const received=await request('GET',`/contents/${path}?check=${Date.now()}`);
    if(received?.type!=='file' || received.path!==path || received.sha!==sha || received.encoding!=='base64') throw new ProbeError('读回数据不匹配，未确认读写成功。');
    let restored;
    try {restored=await decryptSample(JSON.parse(decoder.decode(decode64(received.content))),key,cryptoApi);}
    catch {throw new ProbeError('密文无法通过解密校验，未确认读写成功。');}
    if(restored!==plaintext) throw new ProbeError('解密后的测试内容不匹配。');
    verified=true;onProgress('read','通过：读回内容与原文一致');
  } catch(error) {
    problem=error instanceof ProbeError?error:new ProbeError('本机加密或测试处理失败。');
  } finally {
    if(uploadedSha && !problem?.limited) {
      onProgress('cleanup','正在清理本次测试文件…');
      try {await wait(1100);await request('DELETE',`/contents/${path}`,{message:'Remove connection check file',sha:uploadedSha});cleaned=true;onProgress('cleanup','通过：当前分支的测试文件已清理');}
      catch {onProgress('cleanup','清理未完成，只可能留下虚构测试密文');}
    }
  }
  if(problem) return {ok:false,message:problem.message,cleanup:uploadedSha?(cleaned?'已清理':'可能留下虚构测试密文'):'未确认写入',readWriteVerified:verified};
  return {ok:verified && cleaned,message:verified && cleaned?'私有权限、加密写入、读取解密及清理均通过。当前网络已验证认证读写；正式日记、双人同步与密钥恢复尚未完成。':'读写已验证，但测试文件清理未完成，请保留结果。',cleanup:cleaned?'已清理':'可能留下虚构测试密文',readWriteVerified:verified};
}
