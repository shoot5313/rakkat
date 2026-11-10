import {base64,unbase64,MAX_BYTES} from './shared-crypto.js';
export const REPOSITORY = 'shoot5313/little-days-vault';
export const DATA_PATH = 'journal/space-v1.json';
export const validToken = token => typeof token === 'string' && /^github_pat_[A-Za-z0-9_]{20,255}$/.test(token);
export class ApiError extends Error {
  constructor(message,status=0,retryAt=0,code='') {super(message);this.status=status;this.retryAt=retryAt;this.code=code;}
}
export class VaultApi {
  constructor(token,{fetchFn=globalThis.fetch,timeout=15000}={}) {
    if(!validToken(token)) throw new Error('访问令牌格式不正确，请粘贴已准备好的完整令牌。');
    // Native browser fetch requires a Window/Worker receiver, not a VaultApi instance.
    this.token=token;this.fetchFn=fetchFn.bind(globalThis);this.timeout=timeout;
  }
  async request(method,path,body,{missing=false,raw=false}={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeout);
    const step=method!=='GET'?{name:'保存记录',code:'C3'}:path?{name:'读取空间',code:'C2'}:{name:'确认访问权限',code:'C1'};
    let received=false;
    try {
      const response=await this.fetchFn(`https://api.github.com/repos/${REPOSITORY}${path}`,{
        method,headers:{Authorization:`Bearer ${this.token}`,Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},
        body:body?JSON.stringify(body):undefined,signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'
      });
      received=true;
      if(missing && response.status===404) return null;
      if(!response.ok) {
        if(response.status===429 || response.status===403) {
          const reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
          const retry=response.headers.get('retry-after');
          const retryAt=Math.max(Date.now()+60000,Number.isFinite(reset)?reset:0,retry && Number.isFinite(Number(retry))?Date.now()+Number(retry)*1000:0);
          throw new ApiError('连接受到限制或权限不足，已暂停自动请求。请稍后重试，或检查访问权限。',response.status,retryAt);
        }
        if(response.status===401) throw new ApiError('访问授权已失效。请在「我们的空间」更新令牌，本机记录仍然保留。',401);
        if(response.status===409 || response.status===422) throw new ApiError('云端内容刚有变化，正在合并。',response.status);
        if(response.status===404) throw new ApiError('找不到空间，请检查访问令牌的授权。',404);
        throw new ApiError(`连接暂时失败（${response.status}），本机记录仍然保留。`,response.status);
      }
      const text=await response.text();
      if(text.length > MAX_BYTES*2+200000) throw new ApiError(`${step.name}返回的文件超过容量限制。`,response.status,0,`${step.code}-SIZE`);
      if(raw)return text;
      try {return JSON.parse(text);}
      catch {throw new ApiError(`${step.name}时收到的内容格式异常，请稍后重试。`,response.status,0,`${step.code}-FORMAT`);}
    } catch(error) {
      if(error instanceof ApiError) throw error;
      const kind=controller.signal.aborted?'TIMEOUT':received?'BODY':'NET';
      const reason=controller.signal.aborted?'连接超时':received?'响应读取中断':'未能连上';
      throw new ApiError(`${step.name}时${reason}，请稍后重试。已保存的本机记录仍保留。`,0,0,`${step.code}-${kind}`);
    } finally {clearTimeout(timer);}
  }
  async verifyPrivate() {
    const repo=await this.request('GET','');
    if(repo?.private!==true || repo.full_name?.toLowerCase()!==REPOSITORY) throw new Error('云端仓库不是预期的私有空间，已停止同步。');
    this.branch=repo.default_branch||'main';
    this.repositoryBytes=Number.isFinite(repo.size)?repo.size*1024:null;
  }
  async read() {
    const ref=await this.request('GET',`/git/ref/heads/${encodeURIComponent(this.branch||'main')}?t=${Date.now()}`);
    if(!/^[a-f0-9]{40,64}$/i.test(ref?.object?.sha||''))throw new Error('未能确认云端版本，已停止同步。');
    this.head=ref.object.sha;
    const file=await this.readFile(DATA_PATH,this.head,{missing:true});
    return file?{...file,head:this.head}:null;
  }
  async readFile(path,head,{missing=false}={}) {
    if(!/^[a-f0-9]{40,64}$/i.test(head||''))throw new Error('云端版本不正确。');
    const file=await this.request('GET',`/contents/${path}?ref=${head}`,undefined,{missing});
    if(!file) return null;
    if(file.type!=='file' || file.path!==path || !/^[a-f0-9]{40,64}$/i.test(file.sha || '') || file.size>MAX_BYTES*1.4+1000) throw new Error('云端文件格式或大小异常。');
    let text;
    if(file.encoding==='base64') text=new TextDecoder('utf-8',{fatal:true}).decode(unbase64(file.content));
    else if(file.encoding==='none') text=await this.request('GET',`/git/blobs/${file.sha}`,undefined,{raw:true});
    else throw new Error('云端文件编码不正确。');
    try {return {sha:file.sha,envelope:JSON.parse(text)};}
    catch {throw new ApiError('空间文件格式异常，未修改现有记录。',200,0,'C2-FORMAT');}
  }
  async write(envelope,sha) {
    const content=base64(new TextEncoder().encode(JSON.stringify(envelope)));
    const written=await this.request('PUT',`/contents/${DATA_PATH}`,{message:'Save encrypted journal',content,...(sha?{sha}:{})});
    if(!/^[a-f0-9]{40,64}$/i.test(written?.content?.sha || '')) throw new Error('未收到保存确认，稍后会重新核对云端内容。');
    return written.content.sha;
  }
  async writeFiles(changes,remote) {
    const head=remote?.head||this.head;
    if(!/^[a-f0-9]{40,64}$/i.test(head||'') || !changes.length)throw new Error('保存版本不正确。');
    if(!changes.some(item=>item.path===DATA_PATH) || changes.some(item=>!/^journal\/(space-v1\.json|v2\/(settings\.json|(entry|event)\/[a-zA-Z0-9-]{1,2}\/[a-zA-Z0-9-]{1,64}\.json|months\/(settings|undated|\d{4}-\d{2})\.json)|migrations\/v1-[a-f0-9]{40,64}\.json)$/.test(item.path)))throw new Error('保存文件范围不正确。');
    const parent=await this.request('GET',`/git/commits/${head}`);
    if(!/^[a-f0-9]{40,64}$/i.test(parent?.tree?.sha||''))throw new Error('未能确认保存位置。');
    const tree=await this.request('POST','/git/trees',{base_tree:parent.tree.sha,tree:changes.map(({path,envelope})=>({path,mode:'100644',type:'blob',...(envelope===null?{sha:null}:{content:JSON.stringify(envelope)})}))});
    if(!/^[a-f0-9]{40,64}$/i.test(tree?.sha||''))throw new Error('未能确认记录文件。');
    const commit=await this.request('POST','/git/commits',{message:'Save encrypted journal',tree:tree.sha,parents:[head]});
    if(!/^[a-f0-9]{40,64}$/i.test(commit?.sha||''))throw new Error('未能确认保存版本。');
    const updated=await this.request('PATCH',`/git/refs/heads/${encodeURIComponent(this.branch||'main')}`,{sha:commit.sha,force:false});
    if(updated?.object?.sha!==commit.sha)throw new Error('未收到保存确认，稍后会重新核对。');
    return commit.sha;
  }
}
