export const marker = 'little-days-connect-v1';
export const repository = 'shoot5313/rakkat';

export function probes(base) {
  const stamp = String(Date.now());
  return [
    {id:'static',label:'网页文件',kind:'sample',url:new URL(`./sample.json?check=${stamp}`,base).href},
    {id:'api',label:'数据接口',kind:'api',url:`https://api.github.com/?check=${stamp}`},
    {id:'contents',label:'读取测试数据',kind:'contents',url:`https://api.github.com/repos/${repository}/contents/sample.json?check=${stamp}`,headers:{'X-GitHub-Api-Version':'2022-11-28'}},
  ];
}

function validSample(value) {
  return value?.schema === marker && value.privateData === false && value.message === 'hello-little-days';
}

export async function check(probe,{fetchFn=globalThis.fetch,timeoutMs=10000,now=()=>performance.now()}={}) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  const started = now();
  try {
    const response = await fetchFn(probe.url,{method:'GET',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:probe.headers || {}});
    if(!response.ok) {
      if(response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after')))) {
        const reset=Number(response.headers.get('x-ratelimit-reset'));
        const suffix=reset>0 && Number.isFinite(reset)?`，额度预计在 ${new Date(reset*1000).toLocaleTimeString()} 恢复`:'';
        return {ok:false,reason:'limited',detail:`接口已连接，匿名请求触发限流${suffix}`};
      }
      return {ok:false,reason:'http',detail:`服务返回 HTTP ${response.status}`};
    }
    const value = await response.json();
    let valid = false;
    if(probe.kind === 'sample') valid = validSample(value);
    if(probe.kind === 'api') valid = value?.current_user_url === 'https://api.github.com/user' && typeof value.repository_url === 'string';
    if(probe.kind === 'contents' && value?.type === 'file' && value.encoding === 'base64' && value.path === 'sample.json') {
      valid = validSample(JSON.parse(atob(value.content.replace(/\s/g,''))));
    }
    if(!valid) return {ok:false,reason:'invalid',detail:'已收到响应，但不是预期的测试数据'};
    return {ok:true,reason:'ok',detail:`通过 · ${Math.round(now()-started)} 毫秒`};
  } catch(error) {
    if(controller.signal.aborted) return {ok:false,reason:'timeout',detail:'10 秒内未完成，请求超时'};
    if(error instanceof SyntaxError || error?.name === 'InvalidCharacterError') return {ok:false,reason:'invalid',detail:'已收到响应，但无法识别测试数据'};
    return {ok:false,reason:'network',detail:'连接失败，尚不能区分网络限制与浏览器跨域错误'};
  } finally { clearTimeout(timer); }
}

export function conclusion(results) {
  if(results.length === 3 && results.every(result=>result.ok)) return '三项通过：当前网络可以加载网页并读取公开测试数据。还没有验证登录、私有数据写入或双人同步。';
  if(results[0]?.ok && results.slice(1).length===2 && results.slice(1).every(result=>result.ok || result.reason==='limited')) return '网页和 GitHub 接口均已建立连接，但匿名额度不足，公开读取没有全部完成。这不等于被 GFW 拦截；下一步可进行受限权限的私有读写检查。';
  if(results[0]?.ok && results.slice(1).some(result=>!result.ok)) return '网页可以加载，但数据读取未全部通过。当前还不能用作日记同步方案。';
  return '检查未全部通过。请保留结果，切换另一种网络后再测试一次。';
}
